import type { AudioPlatform, AutomationTarget, TunePlan } from "@tessera/platform";
import {
  type Clip,
  type Command,
  DEVICES,
  type Device,
  type DeviceKind,
  type Lane,
  MASTER_TRACK,
  MAX_SENDS,
  type Project,
  type Track,
} from "@tessera/schema";

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

  /** What was last sent for each automation lane (to resend only what changed). */
  private readonly sentLanes = new Map<number, { key: unknown[]; track: number }>();

  constructor(
    private readonly platform: Pick<AudioPlatform, "send" | "setAutomation">,
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
    this.syncLanes(next);
    this.synced = next;
  }

  /** Sends the whole project again (after something else changed engine state directly). */
  resend(project: Project) {
    this.synced = undefined;
    this.sentLanes.clear();
    this.sync(project);
  }

  /**
   * Sends automation lanes that changed (points, target, or how the target maps to the
   * engine), and removes lanes that are gone. Lanes whose target can't be resolved (unknown
   * device kind) are removed from the engine.
   */
  private syncLanes(project: Project) {
    const seen = new Set<number>();
    for (const track of project.tracks) {
      for (const lane of track.automation) {
        seen.add(lane.id);
        const target = engineTarget(track, lane);
        const key = [lane, target?.kind, target?.index, target?.device, this.engineRate, project.sampleRate];
        const sent = this.sentLanes.get(lane.id);
        if (sent && sent.track === track.id && sent.key.every((k, i) => k === key[i])) continue;
        this.sentLanes.set(lane.id, { key, track: track.id });
        if (!target || lane.points.length === 0) {
          if (sent) this.send({ type: "RemoveAutomation", lane: lane.id });
          continue;
        }
        const points = lane.points.map((pt): [number, number] => [
          this.toEngine(pt.frame, project),
          pt.value,
        ]);
        this.platform.setAutomation(lane.id, track.id, target, points);
      }
    }
    for (const id of [...this.sentLanes.keys()]) {
      if (seen.has(id)) continue;
      this.sentLanes.delete(id);
      this.send({ type: "RemoveAutomation", lane: id });
    }
  }

  /**
   * Empties the engine before another project is loaded: removes every track (and with it
   * every clip) and releases all audio. Audio is otherwise kept for the whole session, so
   * undoing and redoing an import never needs to decode the file again.
   */
  reset() {
    for (const track of this.synced?.tracks ?? []) this.send({ type: "RemoveTrack", track: track.id });
    for (const device of this.synced?.masterInserts ?? [])
      this.send({ type: "RemoveDevice", device: device.id });
    for (const lane of this.sentLanes.keys()) this.send({ type: "RemoveAutomation", lane });
    this.sentLanes.clear();
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

  // Routing (after every track exists, so outputs and sends resolve).
  for (const track of next.tracks) {
    const old = prevTracks.get(track.id);
    if (old ? old.output !== track.output : track.output !== null)
      out.push({ type: "SetTrackOutput", track: track.id, output: track.output ?? MASTER_TRACK });
    if (old?.sends !== track.sends) {
      const count = Math.max(track.sends.length, old?.sends.length ?? 0);
      for (let index = 0; index < Math.min(count, MAX_SENDS); index++) {
        const send = track.sends[index];
        if (send && old?.sends[index] === send) continue;
        out.push({
          type: "SetSend",
          track: track.id,
          index,
          enabled: send !== undefined,
          target: send?.target ?? 0,
          gain: send?.gain ?? 0,
          pre: send?.pre ?? false,
        });
      }
    }
  }
  diffDevices(prev, next, out);

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

const deviceInfo = (kind: string) => DEVICES[kind as DeviceKind] as (typeof DEVICES)[DeviceKind] | undefined;

/**
 * Commands that turn the previous insert chains (tracks and master) into the next ones.
 * Devices of unknown kinds (from a newer version) are never in the engine: they are left out
 * of both sides, so a device whose kind becomes unknown is removed, and positions count only
 * the devices the engine has.
 */
function diffDevices(prev: Project | undefined, next: Project, out: Command[]) {
  const chains = (p: Project | undefined): [number, Device[], Device[]][] =>
    p
      ? [[MASTER_TRACK, p.masterInserts] as const, ...p.tracks.map((t) => [t.id, t.inserts] as const)].map(
          ([owner, chain]) => [owner, chain, chain.filter((d) => deviceInfo(d.kind))],
        )
      : [];
  const before = new Map<number, { owner: number; index: number; device: Device }>();
  const prevChains = new Map(chains(prev).map(([owner, chain]) => [owner, chain]));
  for (const [owner, , known] of chains(prev))
    known.forEach((device, index) => before.set(device.id, { owner, index, device }));
  const nextChains = chains(next);
  const after = new Set(nextChains.flatMap(([, , known]) => known.map((d) => d.id)));
  for (const id of before.keys()) if (!after.has(id)) out.push({ type: "RemoveDevice", device: id });

  for (const [owner, chain, known] of nextChains) {
    if (prevChains.get(owner) === chain) continue;
    // Place each device at its index in turn; earlier positions are then already right.
    let reordered = false;
    known.forEach((device, index) => {
      const info = deviceInfo(device.kind)!;
      const old = before.get(device.id);
      const fresh = !old || old.device.kind !== device.kind;
      if (fresh) {
        out.push({ type: "AddDevice", device: device.id, track: owner, position: index, kind: info.code });
        reordered = true;
      } else if (reordered || old.owner !== owner || old.index !== index) {
        out.push({ type: "MoveDevice", device: device.id, track: owner, position: index });
        reordered = true;
      }
      if (!fresh && old.device === device) return;
      if (fresh ? device.bypass : old.device.bypass !== device.bypass)
        out.push({ type: "SetDeviceBypass", device: device.id, bypass: device.bypass });
      info.params.forEach((param, i) => {
        const value = device.params[param.id] ?? param.default;
        const was = fresh ? param.default : (old.device.params[param.id] ?? param.default);
        if (value !== was) out.push({ type: "SetDeviceParam", device: device.id, param: i, value });
      });
    });
  }
}

/** How the engine addresses a lane's target, or undefined if it can't be resolved. */
function engineTarget(track: Track, lane: Lane): AutomationTarget | undefined {
  const t = lane.target;
  switch (t.kind) {
    case "volume":
      return { kind: 0, index: 0, device: 0 };
    case "pan":
      return { kind: 1, index: 0, device: 0 };
    case "send": {
      const index = track.sends.findIndex((s) => s.id === t.send);
      return index >= 0 && index < MAX_SENDS ? { kind: 2, index, device: 0 } : undefined;
    }
    case "param": {
      const device = track.inserts.find((d) => d.id === t.device);
      const info = device && deviceInfo(device.kind);
      const index = info?.params.findIndex((p) => p.id === t.param) ?? -1;
      return index >= 0 ? { kind: 3, index, device: t.device } : undefined;
    }
  }
}
