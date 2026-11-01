import type { Command } from "@tessera/schema";
import { produce } from "immer";
import { describe, expect, it } from "vitest";
import { addClip, addSource, addTrack, moveClips, newProject, updateTrack } from "../model/edits";
import { EngineSync } from "./engineSync";

const SOURCE = {
  name: "a.wav",
  file: "audio/a.wav",
  frames: 48_000,
  channels: 1,
  originalSampleRate: 48_000,
};

function setup(engineRate = 48_000) {
  const sent: Command[] = [];
  const sync = new EngineSync({ send: (c) => sent.push(c) }, engineRate);
  const ids = { track: 0, source: 0, clip: 0 };
  const project = produce(newProject("p", "T", "now"), (p) => {
    ids.track = addTrack(p);
    ids.source = addSource(p, SOURCE);
    ids.clip = addClip(p, ids.track, ids.source, 96_000)!;
  });
  return { sent, sync, ids, project };
}

describe("EngineSync", () => {
  it("sends the whole project on first sync, and clips once their audio arrives", () => {
    const { sent, sync, ids, project } = setup();
    sync.sync(project);
    expect(sent.map((c) => c.type)).toEqual([
      "SetTempo",
      "SetMetronome",
      "SetMasterGain",
      "SetLoop",
      "AddTrack",
      "SetTrackGain",
      "SetTrackPan",
      "SetTrackMute",
      "SetTrackSolo",
      "SetTrackInput",
    ]);
    sent.length = 0;
    sync.registerSource(ids.source, 42);
    expect(sent).toEqual([
      {
        type: "SetClip",
        clip: ids.clip,
        track: ids.track,
        source: 42,
        start: 96_000,
        offset: 0,
        length: 48_000,
        gain: 1,
        fadeIn: 0,
        fadeOut: 0,
      },
    ]);
  });

  it("sends only what changed", () => {
    const { sent, sync, ids, project } = setup();
    sync.sync(project);
    sync.registerSource(ids.source, 1);
    sent.length = 0;
    const moved = produce(project, (p) => {
      moveClips(p, [ids.clip], 1000);
      updateTrack(p, ids.track, { mute: true });
    });
    sync.sync(moved);
    expect(sent.map((c) => c.type)).toEqual(["SetTrackMute", "SetClip"]);
    sent.length = 0;
    sync.sync(moved);
    expect(sent).toEqual([]);
  });

  it("converts project frames to the engine rate", () => {
    const { sent, sync, ids, project } = setup(44_100);
    sync.sync(project);
    sync.registerSource(ids.source, 1);
    expect(sent.at(-1)).toMatchObject({ type: "SetClip", start: 88_200, length: 44_100 });
    expect(sync.toProject(44_100, project)).toBe(48_000);
  });

  it("removes deleted tracks and clips but keeps audio for redo", () => {
    const { sent, sync, ids, project } = setup();
    sync.sync(project);
    sync.registerSource(ids.source, 7);
    sent.length = 0;
    const emptied = produce(project, (p) => void ((p.tracks = []), (p.sources = [])));
    sync.sync(emptied);
    expect(sent).toEqual([
      { type: "RemoveClip", clip: ids.clip },
      { type: "RemoveTrack", track: ids.track },
    ]);
    // Redo brings the clip back with its audio still in the engine.
    sent.length = 0;
    sync.sync(project);
    expect(sent.at(-1)).toMatchObject({ type: "SetClip", source: 7 });
  });

  it("releases everything on reset", () => {
    const { sent, sync, ids, project } = setup();
    sync.sync(project);
    sync.registerSource(ids.source, 7);
    sent.length = 0;
    sync.reset();
    expect(sent).toEqual([
      { type: "RemoveTrack", track: ids.track },
      { type: "RemoveSource", source: 7 },
    ]);
    expect(sync.hasSource(ids.source)).toBe(false);
  });
});
