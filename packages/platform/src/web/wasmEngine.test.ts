// Exercises the real engine.wasm (built by `pnpm build:wasm`) through the same ABI and raw
// encoding the worklet uses, so a mismatch between Rust and TypeScript fails here.
import { readFileSync } from "node:fs";
import { type Command, DEVICES, type Event, MASTER_TRACK, MAX_ARGS } from "@tessera/schema";
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

  /** What the worklet's message handler does for `AddDevice` (state is created outside process()). */
  createDevice(id: number, kind: number) {
    expect(this.e.tessera_device_create(this.h, id, kind)).toBe(1);
  }

  automate(
    lane: number,
    track: number,
    kind: 0 | 1 | 2 | 3,
    index: number,
    device: number,
    points: [number, number][],
  ) {
    const ptr = this.e.tessera_automation_points(this.h, points.length);
    new Float64Array(this.e.memory.buffer, ptr, points.length * 2).set(points.flat());
    expect(this.e.tessera_automation_commit(this.h, points.length, lane, track, kind, index, device)).toBe(1);
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

  it("runs devices whose state arrives through the message handler, and automation", () => {
    const t = new TestEngine();
    t.addSource(1, [new Float32Array(SR).fill(0.5)]);
    t.send({ type: "AddTrack", track: 1 });
    t.send(clip(1, 1, 1, SR));
    t.send({ type: "AddDevice", device: 9, track: 1, position: 0, kind: DEVICES.utility.code });
    t.send({ type: "SetDeviceParam", device: 9, param: 0, value: -6.0206 });
    t.createDevice(9, DEVICES.utility.code);
    t.automate(3, 1, 0, 0, 0, [
      [0, 1],
      [4800, 0],
    ]);
    t.send({ type: "Play" });
    const [left] = t.render(4800);
    // Utility gain (−6 dB, after its 5 ms glide) × the volume ramp from 1 to 0.
    expect(left[2400]).toBeCloseTo(0.125, 4);
    expect(left[4799]).toBeCloseTo(0.25 / 4800, 4);
    t.send({ type: "RemoveAutomation", lane: 3 });
    t.send({ type: "RemoveDevice", device: 9 });
    t.render(QUANTUM);
    expect(t.e.tessera_collect_garbage(t.h)).toBe(2);
  });

  it("mixes a 12-track session with effects at least 10× faster than real time", () => {
    const t = new TestEngine();
    const seconds = 10;
    const frames = SR * seconds;
    let id = 1000;
    const device = (track: number, kind: keyof typeof DEVICES) => {
      id++;
      t.send({ type: "AddDevice", device: id, track, position: 99, kind: DEVICES[kind].code });
      t.createDevice(id, DEVICES[kind].code);
      return id;
    };
    t.send({ type: "AddTrack", track: 100 });
    t.send({ type: "AddTrack", track: 101 });
    const reverb = device(100, "reverb");
    t.send({ type: "SetDeviceParam", device: reverb, param: 5, value: 1 });
    const delay = device(101, "delay");
    t.send({ type: "SetDeviceParam", device: delay, param: 3, value: 1 });
    device(MASTER_TRACK, "limiter");
    for (let track = 0; track < 12; track++) {
      const samples = new Float32Array(frames);
      const f = 110 * (track + 2);
      for (let i = 0; i < frames; i++) samples[i] = 0.2 * Math.sin((2 * Math.PI * f * i) / SR);
      t.addSource(track, [samples]);
      t.send({ type: "AddTrack", track });
      t.send(clip(track, track, track, frames));
      t.send({ type: "SetSend", track, index: 0, enabled: true, target: 100, gain: 0.3, pre: false });
      t.send({ type: "SetSend", track, index: 1, enabled: true, target: 101, gain: 0.2, pre: false });
      const eq = device(track, "eq");
      t.send({ type: "SetDeviceParam", device: eq, param: 10, value: 1 });
      device(track, "compressor");
      t.automate(track + 1, track, 0, 0, 0, [
        [0, 0],
        [frames, 1],
      ]);
    }
    t.send({ type: "Play" });
    t.render(QUANTUM * 10); // warm up
    const start = performance.now();
    const [left] = t.render(frames);
    const elapsed = (performance.now() - start) / 1000;
    expect(left.some((s) => Math.abs(s) > 0.05)).toBe(true);
    expect(seconds / elapsed).toBeGreaterThan(10);
    console.log(`12-track session: ${(seconds / elapsed).toFixed(1)}× real time`);
  });
});
