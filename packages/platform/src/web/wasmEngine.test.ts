// Exercises the real engine.wasm (built by `pnpm build:wasm`) through the same ABI and raw
// encoding the worklet uses, so a mismatch between Rust and TypeScript fails here.
import { readFileSync } from "node:fs";
import { type Command, type Event, MAX_ARGS } from "@tessera/schema";
import { describe, expect, it } from "vitest";
import { decodeEvent, encodeCommand } from "./codec";
import { type EngineExports, instantiateEngine } from "./wasmEngine";

const module = new WebAssembly.Module(readFileSync(new URL("./engine.wasm", import.meta.url)));
const SR = 48_000;
const QUANTUM = 128;

class TestEngine {
  readonly e: EngineExports = instantiateEngine(module);
  readonly h = this.e.tessera_create(SR);

  send(command: Command) {
    const args = new Float64Array(this.e.memory.buffer, this.e.tessera_command_args(this.h), MAX_ARGS);
    expect(this.e.tessera_command(this.h, encodeCommand(command, args))).toBe(1);
  }

  addSource(id: number, channels: Float32Array[]) {
    const pending = this.e.tessera_source_create(channels.length, channels[0]!.length);
    channels.forEach((samples, ch) => {
      new Float32Array(this.e.memory.buffer, this.e.tessera_source_channel(pending, ch), samples.length).set(
        samples,
      );
    });
    expect(this.e.tessera_source_commit(this.h, pending, id)).toBe(1);
  }

  /** Renders `frames` in worklet-sized quanta; returns planar [left, right]. */
  render(frames: number): [Float32Array, Float32Array] {
    const out: [Float32Array, Float32Array] = [new Float32Array(frames), new Float32Array(frames)];
    for (let i = 0; i < frames; i += QUANTUM) {
      const n = this.e.tessera_process(this.h, Math.min(QUANTUM, frames - i), 0);
      out[0].set(new Float32Array(this.e.memory.buffer, this.e.tessera_output(this.h, 0), n), i);
      out[1].set(new Float32Array(this.e.memory.buffer, this.e.tessera_output(this.h, 1), n), i);
    }
    return out;
  }

  events(): Event[] {
    const out: Event[] = [];
    for (let op = this.e.tessera_poll_event(this.h); op >= 0; op = this.e.tessera_poll_event(this.h)) {
      const args = new Float64Array(this.e.memory.buffer, this.e.tessera_event_args(this.h), MAX_ARGS);
      const event = decodeEvent(op, args);
      if (event) out.push(event);
    }
    return out;
  }
}

const clip = (id: number, track: number, source: number, length: number): Command => ({
  type: "SetClip",
  clip: id,
  track,
  source,
  start: 0,
  offset: 0,
  length,
  gain: 1,
  fadeIn: 0,
  fadeOut: 0,
});

describe("engine.wasm", () => {
  it("has no imports, so the worklet can instantiate it synchronously", () => {
    expect(WebAssembly.Module.imports(module)).toEqual([]);
  });

  it("plays a clip with track pan and reports transport and meters", () => {
    const t = new TestEngine();
    t.addSource(1, [new Float32Array(SR).fill(0.5)]);
    t.send({ type: "AddTrack", track: 1 });
    t.send({ type: "SetTrackPan", track: 1, pan: 1 });
    t.send(clip(1, 1, 1, SR));
    t.send({ type: "Play" });
    const [left, right] = t.render(SR / 2);
    expect(left[0]).toBeCloseTo(0, 6);
    expect(right[0]).toBeCloseTo(0.5, 6);

    const events = t.events();
    const transport = events.filter((e) => e.type === "Transport").at(-1);
    expect(transport).toMatchObject({ playing: true });
    expect(transport?.type === "Transport" && transport.position).toBeGreaterThan(SR / 2 - 2000);
    const meter = events.filter((e) => e.type === "TrackMeter").at(-1);
    expect(meter).toMatchObject({ track: 1 });
    expect(meter?.type === "TrackMeter" && meter.peakR).toBeCloseTo(0.5, 5);
  });

  it("frees removed sources only when garbage is collected", () => {
    const t = new TestEngine();
    t.addSource(1, [new Float32Array(1000)]);
    t.send({ type: "RemoveSource", source: 1 });
    t.render(QUANTUM);
    expect(t.e.tessera_collect_garbage(t.h)).toBe(1);
  });

  it("does not grow memory while processing", () => {
    const t = new TestEngine();
    t.send({ type: "Play" });
    const before = t.e.memory.buffer.byteLength;
    t.render(SR);
    expect(t.e.memory.buffer.byteLength).toBe(before);
  });

  // M1 performance proxy for "16 tracks play glitch-free in the web edition": the engine must
  // render far faster than real time, leaving the browser plenty of headroom per quantum.
  it("renders 16 stereo tracks much faster than real time", () => {
    const t = new TestEngine();
    const seconds = 10;
    for (let track = 1; track <= 16; track++) {
      const l = Float32Array.from({ length: SR * seconds }, (_, i) => Math.sin(i * 0.01 * track) * 0.05);
      t.addSource(track, [l, l.slice().reverse()]);
      t.send({ type: "AddTrack", track });
      t.send({ type: "SetTrackPan", track, pan: (track % 3) - 1 });
      t.send(clip(track, track, track, SR * seconds));
    }
    t.send({ type: "SetMetronome", enabled: true, gain: 0.5, beatsPerBar: 4 });
    t.send({ type: "Play" });

    const start = performance.now();
    for (let i = 0; i < (SR * seconds) / QUANTUM; i++) {
      t.e.tessera_process(t.h, QUANTUM, 0);
      if (i % 64 === 0) t.events();
    }
    const elapsed = (performance.now() - start) / 1000;
    const factor = seconds / elapsed;
    console.log(
      `16 tracks: ${seconds} s rendered in ${(elapsed * 1000).toFixed(0)} ms (${factor.toFixed(0)}x real time)`,
    );
    // Loose bound so slow CI machines pass; a laptop is typically far above this.
    expect(factor).toBeGreaterThan(10);
  });
});
