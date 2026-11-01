import type { AutomationTarget } from "@tessera/platform";
import { type Command, DEVICES, MASTER_TRACK } from "@tessera/schema";
import { produce } from "immer";
import { describe, expect, it } from "vitest";
import {
  addClip,
  addDevice,
  addPoint,
  addSend,
  addSource,
  addTrack,
  ensureLane,
  moveClips,
  moveDevice,
  newProject,
  removeDevice,
  removeTrack,
  setOutput,
  setParam,
  updateTrack,
} from "../model/edits";
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
  const automation: [number, number, AutomationTarget, [number, number][]][] = [];
  const sync = new EngineSync(
    { send: (c) => sent.push(c), setAutomation: (...args) => automation.push(args) },
    engineRate,
  );
  const ids = { track: 0, source: 0, clip: 0 };
  const project = produce(newProject("p", "T", "now"), (p) => {
    ids.track = addTrack(p);
    ids.source = addSource(p, SOURCE);
    ids.clip = addClip(p, ids.track, ids.source, 96_000)!;
  });
  return { sent, sync, ids, project, automation };
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

describe("EngineSync with Tune", () => {
  it("plays a tuned clip as crossfaded original and rendered segments", async () => {
    const { sent, sync, ids, project } = setup();
    const tuned = produce(project, (p) => {
      const clip = p.tracks[0]!.clips[0]!;
      clip.tune = { notes: [], key: null };
    });
    sync.sync(tuned);
    sync.registerSource(ids.source, 7);
    sent.length = 0;
    // 1 s clip at 2 s: original 0–0.4 s, a rendered region 0.4–0.6 s, original after.
    sync.setTunePlan(ids.clip, {
      outputFrames: 48_000,
      segments: [
        { kind: "original", start: 0, end: 19_200 },
        { kind: "rendered", start: 19_200, end: 28_800, renderStart: 18_960, renderEnd: 29_040, key: "r1" },
        { kind: "original", start: 28_800, end: 48_000 },
      ],
      sources: { r1: 42 },
    });
    expect(sent[0]).toEqual({ type: "RemoveClip", clip: ids.clip });
    const clips = sent.filter((c) => c.type === "SetClip");
    expect(clips).toHaveLength(3);
    expect(clips[0]).toMatchObject({
      source: 7,
      start: 96_000,
      offset: 0,
      length: 19_440,
      fadeIn: 0,
      fadeOut: 480,
    });
    expect(clips[1]).toMatchObject({
      source: 42,
      start: 96_000 + 18_960,
      offset: 0,
      length: 10_080,
      fadeIn: 480,
      fadeOut: 480,
    });
    expect(clips[2]).toMatchObject({
      source: 7,
      start: 96_000 + 28_560,
      offset: 28_560,
      length: 19_440,
      fadeIn: 480,
      fadeOut: 0,
    });

    // Back to plain playback (A/B): the segments go and the clip returns.
    sent.length = 0;
    sync.setTunePlan(ids.clip, undefined);
    expect(sent.filter((c) => c.type === "RemoveClip")).toHaveLength(3);
    expect(sent.at(-1)).toMatchObject({ type: "SetClip", clip: ids.clip, source: 7 });
  });

  it("mirrors insert chains: adds, parameters, bypass, reorder and removal", () => {
    const { sent, sync, ids, project } = setup();
    sync.sync(project);
    sent.length = 0;
    let eq = 0;
    let comp = 0;
    const p1 = produce(project, (p) => {
      eq = addDevice(p, ids.track, "eq")!;
      comp = addDevice(p, null, "compressor")!;
      setParam(p, eq, "b1Gain", 30); // clamped to 24
    });
    sync.sync(p1);
    expect(sent).toEqual([
      { type: "AddDevice", device: comp, track: MASTER_TRACK, position: 0, kind: DEVICES.compressor.code },
      { type: "AddDevice", device: eq, track: ids.track, position: 0, kind: DEVICES.eq.code },
      { type: "SetDeviceParam", device: eq, param: 3, value: 24 },
    ]);
    sent.length = 0;
    let lim = 0;
    const p2 = produce(p1, (p) => {
      lim = addDevice(p, ids.track, "limiter", 0)!;
      p.tracks[0]!.inserts[1]!.bypass = true;
    });
    sync.sync(p2);
    expect(sent).toEqual([
      { type: "AddDevice", device: lim, track: ids.track, position: 0, kind: DEVICES.limiter.code },
      { type: "MoveDevice", device: eq, track: ids.track, position: 1 },
      { type: "SetDeviceBypass", device: eq, bypass: true },
    ]);
    sent.length = 0;
    sync.sync(produce(p2, (p) => moveDevice(p, lim, 1)));
    expect(sent).toEqual([
      { type: "MoveDevice", device: eq, track: ids.track, position: 0 },
      { type: "MoveDevice", device: lim, track: ids.track, position: 1 },
    ]);
    sent.length = 0;
    sync.sync(produce(p2, (p) => removeDevice(p, eq)));
    expect(sent).toContainEqual({ type: "RemoveDevice", device: eq });
  });

  it("routes outputs and sends, and clears them with their bus", () => {
    const { sent, sync, ids, project } = setup();
    sync.sync(project);
    sent.length = 0;
    let bus = 0;
    const p1 = produce(project, (p) => {
      bus = addTrack(p, undefined, undefined, "bus");
      setOutput(p, ids.track, bus);
      addSend(p, ids.track, bus, 0.25);
      setOutput(p, bus, ids.track); // would loop: ignored
    });
    sync.sync(p1);
    expect(sent).toContainEqual({ type: "SetTrackOutput", track: ids.track, output: bus });
    expect(sent).toContainEqual({
      type: "SetSend",
      track: ids.track,
      index: 0,
      enabled: true,
      target: bus,
      gain: 0.25,
      pre: false,
    });
    expect(sent.filter((c) => c.type === "SetTrackOutput")).toHaveLength(1);
    sent.length = 0;
    sync.sync(produce(p1, (p) => removeTrack(p, bus)));
    expect(sent).toContainEqual({ type: "RemoveTrack", track: bus });
    expect(sent).toContainEqual({ type: "SetTrackOutput", track: ids.track, output: MASTER_TRACK });
    expect(sent).toContainEqual(expect.objectContaining({ type: "SetSend", index: 0, enabled: false }));
  });

  it("sends automation lanes at the engine rate and only when they change", () => {
    const { sent, sync, ids, project, automation } = setup(44_100);
    sync.sync(project);
    let lane = 0;
    let eq = 0;
    const p1 = produce(project, (p) => {
      lane = ensureLane(p, ids.track, { kind: "volume" })!;
      addPoint(p, lane, 0, 1);
      addPoint(p, lane, 48_000, 0.5);
      eq = addDevice(p, ids.track, "eq")!;
      const param = ensureLane(p, ids.track, { kind: "param", device: eq, param: "b2Freq" })!;
      addPoint(p, param, 0, 500);
    });
    sync.sync(p1);
    expect(automation).toEqual([
      [
        lane,
        ids.track,
        { kind: 0, index: 0, device: 0 },
        [
          [0, 1],
          [44_100, 0.5],
        ],
      ],
      [lane + 2, ids.track, { kind: 3, index: 7, device: eq }, [[0, 500]]],
    ]);
    automation.length = 0;
    sync.sync(produce(p1, (p) => void (p.tempo = 90)));
    expect(automation).toEqual([]);
    sent.length = 0;
    sync.sync(produce(p1, (p) => removeDevice(p, eq)));
    expect(sent).toContainEqual({ type: "RemoveAutomation", lane: lane + 2 });
  });

  it("removes a device (and its automation) when its kind becomes unknown", () => {
    const { sent, sync, ids, project } = setup();
    let unknown = 0;
    let eq = 0;
    let lane = 0;
    const p1 = produce(project, (p) => {
      unknown = addDevice(p, ids.track, "eq")!;
      p.tracks[0]!.inserts[0]!.kind = "future-device";
      eq = addDevice(p, ids.track, "eq")!;
      lane = ensureLane(p, ids.track, { kind: "param", device: eq, param: "b1Gain" })!;
      addPoint(p, lane, 0, 3);
    });
    sync.sync(p1);
    // Positions count only devices the engine has.
    expect(sent).toContainEqual({
      type: "AddDevice",
      device: eq,
      track: ids.track,
      position: 0,
      kind: DEVICES.eq.code,
    });
    expect(sent.some((c) => c.type === "AddDevice" && c.device === unknown)).toBe(false);
    sent.length = 0;
    sync.sync(produce(p1, (p) => void (p.tracks[0]!.inserts[1]!.kind = "future-device")));
    expect(sent).toContainEqual({ type: "RemoveDevice", device: eq });
    expect(sent).toContainEqual({ type: "RemoveAutomation", lane });
  });
});
