// Decodes the media crate's fixtures through the real media.wasm (built by `pnpm build:wasm`).
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { decodeWithMedia, extensionOf, type MediaExports } from "./mediaWasm";

const instance = new WebAssembly.Instance(
  new WebAssembly.Module(readFileSync(new URL("./media.wasm", import.meta.url))),
  {},
);
const media = instance.exports as unknown as MediaExports;
const fixture = (name: string) =>
  new Uint8Array(readFileSync(new URL(`../../../../crates/media/tests/fixtures/${name}`, import.meta.url)));

describe("media.wasm", () => {
  it("decodes and resamples every fixture format", () => {
    for (const name of [
      "tone-44k1-mono.wav",
      "tone-44k1-mono.flac",
      "tone-44k1-mono.mp3",
      "tone-44k1-mono.m4a",
    ]) {
      const decoded = decodeWithMedia(media, fixture(name), extensionOf(name), 48_000);
      expect(decoded.originalSampleRate, name).toBe(44_100);
      expect(decoded.channels, name).toHaveLength(1);
      expect(decoded.frames / 48_000, name).toBeGreaterThan(0.49);
      expect(decoded.frames / 48_000, name).toBeLessThan(0.62);
      expect(decoded.peaks[0]!.length, name).toBe(Math.ceil(decoded.frames / decoded.framesPerPeak) * 2);
    }
  });

  it("reports decoder errors as exceptions and keeps working afterwards", () => {
    expect(() => decodeWithMedia(media, new TextEncoder().encode("not audio"), "wav", 48_000)).toThrow(
      /unsupported/,
    );
    expect(decodeWithMedia(media, fixture("tone-44k1-mono.wav"), "wav", 48_000).frames).toBe(24_000);
  });

  it("derives extension hints", () => {
    expect(extensionOf("Take 3.WAV")).toBe("wav");
    expect(extensionOf("noext")).toBeUndefined();
  });
});
