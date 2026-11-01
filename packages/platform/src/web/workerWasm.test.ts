// Exercises the real worker.wasm (built by `pnpm build:wasm`): decoding the media crate's
// fixtures, project migration and .tessera archives.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  decodeAudio,
  extensionOf,
  loadProjectJson,
  packArchive,
  unpackArchive,
  type WorkerExports,
} from "./workerWasm";

const instance = new WebAssembly.Instance(
  new WebAssembly.Module(readFileSync(new URL("./worker.wasm", import.meta.url))),
  {},
);
const wasm = instance.exports as unknown as WorkerExports;
const fixture = (name: string) =>
  new Uint8Array(readFileSync(new URL(`../../../../crates/media/tests/fixtures/${name}`, import.meta.url)));

describe("worker.wasm", () => {
  it("decodes and resamples every fixture format", () => {
    for (const name of [
      "tone-44k1-mono.wav",
      "tone-44k1-mono.flac",
      "tone-44k1-mono.mp3",
      "tone-44k1-mono.m4a",
    ]) {
      const decoded = decodeAudio(wasm, fixture(name), extensionOf(name), 48_000);
      expect(decoded.originalSampleRate, name).toBe(44_100);
      expect(decoded.channels, name).toHaveLength(1);
      expect(decoded.frames / 48_000, name).toBeGreaterThan(0.49);
      expect(decoded.frames / 48_000, name).toBeLessThan(0.62);
      expect(decoded.peaks[0]!.length, name).toBe(Math.ceil(decoded.frames / decoded.framesPerPeak) * 2);
    }
  });

  it("reports decoder errors as exceptions and keeps working afterwards", () => {
    expect(() => decodeAudio(wasm, new TextEncoder().encode("not audio"), "wav", 48_000)).toThrow(
      /unsupported/,
    );
    expect(decodeAudio(wasm, fixture("tone-44k1-mono.wav"), "wav", 48_000).frames).toBe(24_000);
  });

  it("packs and unpacks archives, rejecting unsafe paths", () => {
    const entries: [string, Uint8Array][] = [
      ["project.json", new TextEncoder().encode("{}")],
      ["audio/1-take.wav", fixture("tone-44k1-mono.wav")],
    ];
    expect(unpackArchive(wasm, packArchive(wasm, entries))).toEqual(entries);
    expect(() => packArchive(wasm, [["../escape", new Uint8Array()]])).toThrow(/unsafe path/);
    expect(() => unpackArchive(wasm, new Uint8Array([1, 2, 3]))).toThrow(/not a .tessera archive/);
  });

  it("migrates project files and rejects newer schemas", () => {
    expect(() => loadProjectJson(wasm, '{"schemaVersion": 999}')).toThrow(/newer version/);
    expect(() => loadProjectJson(wasm, "not json")).toThrow(/invalid project/);
  });

  it("reports overflowing clip bounds instead of wrapping (release WASM has no overflow checks)", () => {
    // Exact u64::MAX digits: JSON.stringify would round the number.
    const json = `{"schemaVersion":1,"id":"p","name":"Huge","sampleRate":48000,"tempo":120,
      "timeSignature":{"numerator":4,"denominator":4},"masterGain":1,"metronome":false,
      "loop":{"enabled":false,"start":0,"end":0},
      "tracks":[{"id":1,"name":"T","color":"#fff","gain":1,"pan":0,"mute":false,"solo":false,
        "clips":[{"id":3,"sourceId":2,"name":"c","start":0,"offset":18446744073709551615,"length":1,
          "gain":1,"fadeIn":0,"fadeOut":0}]}],
      "sources":[{"id":2,"name":"a.wav","file":"audio/a.wav","frames":48000,"channels":1,"originalSampleRate":48000}],
      "nextId":4,"createdAt":"","modifiedAt":""}`;
    expect(() => loadProjectJson(wasm, json)).toThrow(/clip 3 extends past the end of source 2/);
  });

  it("rejects inconsistent projects with every validation issue", () => {
    const clip = {
      id: 2,
      sourceId: 9,
      name: "c",
      start: 0,
      offset: 0,
      length: 10,
      gain: 1,
      fadeIn: 0,
      fadeOut: 0,
    };
    const project = {
      schemaVersion: 1,
      id: "p",
      name: "Broken",
      sampleRate: 48_000,
      tempo: 120,
      timeSignature: { numerator: 4, denominator: 4 },
      masterGain: 1,
      metronome: false,
      loop: { enabled: false, start: 0, end: 0 },
      tracks: [{ id: 2, name: "T", color: "#fff", gain: 1, pan: 0, mute: false, solo: false, clips: [clip] }],
      sources: [],
      nextId: 3,
      createdAt: "",
      modifiedAt: "",
    };
    expect(() => loadProjectJson(wasm, JSON.stringify(project))).toThrow(
      /inconsistent: duplicate id 2 \(clip\); clip 2 uses missing source 9/,
    );
  });

  it("derives extension hints", () => {
    expect(extensionOf("Take 3.WAV")).toBe("wav");
    expect(extensionOf("noext")).toBeUndefined();
  });
});
