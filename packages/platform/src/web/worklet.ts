/**
 * AudioWorklet processor hosting the engine-wasm module.
 *
 * REAL-TIME: nothing in `process()` may allocate. Views over WASM memory are only rebuilt
 * when the memory has grown, which only happens in the message handler (source uploads).
 */
import { EventLayout, MAX_ARGS } from "@tessera/schema";
import { CaptureRing, CHUNK_SAMPLES, pumpCapture } from "./captureRing";
import { MessageRing } from "./messageRing";
import { PROCESSOR_NAME, type ProcessorOptions, type WorkletReply, type WorkletRequest } from "./protocol";
import { type EngineExports, instantiateEngine } from "./wasmEngine";

// AudioWorkletGlobalScope members (not part of lib.dom).
declare const sampleRate: number;
declare const registerProcessor: (
  name: string,
  ctor: new (options: AudioWorkletNodeOptions) => unknown,
) => void;
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
}

const QUANTUM = 128;

class TesseraProcessor extends AudioWorkletProcessor {
  private readonly engine: EngineExports;
  private readonly handle: number;
  private readonly commands: MessageRing;
  private readonly events: MessageRing;
  private readonly capture: CaptureRing;
  private readonly pollCapture: () => boolean;
  private readonly reportOverrun: (track: number) => void;
  /** Preallocated arguments for overrun events (no allocation in `process()`). */
  private readonly overrunArgs = new Float64Array(MAX_ARGS);
  private readonly pending = new Map<number, number>();
  private readonly sink: (op: number, args: Float64Array, base: number) => void;
  private memoryBuffer: ArrayBuffer | SharedArrayBuffer;
  private commandArgs!: Float64Array;
  private eventArgs!: Float64Array;
  private outL!: Float32Array;
  private outR!: Float32Array;
  private inL!: Float32Array;
  private inR!: Float32Array;
  private captureInfo!: Float64Array;
  private captureData!: Float32Array;
  private viewFrames = QUANTUM;

  constructor(options: AudioWorkletNodeOptions) {
    super();
    const opts = options.processorOptions as ProcessorOptions;
    this.engine = instantiateEngine(opts.module);
    this.handle = this.engine.tessera_create(sampleRate);
    this.commands = new MessageRing(opts.commands, opts.ringCapacity);
    this.events = new MessageRing(opts.events, opts.ringCapacity);
    this.capture = new CaptureRing(opts.capture, opts.captureCapacity);
    this.pollCapture = () => this.engine.tessera_poll_capture(this.handle) !== 0;
    this.reportOverrun = (track) => {
      // Same event the native engine emits when its own capture queue overflows.
      this.overrunArgs[0] = track;
      this.events.push(EventLayout.CaptureOverrun.op, this.overrunArgs);
    };
    this.memoryBuffer = this.engine.memory.buffer;
    this.refreshViews(QUANTUM);
    this.sink = (op, args, base) => {
      const dst = this.commandArgs;
      for (let i = 0; i < MAX_ARGS; i++) dst[i] = args[base + i]!;
      this.engine.tessera_command(this.handle, op);
    };
    this.port.onmessage = (e: MessageEvent<WorkletRequest>) => this.onRequest(e.data);
    this.reply({ type: "ready" });
  }

  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const output = outputs[0];
    const left = output?.[0];
    if (!output || !left || this.handle === 0) return true;
    const frames = left.length;
    if (frames !== this.viewFrames || this.engine.memory.buffer !== this.memoryBuffer) {
      this.refreshViews(frames);
    }

    this.commands.drain(this.sink);
    // Input arrives only while a microphone stream is connected; otherwise no channels.
    const input = inputs[0];
    const inChannels = Math.min(2, input?.length ?? 0);
    if (inChannels > 0) this.inL.set(input![0]!); // Same length as the output (one render quantum).
    if (inChannels > 1) this.inR.set(input![1]!);
    this.engine.tessera_process(this.handle, frames, inChannels);
    left.set(this.outL);
    output[1]?.set(this.outR);

    for (
      let op = this.engine.tessera_poll_event(this.handle);
      op >= 0;
      op = this.engine.tessera_poll_event(this.handle)
    ) {
      // Dropping events when the main thread is behind is fine.
      this.events.push(op, this.eventArgs);
    }
    // Captured input goes straight to the background worker, which writes the takes.
    pumpCapture(this.pollCapture, this.captureInfo, this.captureData, this.capture, this.reportOverrun);
    return true;
  }

  private refreshViews(frames: number) {
    const { engine, handle } = this;
    const buffer = engine.memory.buffer;
    this.memoryBuffer = buffer;
    this.viewFrames = frames;
    this.commandArgs = new Float64Array(buffer, engine.tessera_command_args(handle), MAX_ARGS);
    this.eventArgs = new Float64Array(buffer, engine.tessera_event_args(handle), MAX_ARGS);
    this.outL = new Float32Array(buffer, engine.tessera_output(handle, 0), frames);
    this.outR = new Float32Array(buffer, engine.tessera_output(handle, 1), frames);
    this.inL = new Float32Array(buffer, engine.tessera_input(handle, 0), frames);
    this.inR = new Float32Array(buffer, engine.tessera_input(handle, 1), frames);
    this.captureInfo = new Float64Array(buffer, engine.tessera_capture_info(handle), 4);
    this.captureData = new Float32Array(buffer, engine.tessera_capture_data(handle), CHUNK_SAMPLES);
  }

  /** Runs between render quanta, so it may allocate. */
  private onRequest(request: WorkletRequest) {
    const { engine } = this;
    try {
      switch (request.type) {
        case "source-begin": {
          const pending = engine.tessera_source_create(request.channels, request.frames);
          if (pending === 0) throw new Error("source has no channels");
          this.pending.set(request.id, pending);
          break;
        }
        case "source-chunk": {
          const pending = this.pending.get(request.id);
          if (pending === undefined) throw new Error(`unknown source ${request.id}`);
          request.data.forEach((samples, ch) => {
            const ptr = engine.tessera_source_channel(pending, ch);
            if (ptr !== 0)
              new Float32Array(engine.memory.buffer, ptr + request.offset * 4, samples.length).set(samples);
          });
          break;
        }
        case "source-end": {
          const pending = this.pending.get(request.id);
          if (pending === undefined) throw new Error(`unknown source ${request.id}`);
          this.pending.delete(request.id);
          if (!engine.tessera_source_commit(this.handle, pending, request.id))
            throw new Error("engine queue full");
          break;
        }
        case "gc":
          engine.tessera_collect_garbage(this.handle);
          break;
      }
      this.reply({ type: "ack", seq: request.seq, ok: true });
    } catch (e) {
      this.reply({
        type: "ack",
        seq: request.seq,
        ok: false,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  private reply(message: WorkletReply) {
    this.port.postMessage(message);
  }
}

registerProcessor(PROCESSOR_NAME, TesseraProcessor);
