import {
  type Clip,
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

export function addTrack(p: Project, name?: string, index = p.tracks.length): number {
  const id = takeId(p);
  p.tracks.splice(index, 0, {
    id,
    name: name ?? `Track ${p.tracks.length + 1}`,
    color: trackColor(p.tracks.length),
    gain: 1,
    pan: 0,
    mute: false,
    solo: false,
    clips: [],
  });
  return id;
}

export function removeTrack(p: Project, id: number) {
  p.tracks = p.tracks.filter((t) => t.id !== id);
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
  if (!track || !source) return undefined;
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

  for (const [i, { track, clip }] of found.entries()) {
    clip.start += delta;
    if (rowDelta !== 0) {
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
