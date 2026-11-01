/** Name the worklet registers under and the options the main thread passes to it. */
export const PROCESSOR_NAME = "tessera-engine";

export interface ProcessorOptions {
  module: WebAssembly.Module;
  commands: SharedArrayBuffer;
  events: SharedArrayBuffer;
  ringCapacity: number;
  /** Captured input → background worker (see `CaptureRing`). */
  capture: SharedArrayBuffer;
  captureCapacity: number;
}

/** Frames per `source-chunk` message: small enough to copy within one render quantum. */
export const SOURCE_CHUNK_FRAMES = 48_000;

/**
 * Main thread → worklet port messages. Audio sources are uploaded in acknowledged chunks so
 * the copying never piles up inside a single render quantum.
 */
export type WorkletRequest =
  | { type: "source-begin"; seq: number; id: number; channels: number; frames: number }
  | { type: "source-chunk"; seq: number; id: number; offset: number; data: Float32Array[] }
  | { type: "source-end"; seq: number; id: number }
  | { type: "gc"; seq: number }
  /** Creates a device's DSP state (allocates, so never inside `process()`). */
  | { type: "device"; seq: number; id: number; kind: number }
  | {
      type: "automation";
      seq: number;
      lane: number;
      track: number;
      kind: number;
      index: number;
      device: number;
      /** `[frame, value]` pairs, flattened. */
      points: Float64Array;
    };

/** Worklet → main thread port messages. */
export type WorkletReply = { type: "ready" } | { type: "ack"; seq: number; ok: boolean; error?: string };
