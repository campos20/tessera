import {
  type Clip,
  DEVICES,
  type Device,
  type DeviceKind,
  type Lane,
  type LaneTarget,
  MAX_SENDS,
  type Project,
  PROJECT_SAMPLE_RATE,
  SCHEMA_VERSION,
  type Source,
  type Track,
} from "@tessera/schema";
import { trackColor } from "./colors";

/**
 * Project edit operations. Each mutates the project passed in, so they are used inside immer
 * recipes (`store.edit`), which turns every edit into undoable patches.
 */

/** Shortest clip any edit may leave (~5 ms). */
export const MIN_CLIP_FRAMES = 240;

export function newProject(id: string, name: string, now: string): Project {
  return {
    schemaVersion: SCHEMA_VERSION,
    id,
    name,
    sampleRate: PROJECT_SAMPLE_RATE,
    tempo: 120,
    timeSignature: { numerator: 4, denominator: 4 },
    masterGain: 1,
    metronome: false,
    loop: { enabled: false, start: 0, end: 4 * 96_000 },
    tracks: [],
    masterInserts: [],
    sources: [],
    nextId: 1,
    createdAt: now,
    modifiedAt: now,
  };
}

function takeId(p: Project): number {
  return p.nextId++;
}

export function findTrack(p: Project, id: number): Track | undefined {
  return p.tracks.find((t) => t.id === id);
}

export function findClip(p: Project, id: number): { track: Track; clip: Clip; index: number } | undefined {
  for (const track of p.tracks) {
    const index = track.clips.findIndex((c) => c.id === id);
    if (index >= 0) return { track, clip: track.clips[index]!, index };
  }
  return undefined;
}

export function findSource(p: Project, id: number): Source | undefined {
  return p.sources.find((s) => s.id === id);
}

// Tracks ---------------------------------------------------------------------------------------

export function addTrack(
  p: Project,
  name?: string,
  index = p.tracks.length,
  kind: Track["kind"] = "audio",
): number {
  const id = takeId(p);
  p.tracks.splice(index, 0, {
    id,
    name:
      name ??
      (kind === "bus"
        ? `Bus ${p.tracks.filter((t) => t.kind === "bus").length + 1}`
        : `Track ${p.tracks.length + 1}`),
    color: trackColor(p.tracks.length),
    gain: 1,
    pan: 0,
    mute: false,
    solo: false,
    inputChannel: 0,
    inputStereo: false,
    kind,
    output: null,
    sends: [],
    inserts: [],
    automation: [],
    clips: [],
  });
  return id;
}

/** Removes a track, and every output and send that pointed at it. */
export function removeTrack(p: Project, id: number) {
  p.tracks = p.tracks.filter((t) => t.id !== id);
  for (const t of p.tracks) {
    if (t.output === id) t.output = null;
    const gone = t.sends.filter((s) => s.target === id).map((s) => s.id);
    if (gone.length) removeSends(t, gone);
  }
}

export function updateTrack(p: Project, id: number, patch: Partial<Omit<Track, "id" | "clips">>) {
  const track = findTrack(p, id);
  if (track) Object.assign(track, patch);
}

export function moveTrack(p: Project, id: number, toIndex: number) {
  const from = p.tracks.findIndex((t) => t.id === id);
  if (from < 0) return;
  const [track] = p.tracks.splice(from, 1);
  p.tracks.splice(Math.max(0, Math.min(p.tracks.length, toIndex)), 0, track!);
}

// Sources and clips ----------------------------------------------------------------------------

export function addSource(p: Project, source: Omit<Source, "id">): number {
  const id = takeId(p);
  p.sources.push({ id, ...source });
  return id;
}

/** Places the whole source as a new clip on `trackId` at `start`. Returns the clip id. */
export function addClip(p: Project, trackId: number, sourceId: number, start: number): number | undefined {
  const track = findTrack(p, trackId);
  const source = findSource(p, sourceId);
  if (!track || !source || track.kind === "bus") return undefined;
  const id = takeId(p);
  track.clips.push({
    id,
    sourceId,
    name: source.name.replace(/\.[^.]+$/, ""),
    start: Math.max(0, Math.round(start)),
    offset: 0,
    length: source.frames,
    gain: 1,
    fadeIn: 0,
    fadeOut: 0,
    tune: null,
  });
  sortClips(track);
  return id;
}

export function deleteClips(p: Project, ids: Iterable<number>) {
  const remove = new Set(ids);
  for (const track of p.tracks) track.clips = track.clips.filter((c) => !remove.has(c.id));
}

/**
 * Moves clips by `deltaFrames` and `trackDelta` track rows. The whole selection moves
 * together: the time delta is limited so no clip starts before 0, and the row delta so none
 * leaves the track list.
 */
export function moveClips(p: Project, ids: Iterable<number>, deltaFrames: number, trackDelta = 0) {
  const found = [...ids].map((id) => findClip(p, id)).filter((f) => f !== undefined);
  if (found.length === 0) return;
  const earliest = Math.min(...found.map((f) => f.clip.start));
  const delta = Math.max(-earliest, Math.round(deltaFrames));
  const rows = found.map((f) => p.tracks.indexOf(f.track));
  const rowDelta = Math.max(
    -Math.min(...rows),
    Math.min(p.tracks.length - 1 - Math.max(...rows), trackDelta),
  );

  // Buses hold no clips: a move that would land any clip on one keeps every clip on its track.
  const landsOnBus = found.some((_, i) => p.tracks[rows[i]! + rowDelta]!.kind === "bus");
  for (const [i, { track, clip }] of found.entries()) {
    clip.start += delta;
    if (rowDelta !== 0 && !landsOnBus) {
      const target = p.tracks[rows[i]! + rowDelta]!;
      track.clips = track.clips.filter((c) => c.id !== clip.id);
      target.clips.push(clip);
    }
  }
  for (const track of p.tracks) sortClips(track);
}

/** Moves a clip's left edge to `frame`, revealing or hiding source audio. */
export function trimClipStart(p: Project, id: number, frame: number) {
  const f = findClip(p, id);
  if (!f) return;
  const { clip } = f;
  const end = clip.start + clip.length;
  // Can't reveal audio before the source start, or shrink below the minimum length.
  const newStart = Math.min(end - MIN_CLIP_FRAMES, Math.max(clip.start - clip.offset, Math.round(frame), 0));
  const delta = newStart - clip.start;
  clip.start = newStart;
  clip.offset += delta;
  clip.length -= delta;
  clampFades(clip);
  sortClips(f.track);
}

/** Moves a clip's right edge to `frame`, up to the end of its source. */
export function trimClipEnd(p: Project, id: number, frame: number) {
  const f = findClip(p, id);
  if (!f) return;
  const { clip } = f;
  const sourceFrames = findSource(p, clip.sourceId)?.frames ?? clip.offset + clip.length;
  const maxLength = sourceFrames - clip.offset;
  clip.length = Math.max(MIN_CLIP_FRAMES, Math.min(maxLength, Math.round(frame) - clip.start));
  clampFades(clip);
}

/**
 * Splits every listed clip that spans `frame` into two. The left part keeps the fade-in, the
 * right part keeps the fade-out. Returns the ids of the new right-hand clips.
 */
export function splitClips(p: Project, ids: Iterable<number>, frame: number): number[] {
  const at = Math.round(frame);
  const created: number[] = [];
  for (const id of ids) {
    const f = findClip(p, id);
    if (!f) continue;
    const { clip, track } = f;
    const left = at - clip.start;
    const right = clip.start + clip.length - at;
    if (left < MIN_CLIP_FRAMES || right < MIN_CLIP_FRAMES) continue;
    const newId = takeId(p);
    track.clips.push({
      ...clip,
      id: newId,
      start: at,
      offset: clip.offset + left,
      length: right,
      fadeIn: 0,
      fadeOut: Math.min(clip.fadeOut, right),
    });
    clip.length = left;
    clip.fadeOut = 0;
    clip.fadeIn = Math.min(clip.fadeIn, left);
    sortClips(track);
    created.push(newId);
  }
  return created;
}

/**
 * Copies the listed clips to directly after the selection (same tracks, same relative
 * spacing). Returns the new clip ids.
 */
export function duplicateClips(p: Project, ids: Iterable<number>): number[] {
  const found = [...ids].map((id) => findClip(p, id)).filter((f) => f !== undefined);
  if (found.length === 0) return [];
  const spanStart = Math.min(...found.map((f) => f.clip.start));
  const spanEnd = Math.max(...found.map((f) => f.clip.start + f.clip.length));
  const shift = spanEnd - spanStart;
  return found.map(({ track, clip }) => {
    const id = takeId(p);
    track.clips.push({ ...clip, id, start: clip.start + shift });
    sortClips(track);
    return id;
  });
}

export function setFade(p: Project, id: number, which: "in" | "out", frames: number) {
  const f = findClip(p, id);
  if (!f) return;
  const value = Math.max(0, Math.round(frames));
  if (which === "in") f.clip.fadeIn = Math.min(value, f.clip.length - f.clip.fadeOut);
  else f.clip.fadeOut = Math.min(value, f.clip.length - f.clip.fadeIn);
}

export function setClipGain(p: Project, ids: Iterable<number>, gain: number) {
  for (const id of ids) {
    const f = findClip(p, id);
    if (f) f.clip.gain = Math.max(0, Math.min(4, gain));
  }
}

/** Last frame covered by any clip (the song length). */
export function projectEnd(p: Project): number {
  let end = 0;
  for (const t of p.tracks) for (const c of t.clips) end = Math.max(end, c.start + c.length);
  return end;
}

function clampFades(clip: Clip) {
  clip.fadeIn = Math.min(clip.fadeIn, clip.length);
  clip.fadeOut = Math.min(clip.fadeOut, clip.length - clip.fadeIn);
}

function sortClips(track: Track) {
  track.clips.sort((a, b) => a.start - b.start || a.id - b.id);
}

// Mixer ----------------------------------------------------------------------------------------

/** Whether routing `from` into bus `to` would create a loop (through outputs or sends). */
export function wouldLoop(p: Project, from: number, to: number): boolean {
  const seen = new Set<number>();
  const visit = (id: number): boolean => {
    if (id === from) return true;
    if (seen.has(id)) return false;
    seen.add(id);
    const t = findTrack(p, id);
    if (!t) return false;
    return (t.output !== null && visit(t.output)) || t.sends.some((s) => visit(s.target));
  };
  return visit(to);
}

/** Buses `trackId` may feed without creating a loop. */
export function routableBuses(p: Project, trackId: number): Track[] {
  return p.tracks.filter((t) => t.kind === "bus" && t.id !== trackId && !wouldLoop(p, trackId, t.id));
}

export function setOutput(p: Project, trackId: number, output: number | null) {
  const track = findTrack(p, trackId);
  if (!track || (output !== null && wouldLoop(p, trackId, output))) return;
  track.output = output;
}

/** Adds a post-fader send to bus `target`; returns its id (undefined if not allowed). */
export function addSend(p: Project, trackId: number, target: number, gain = 0.5): number | undefined {
  const track = findTrack(p, trackId);
  if (!track || track.sends.length >= MAX_SENDS || wouldLoop(p, trackId, target)) return undefined;
  const id = takeId(p);
  track.sends.push({ id, target, gain, pre: false });
  return id;
}

function removeSends(track: Track, ids: number[]) {
  track.sends = track.sends.filter((s) => !ids.includes(s.id));
  track.automation = track.automation.filter(
    (l) => !(l.target.kind === "send" && ids.includes(l.target.send)),
  );
}

export function removeSend(p: Project, trackId: number, sendId: number) {
  const track = findTrack(p, trackId);
  if (track) removeSends(track, [sendId]);
}

/** The insert chain of a track, or of the master (`trackId` null). */
export function chainOf(p: Project, trackId: number | null): Device[] | undefined {
  return trackId === null ? p.masterInserts : findTrack(p, trackId)?.inserts;
}

export function addDevice(
  p: Project,
  trackId: number | null,
  kind: DeviceKind,
  index?: number,
): number | undefined {
  const chain = chainOf(p, trackId);
  if (!chain) return undefined;
  const id = takeId(p);
  chain.splice(index ?? chain.length, 0, { id, kind, bypass: false, params: {} });
  return id;
}

export function findDevice(
  p: Project,
  deviceId: number,
): { device: Device; chain: Device[]; track: Track | null } | undefined {
  const inMaster = p.masterInserts.find((d) => d.id === deviceId);
  if (inMaster) return { device: inMaster, chain: p.masterInserts, track: null };
  for (const track of p.tracks) {
    const device = track.inserts.find((d) => d.id === deviceId);
    if (device) return { device, chain: track.inserts, track };
  }
  return undefined;
}

/** Removes a device and the automation lanes of its parameters. */
export function removeDevice(p: Project, deviceId: number) {
  const found = findDevice(p, deviceId);
  if (!found) return;
  found.chain.splice(found.chain.indexOf(found.device), 1);
  if (found.track)
    found.track.automation = found.track.automation.filter(
      (l) => !(l.target.kind === "param" && l.target.device === deviceId),
    );
}

/** Moves a device within its chain (devices with automation stay on their track). */
export function moveDevice(p: Project, deviceId: number, toIndex: number) {
  const found = findDevice(p, deviceId);
  if (!found) return;
  const { chain, device } = found;
  chain.splice(chain.indexOf(device), 1);
  chain.splice(Math.max(0, Math.min(chain.length, toIndex)), 0, device);
}

/** Default of a device parameter (undefined for unknown kinds or ids). */
export function paramInfo(kind: string, param: string) {
  const info = DEVICES[kind as DeviceKind] as (typeof DEVICES)[DeviceKind] | undefined;
  return info?.params.find((x) => x.id === param);
}

export function paramValue(device: Device, param: string): number {
  return device.params[param] ?? paramInfo(device.kind, param)?.default ?? 0;
}

/** Sets a parameter (clamped); values equal to the default are dropped from the project. */
export function setParam(p: Project, deviceId: number, param: string, value: number) {
  const device = findDevice(p, deviceId)?.device;
  const info = device && paramInfo(device.kind, param);
  if (!device || !info) return;
  let v = Math.min(info.max, Math.max(info.min, value));
  if (info.scale === "choice" || info.scale === "toggle") v = Math.round(v);
  if (v === info.default) delete device.params[param];
  else device.params[param] = v;
}

// Automation -----------------------------------------------------------------------------------

export function sameTarget(a: LaneTarget, b: LaneTarget): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === "send" && b.kind === "send") return a.send === b.send;
  if (a.kind === "param" && b.kind === "param") return a.device === b.device && a.param === b.param;
  return true;
}

/** The lane for `target`, created (visible, empty) if the track has none. */
export function ensureLane(p: Project, trackId: number, target: LaneTarget): number | undefined {
  const track = findTrack(p, trackId);
  if (!track) return undefined;
  const existing = track.automation.find((l) => sameTarget(l.target, target));
  if (existing) {
    existing.visible = true;
    return existing.id;
  }
  const id = takeId(p);
  track.automation.push({ id, target, points: [], visible: true });
  return id;
}

export function findLane(p: Project, laneId: number): { lane: Lane; track: Track } | undefined {
  for (const track of p.tracks) {
    const lane = track.automation.find((l) => l.id === laneId);
    if (lane) return { lane, track };
  }
  return undefined;
}

/** Adds a point (replacing one at the same frame); returns its index after sorting. */
export function addPoint(p: Project, laneId: number, frame: number, value: number): number {
  const lane = findLane(p, laneId)?.lane;
  if (!lane) return -1;
  const f = Math.max(0, Math.round(frame));
  lane.points = lane.points.filter((pt) => pt.frame !== f);
  lane.points.push({ frame: f, value });
  lane.points.sort((a, b) => a.frame - b.frame);
  return lane.points.findIndex((pt) => pt.frame === f);
}

/** Moves point `index`, keeping it between its neighbours. */
export function movePoint(p: Project, laneId: number, index: number, frame: number, value: number) {
  const lane = findLane(p, laneId)?.lane;
  const pt = lane?.points[index];
  if (!lane || !pt) return;
  const lo = lane.points[index - 1]?.frame ?? 0;
  const hi = lane.points[index + 1]?.frame ?? Number.MAX_SAFE_INTEGER;
  pt.frame = Math.max(lo, Math.min(hi, Math.round(frame)));
  pt.value = value;
}

export function removePoint(p: Project, laneId: number, index: number) {
  const lane = findLane(p, laneId)?.lane;
  if (lane) lane.points.splice(index, 1);
}

export function removeLane(p: Project, laneId: number) {
  const found = findLane(p, laneId);
  if (found) found.track.automation = found.track.automation.filter((l) => l.id !== laneId);
}
