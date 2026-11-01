import type { Project } from "@tessera/schema";
import { produce } from "immer";
import { describe, expect, it } from "vitest";
import {
  addClip,
  addSource,
  addTrack,
  deleteClips,
  duplicateClips,
  findClip,
  MIN_CLIP_FRAMES,
  moveClips,
  moveTrack,
  newProject,
  setFade,
  splitClips,
  trimClipEnd,
  trimClipStart,
} from "./edits";

const SOURCE = {
  name: "take.wav",
  file: "audio/take.wav",
  frames: 48_000,
  channels: 2,
  originalSampleRate: 44_100,
};

/** A project with two tracks; track A has one full-source clip at 10_000. */
function setup() {
  const ids = { a: 0, b: 0, source: 0, clip: 0 };
  const project = produce(newProject("p", "Test", "2026-01-01T00:00:00Z"), (p) => {
    ids.a = addTrack(p, "A");
    ids.b = addTrack(p, "B");
    ids.source = addSource(p, SOURCE);
    ids.clip = addClip(p, ids.a, ids.source, 10_000)!;
  });
  return { project, ids };
}

const clipOf = (p: Project, id: number) => findClip(p, id)!.clip;

describe("edits", () => {
  it("adds tracks, sources and clips with unique ids", () => {
    const { project, ids } = setup();
    expect(new Set(Object.values(ids)).size).toBe(4);
    expect(project.nextId).toBe(5);
    expect(clipOf(project, ids.clip)).toMatchObject({
      start: 10_000,
      offset: 0,
      length: 48_000,
      name: "take",
    });
    expect(project.tracks.map((t) => t.color)).toEqual(["#ff9f0a", "#0a84ff"]);
  });

  it("moves clips in time and across tracks, keeping the selection inside the project", () => {
    const { project, ids } = setup();
    const moved = produce(project, (p) => moveClips(p, [ids.clip], 5_000, 1));
    expect(findClip(moved, ids.clip)!.track.id).toBe(ids.b);
    expect(clipOf(moved, ids.clip).start).toBe(15_000);
    const clamped = produce(project, (p) => moveClips(p, [ids.clip], -1e9, -5));
    expect(clipOf(clamped, ids.clip).start).toBe(0);
    expect(findClip(clamped, ids.clip)!.track.id).toBe(ids.a);
  });

  it("trims edges within the source and a minimum length", () => {
    const { project, ids } = setup();
    const trimmed = produce(project, (p) => {
      trimClipStart(p, ids.clip, 12_000);
      trimClipEnd(p, ids.clip, 40_000);
    });
    expect(clipOf(trimmed, ids.clip)).toMatchObject({ start: 12_000, offset: 2_000, length: 28_000 });
    // Can't reveal audio before the source start or after its end.
    const limits = produce(trimmed, (p) => {
      trimClipStart(p, ids.clip, 0);
      trimClipEnd(p, ids.clip, 1e9);
    });
    expect(clipOf(limits, ids.clip)).toMatchObject({ start: 10_000, offset: 0, length: 48_000 });
    const tiny = produce(project, (p) => trimClipEnd(p, ids.clip, 10_001));
    expect(clipOf(tiny, ids.clip).length).toBe(MIN_CLIP_FRAMES);
  });

  it("splits clips, sharing the source and keeping the outer fades", () => {
    const { project, ids } = setup();
    let right: number[] = [];
    const split = produce(project, (p) => {
      setFade(p, ids.clip, "in", 1000);
      setFade(p, ids.clip, "out", 2000);
      right = splitClips(p, [ids.clip], 30_000);
    });
    expect(right).toHaveLength(1);
    expect(clipOf(split, ids.clip)).toMatchObject({
      start: 10_000,
      offset: 0,
      length: 20_000,
      fadeIn: 1000,
      fadeOut: 0,
    });
    expect(clipOf(split, right[0]!)).toMatchObject({
      start: 30_000,
      offset: 20_000,
      length: 28_000,
      fadeIn: 0,
      fadeOut: 2000,
    });
    // Splitting outside the clip or too near an edge does nothing.
    expect(produce(project, (p) => void splitClips(p, [ids.clip], 10_010))).toBe(project);
  });

  it("duplicates the selection right after itself", () => {
    const { project, ids } = setup();
    let copies: number[] = [];
    const dup = produce(project, (p) => {
      copies = duplicateClips(p, [ids.clip]);
    });
    expect(clipOf(dup, copies[0]!)).toMatchObject({ start: 58_000, offset: 0, length: 48_000 });
  });

  it("clamps fades to the clip", () => {
    const { project, ids } = setup();
    const faded = produce(project, (p) => {
      setFade(p, ids.clip, "in", 40_000);
      setFade(p, ids.clip, "out", 40_000);
    });
    expect(clipOf(faded, ids.clip)).toMatchObject({ fadeIn: 40_000, fadeOut: 8_000 });
  });

  it("deletes clips and reorders tracks", () => {
    const { project, ids } = setup();
    const next = produce(project, (p) => {
      deleteClips(p, [ids.clip]);
      moveTrack(p, ids.b, 0);
    });
    expect(findClip(next, ids.clip)).toBeUndefined();
    expect(next.tracks.map((t) => t.id)).toEqual([ids.b, ids.a]);
  });
});
