import type { AudioPlatform } from "@tessera/platform";
import type { Clip, Command, Project, Track } from "@tessera/schema";

/**
 * Keeps the engine mirroring the project. The UI owns the project; every change is diffed
 * against the last synced state and turned into engine commands. Positions are converted
 * from project frames to engine frames here, and only here.
 */
export class EngineSync {
  private synced: Project | undefined;
  /** Project source id → engine source id (assigned by `AudioPlatform.importAudio`). */
  private readonly engineSources = new Map<number, number>();
  private engineRate: number;

  constructor(
    private readonly platform: Pick<AudioPlatform, "send">,
    engineRate: number,
  ) {
    this.engineRate = engineRate;
  }

  /** Project frames → engine frames. */
  toEngine = (frames: number, project: Project) =>
    Math.round((frames * this.engineRate) / project.sampleRate);
  /** Engine frames → project frames. */
  toProject = (frames: number, project: Project) =>
    Math.round((frames * project.sampleRate) / this.engineRate);

  setEngineRate(rate: number) {
    if (rate === this.engineRate) return;
    this.engineRate = rate;
    // Every position changes; resend everything.
    const project = this.synced;
    this.synced = undefined;
    if (project) this.sync(project);
  }

  /** Records that a project source's audio is in the engine, and plays its clips. */
  registerSource(projectSourceId: number, engineSourceId: number) {
    this.engineSources.set(projectSourceId, engineSourceId);
    const project = this.synced;
    if (!project) return;
    for (const track of project.tracks) {
      for (const clip of track.clips) {
        if (clip.sourceId === projectSourceId) this.send(this.clipCommand(project, track, clip));
      }
    }
  }

  hasSource(projectSourceId: number) {
    return this.engineSources.has(projectSourceId);
  }

  sync(next: Project) {
    for (const command of diffProject(this.synced, next, this)) this.send(command);
    this.synced = next;
  }

  /**
   * Empties the engine before another project is loaded: removes every track (and with it
   * every clip) and releases all audio. Audio is otherwise kept for the whole session, so
   * undoing and redoing an import never needs to decode the file again.
   */
  reset() {
    for (const track of this.synced?.tracks ?? []) this.send({ type: "RemoveTrack", track: track.id });
    for (const engineId of this.engineSources.values()) this.send({ type: "RemoveSource", source: engineId });
    this.engineSources.clear();
    this.synced = undefined;
  }

  clipCommand(project: Project, track: Track, clip: Clip): Command {
    return {
      type: "SetClip",
      clip: clip.id,
      track: track.id,
      source: this.engineSources.get(clip.sourceId) ?? 0,
      start: this.toEngine(clip.start, project),
      offset: this.toEngine(clip.offset, project),
      length: this.toEngine(clip.length, project),
      gain: clip.gain,
      fadeIn: this.toEngine(clip.fadeIn, project),
      fadeOut: this.toEngine(clip.fadeOut, project),
    };
  }

  engineSource(projectSourceId: number) {
    return this.engineSources.get(projectSourceId);
  }

  private send(command: Command) {
    this.platform.send(command);
  }
}

/** Engine commands that turn `prev` (or an empty engine) into `next`. */
export function diffProject(prev: Project | undefined, next: Project, sync: EngineSync): Command[] {
  const out: Command[] = [];
  if (prev === next) return out;

  if (!prev || prev.tempo !== next.tempo) out.push({ type: "SetTempo", bpm: next.tempo });
  if (!prev || prev.metronome !== next.metronome || prev.timeSignature !== next.timeSignature) {
    out.push({
      type: "SetMetronome",
      enabled: next.metronome,
      gain: 0.5,
      beatsPerBar: next.timeSignature.numerator,
    });
  }
  if (!prev || prev.masterGain !== next.masterGain)
    out.push({ type: "SetMasterGain", gain: next.masterGain });
  if (!prev || prev.loop !== next.loop || prev.sampleRate !== next.sampleRate) {
    out.push({
      type: "SetLoop",
      enabled: next.loop.enabled,
      start: sync.toEngine(next.loop.start, next),
      end: sync.toEngine(next.loop.end, next),
    });
  }

  const prevTracks = new Map((prev?.tracks ?? []).map((t) => [t.id, t]));
  const nextTracks = new Map(next.tracks.map((t) => [t.id, t]));
  const prevClips = clipIndex(prev);
  const nextClips = clipIndex(next);

  // Removals first, so ids can be reused safely.
  for (const [id] of prevClips) if (!nextClips.has(id)) out.push({ type: "RemoveClip", clip: id });
  for (const [id] of prevTracks) if (!nextTracks.has(id)) out.push({ type: "RemoveTrack", track: id });

  for (const track of next.tracks) {
    const old = prevTracks.get(track.id);
    if (!old) out.push({ type: "AddTrack", track: track.id });
    if (!old || old.gain !== track.gain)
      out.push({ type: "SetTrackGain", track: track.id, gain: track.gain });
    if (!old || old.pan !== track.pan) out.push({ type: "SetTrackPan", track: track.id, pan: track.pan });
    if (!old || old.mute !== track.mute)
      out.push({ type: "SetTrackMute", track: track.id, mute: track.mute });
    if (!old || old.solo !== track.solo)
      out.push({ type: "SetTrackSolo", track: track.id, solo: track.solo });
  }

  for (const [id, { track, clip }] of nextClips) {
    const old = prevClips.get(id);
    // Immer keeps unchanged objects identical, so reference checks are exact.
    if (old?.clip === clip && old.track.id === track.id && prev?.sampleRate === next.sampleRate) continue;
    if (!sync.hasSource(clip.sourceId)) continue; // Sent by registerSource once the audio is in.
    out.push(sync.clipCommand(next, track, clip));
  }
  return out;
}

function clipIndex(project: Project | undefined) {
  const map = new Map<number, { track: Track; clip: Clip }>();
  for (const track of project?.tracks ?? [])
    for (const clip of track.clips) map.set(clip.id, { track, clip });
  return map;
}
