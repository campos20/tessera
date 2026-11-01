import type { AudioPlatform, TunePlan } from "@tessera/platform";
import type { Clip, Command, Project, Track } from "@tessera/schema";

/** Crossfade where a tuned clip's segments meet (must match `tune::CROSSFADE`). */
const TUNE_CROSSFADE_SECONDS = 0.01;

/** Engine clip id of segment `index` of a tuned clip (project clip ids stay below 2^21). */
const segmentClipId = (clipId: number, index: number) => 2 ** 31 + clipId * 1024 + index;

/**
 * Keeps the engine mirroring the project. The UI owns the project; every change is diffed
 * against the last synced state and turned into engine commands. Positions are converted
 * from project frames to engine frames here, and only here.
 */
export class EngineSync {
  private synced: Project | undefined;
  /** Project source id → engine source id (assigned by `AudioPlatform.importAudio`). */
  private readonly engineSources = new Map<number, number>();
  /** Playback plans of tuned clips (engine frames at the current engine rate). */
  private readonly tunePlans = new Map<number, TunePlan>();
  /** Engine clip ids currently sent for each project clip (one, or one per tuned segment). */
  private readonly sentClips = new Map<number, number[]>();
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

  get rate(): number {
    return this.engineRate;
  }

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
        if (clip.sourceId === projectSourceId)
          for (const c of this.updateClip(project, track, clip)) this.send(c);
      }
    }
  }

  /**
   * Plays a tuned clip from `plan` (original segments plus rendered regions), or as plain
   * source audio again when `plan` is undefined (A/B bypass, Tune removed).
   */
  setTunePlan(clipId: number, plan: TunePlan | undefined) {
    if (plan) this.tunePlans.set(clipId, plan);
    else this.tunePlans.delete(clipId);
    const project = this.synced;
    const found = project && findClip(project, clipId);
    if (found) for (const c of this.updateClip(project, found.track, found.clip)) this.send(c);
  }

  /** Drops every tune plan (e.g. the engine restarted at another rate). */
  clearTunePlans() {
    this.tunePlans.clear();
  }

  hasSource(projectSourceId: number) {
    return this.engineSources.has(projectSourceId);
  }

  sync(next: Project) {
    for (const command of diffProject(this.synced, next, this)) this.send(command);
    this.synced = next;
  }

  /** Sends the whole project again (after something else changed engine state directly). */
  resend(project: Project) {
    this.synced = undefined;
    this.sync(project);
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
    this.tunePlans.clear();
    this.sentClips.clear();
    this.synced = undefined;
  }

  /** Commands that (re)place a clip in the engine, removing segments it no longer has. */
  updateClip(project: Project, track: Track, clip: Clip): Command[] {
    const commands = this.clipCommands(project, track, clip);
    const ids = commands.map((c) => (c as Extract<Command, { type: "SetClip" }>).clip);
    const stale = (this.sentClips.get(clip.id) ?? []).filter((id) => !ids.includes(id));
    this.sentClips.set(clip.id, ids);
    return [...stale.map((id): Command => ({ type: "RemoveClip", clip: id })), ...commands];
  }

  /** Commands that remove a clip (all its segments) from the engine. */
  removeClip(clipId: number): Command[] {
    const ids = this.sentClips.get(clipId) ?? [clipId];
    this.sentClips.delete(clipId);
    return ids.map((id) => ({ type: "RemoveClip", clip: id }));
  }

  /**
   * Engine clips for a project clip: one playing its source, or, when tuned, one per planned
   * segment: original segments play the source, rendered ones their region. Neighbouring
   * segments overlap by a crossfade, and everything is cut to the clip's window.
   */
  clipCommands(project: Project, track: Track, clip: Clip): Command[] {
    const source = this.engineSources.get(clip.sourceId) ?? 0;
    const plan = clip.tune ? this.tunePlans.get(clip.id) : undefined;
    const base = {
      type: "SetClip" as const,
      track: track.id,
      gain: clip.gain,
    };
    if (!plan) {
      return [
        {
          ...base,
          clip: clip.id,
          source,
          start: this.toEngine(clip.start, project),
          offset: this.toEngine(clip.offset, project),
          length: this.toEngine(clip.length, project),
          fadeIn: this.toEngine(clip.fadeIn, project),
          fadeOut: this.toEngine(clip.fadeOut, project),
        },
      ];
    }
    const windowStart = this.toEngine(clip.offset, project);
    const windowEnd = this.toEngine(clip.offset + clip.length, project);
    const timeline = this.toEngine(clip.start, project);
    const half = Math.round((TUNE_CROSSFADE_SECONDS * this.engineRate) / 2);
    const last = plan.segments.length - 1;
    const out: Command[] = [];
    plan.segments.forEach((seg, i) => {
      // The span this segment plays, including its half of each crossfade.
      const [from, to] =
        seg.kind === "original"
          ? [i > 0 ? seg.start - half : seg.start, i < last ? seg.end + half : seg.end]
          : [seg.renderStart, seg.renderEnd];
      const a = Math.max(from, windowStart);
      const b = Math.min(to, windowEnd);
      if (b <= a) return;
      // Crossfades into neighbours; the clip's own fades at the window edges.
      const fadeIn =
        a === windowStart ? this.toEngine(clip.fadeIn, project) : a === from && i > 0 ? 2 * half : 0;
      const fadeOut =
        b === windowEnd ? this.toEngine(clip.fadeOut, project) : b === to && i < last ? 2 * half : 0;
      out.push({
        ...base,
        clip: segmentClipId(clip.id, i),
        source: seg.kind === "original" ? source : (plan.sources[seg.key] ?? 0),
        start: timeline + (a - windowStart),
        offset: seg.kind === "original" ? a : a - seg.renderStart,
        length: b - a,
        fadeIn,
        fadeOut,
      });
    });
    return out;
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
  for (const [id] of prevClips) if (!nextClips.has(id)) out.push(...sync.removeClip(id));
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
    if (!old || old.inputChannel !== track.inputChannel || old.inputStereo !== track.inputStereo) {
      out.push({
        type: "SetTrackInput",
        track: track.id,
        channel: track.inputChannel,
        stereo: track.inputStereo,
      });
    }
  }

  for (const [id, { track, clip }] of nextClips) {
    const old = prevClips.get(id);
    // Immer keeps unchanged objects identical, so reference checks are exact.
    if (old?.clip === clip && old.track.id === track.id && prev?.sampleRate === next.sampleRate) continue;
    if (!sync.hasSource(clip.sourceId)) continue; // Sent by registerSource once the audio is in.
    out.push(...sync.updateClip(next, track, clip));
  }
  return out;
}

function findClip(project: Project, clipId: number) {
  for (const track of project.tracks) {
    const clip = track.clips.find((c) => c.id === clipId);
    if (clip) return { track, clip };
  }
  return undefined;
}

function clipIndex(project: Project | undefined) {
  const map = new Map<number, { track: Track; clip: Clip }>();
  for (const track of project?.tracks ?? [])
    for (const clip of track.clips) map.set(clip.id, { track, clip });
  return map;
}
