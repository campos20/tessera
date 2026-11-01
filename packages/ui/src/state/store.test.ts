import { describe, expect, it } from "vitest";
import { addClip, addSource, addTrack, moveClips, newProject } from "../model/edits";
import { createProjectStore } from "./store";

const SOURCE = {
  name: "a.wav",
  file: "audio/a.wav",
  frames: 48_000,
  channels: 1,
  originalSampleRate: 48_000,
};

function storeWithClip() {
  const store = createProjectStore(newProject("p", "Test", "now"));
  let clip = 0;
  store.getState().edit("Import", (p) => {
    const track = addTrack(p);
    const source = addSource(p, SOURCE);
    clip = addClip(p, track, source, 0)!;
  });
  return { store, clip };
}

describe("project store", () => {
  it("undoes and redoes edits", () => {
    const { store, clip } = storeWithClip();
    const s = store.getState;
    s().edit("Move", (p) => moveClips(p, [clip], 1000));
    expect(s().project.tracks[0]!.clips[0]!.start).toBe(1000);
    s().undo();
    expect(s().project.tracks[0]!.clips[0]!.start).toBe(0);
    s().undo();
    expect(s().project.tracks).toHaveLength(0);
    s().redo();
    s().redo();
    expect(s().project.tracks[0]!.clips[0]!.start).toBe(1000);
    // A new edit clears the redo stack.
    s().undo();
    s().edit("Rename", (p) => void (p.name = "Renamed"));
    expect(s().future).toHaveLength(0);
  });

  it("ignores edits that change nothing", () => {
    const { store } = storeWithClip();
    const before = store.getState().past.length;
    store.getState().edit("Nothing", () => {});
    expect(store.getState().past.length).toBe(before);
  });

  it("turns a drag gesture into a single undo step", () => {
    const { store, clip } = storeWithClip();
    const s = store.getState;
    const steps = s().past.length;
    s().beginGesture("Move");
    for (const delta of [100, 200, 300]) s().updateGesture((p) => moveClips(p, [clip], delta));
    expect(s().project.tracks[0]!.clips[0]!.start).toBe(300);
    s().commitGesture();
    expect(s().past.length).toBe(steps + 1);
    s().undo();
    expect(s().project.tracks[0]!.clips[0]!.start).toBe(0);
  });

  it("restores the starting state when a gesture is cancelled", () => {
    const { store, clip } = storeWithClip();
    const s = store.getState;
    s().beginGesture("Move");
    s().updateGesture((p) => moveClips(p, [clip], 500));
    s().cancelGesture();
    expect(s().project.tracks[0]!.clips[0]!.start).toBe(0);
  });

  it("prunes the selection when clips disappear", () => {
    const { store, clip } = storeWithClip();
    store.getState().select({ clips: new Set([clip]) });
    store.getState().undo();
    expect(store.getState().selection.clips.size).toBe(0);
  });
});
