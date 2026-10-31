/**
 * AudioWorklet processor hosting the engine-wasm module.
 *
 * REAL-TIME: nothing in `process()` may allocate. Views over WASM memory and the
 * command sink are created once in the constructor.
 */
import { CommandRing } from "./commandRing";
import { PROCESSOR_NAME, type ProcessorOptions } from "./protocol";
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

class TesseraProcessor extends AudioWorkletProcessor {
  private readonly engine: EngineExports;
  private readonly handle: number;
  private readonly ring: CommandRing;
  private readonly status: Int32Array;
  private readonly peakF32 = new Float32Array(1);
  private readonly peakI32 = new Int32Array(this.peakF32.buffer);
  private readonly sink: (op: number, value: number) => void;
  private view: Float32Array;
  private viewPtr = 0;

  constructor(options: AudioWorkletNodeOptions) {
    super();
    const opts = options.processorOptions as ProcessorOptions;
    this.engine = instantiateEngine(opts.module);
    this.handle = this.engine.tessera_create(sampleRate);
    this.ring = new CommandRing(opts.commands, opts.commandCapacity);
    this.status = new Int32Array(opts.status);
    this.view = new Float32Array(this.engine.memory.buffer, 0, 0);
    const { engine, handle } = this;
    this.sink = (op, value) => {
      engine.tessera_command(handle, op, value);
    };
    this.port.postMessage({ type: "ready", sampleRate });
  }

  process(_inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const output = outputs[0];
    const first = output?.[0];
    if (!output || !first || this.handle === 0) return true;
    this.ring.drain(this.sink);

    const frames = first.length;
    const ptr = this.engine.tessera_process(this.handle, frames);
    // The engine never grows memory after creation, so this only runs on the first block.
    if (
      ptr !== this.viewPtr ||
      this.view.length !== frames ||
      this.view.buffer !== this.engine.memory.buffer
    ) {
      this.view = new Float32Array(this.engine.memory.buffer, ptr, frames);
      this.viewPtr = ptr;
    }
    for (const channel of output) channel.set(this.view);

    this.peakF32[0] = this.engine.tessera_peak(this.handle);
    Atomics.store(this.status, 0, this.peakI32[0]!);
    return true;
  }
}

registerProcessor(PROCESSOR_NAME, TesseraProcessor);
