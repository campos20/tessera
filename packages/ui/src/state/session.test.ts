import type { AudioPlatform, ProjectStorage } from "@tessera/platform";
import type { Command, Project, SourceInfo } from "@tessera/schema";
import { produce } from "immer";
import { describe, expect, it } from "vitest";
import { addClip, addSource, addTrack, newProject } from "../model/edits";
import { Session } from "./session";

/** A platform whose engine runs at `engineRate`; records every command sent. */
function fakePlatform(engineRate: number, saved: Project) {
  const sent: Command[] = [];
  const storage: ProjectStorage = {
    list: async () => [{ id: saved.id, name: saved.name, modifiedAt: saved.modifiedAt }],
    open: async () => saved,
    save: async () => {},
    writeFile: async () => {},
    readFile: async (_id, path) => new File([new Uint8Array(4)], path),
    delete: async () => {},
    deleteFile: async () => {},
    exportArchive: async () => true,
    importArchive: async () => saved,
  };
  let nextSource = 100;
  const platform: AudioPlatform = {
    edition: "web",
    capabilities: {
      plugins: false,
      outputDeviceSelection: false,
      midi: false,
      settings: { host: false, outputDevice: false, inputDevice: true, sampleRate: false, bufferSize: false },
    },
    storage,
    start: async () => ({ sampleRate: engineRate, inputChannels: 0, latencyEstimate: 0 }),
    configureAudio: async () => ({
      info: { sampleRate: engineRate, inputChannels: 1, latencyEstimate: 0 },
      restarted: false,
    }),
    beginRecording: async () => {},
    endRecording: async () => [],
    onRecordingProgress: () => () => {},
    onXruns: () => () => {},
    measureLatency: async () => null,
    send: (c) => void sent.push(c),
    onEvent: () => () => {},
    // One second of audio, reported (like the real platforms) at the engine rate.
    importAudio: async (file): Promise<SourceInfo> => ({
      id: nextSource++,
      name: file.name,
      frames: engineRate,
      channels: 1,
      sampleRate: engineRate,
      originalSampleRate: 44_100,
      peaks: { framesPerPeak: 256, data: [[]] },
    }),
    listDevices: async () => ({ hosts: [] }),
    diagnostics: async () => ({}),
  };
  return { platform, sent };
}

/** A saved project with one 1 s clip at 2 s (project frames, 48 kHz). */
function savedProject(): Project {
  return produce(newProject("song", "Song", "2026-01-01T00:00:00Z"), (p) => {
    const track = addTrack(p);
    const source = addSource(p, {
      name: "a.wav",
      file: "audio/a.wav",
      frames: 48_000,
      channels: 1,
      originalSampleRate: 44_100,
    });
    addClip(p, track, source, 96_000);
  });
}

describe("Session", () => {
  it("restores clips at the engine's real rate before the first Play", async () => {
    const { platform, sent } = fakePlatform(44_100, savedProject());
    const session = new Session(platform);
    await session.init();

    // The clip at 2 s must reach a 44.1 kHz engine at frame 88200, not 96000.
    const clips = sent.filter((c) => c.type === "SetClip");
    expect(clips.at(-1)).toMatchObject({ start: 88_200, length: 44_100 });
    expect(clips.every((c) => c.type === "SetClip" && c.start === 88_200)).toBe(true);

    // Seeks before Play use engine frames too.
    session.seek(48_000);
    expect(sent.at(-1)).toEqual({ type: "Seek", frame: 44_100 });
  });

  it("re-sends the playhead when the engine rate changes", async () => {
    const { platform, sent } = fakePlatform(
      44_100,
      produce(savedProject(), (p) => void (p.tracks = [])),
    );
    const session = new Session(platform);
    await session.init();
    session.seek(96_000); // Sent at the 48 kHz default: no audio has reported the rate yet.
    expect(sent.at(-1)).toEqual({ type: "Seek", frame: 96_000 });
    await session.startEngine();
    expect(sent.filter((c) => c.type === "Seek").at(-1)).toEqual({ type: "Seek", frame: 88_200 });
  });
});
