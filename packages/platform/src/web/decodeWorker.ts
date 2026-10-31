/// <reference lib="webworker" />
/**
 * Web Worker that decodes imported files with media.wasm, off both the main thread and the
 * audio thread.
 */
import mediaUrl from "./media.wasm?url";
import { decodeWithMedia, type MediaExports } from "./mediaWasm";

export interface DecodeRequest {
  id: number;
  bytes: ArrayBuffer;
  extension: string | undefined;
  targetRate: number;
}

export type DecodeResponse =
  ({ id: number; ok: true } & import("./mediaWasm").DecodedAudio) | { id: number; ok: false; error: string };

declare const self: DedicatedWorkerGlobalScope;

let media: Promise<MediaExports> | undefined;

self.onmessage = async (event: MessageEvent<DecodeRequest>) => {
  const { id, bytes, extension, targetRate } = event.data;
  try {
    media ??= WebAssembly.instantiateStreaming(fetch(mediaUrl)).then(
      ({ instance }) => instance.exports as unknown as MediaExports,
    );
    const decoded = decodeWithMedia(await media, new Uint8Array(bytes), extension, targetRate);
    const response: DecodeResponse = { id, ok: true, ...decoded };
    self.postMessage(
      response,
      [...decoded.channels, ...decoded.peaks].map((a) => a.buffer),
    );
  } catch (e) {
    const response: DecodeResponse = { id, ok: false, error: e instanceof Error ? e.message : String(e) };
    self.postMessage(response);
  }
};
