/** Name the worklet registers under and the options the main thread passes to it. */
export const PROCESSOR_NAME = "tessera-engine";

export interface ProcessorOptions {
  module: WebAssembly.Module;
  commands: SharedArrayBuffer;
  commandCapacity: number;
  /** `[peakBits: i32]`: latest output peak as raw f32 bits, written atomically. */
  status: SharedArrayBuffer;
}

export const STATUS_BYTES = 4;
