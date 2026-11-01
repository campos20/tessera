/// <reference lib="webworker" />
/**
 * Web Worker running worker.wasm: decodes imported audio, migrates project files and packs or
 * unpacks `.tessera` archives, off both the main thread and the audio thread.
 */
import workerWasmUrl from "./worker.wasm?url";
import {
  type ArchiveEntry,
  type DecodedAudio,
  decodeAudio,
  loadProjectJson,
  packArchive,
  unpackArchive,
  type WorkerExports,
} from "./workerWasm";

export type WorkerRequest =
  | { kind: "decode"; id: number; bytes: ArrayBuffer; extension: string | undefined; targetRate: number }
  | { kind: "loadProject"; id: number; json: string }
  | { kind: "pack"; id: number; entries: ArchiveEntry[] }
  | { kind: "unpack"; id: number; bytes: ArrayBuffer };

export interface WorkerResults {
  decode: DecodedAudio;
  loadProject: string;
  pack: Uint8Array;
  unpack: ArchiveEntry[];
}

export type WorkerResponse =
  { id: number; ok: true; result: unknown } | { id: number; ok: false; error: string };

declare const self: DedicatedWorkerGlobalScope;

let wasm: Promise<WorkerExports> | undefined;

self.onmessage = async (event: MessageEvent<WorkerRequest>) => {
  const request = event.data;
  try {
    wasm ??= WebAssembly.instantiateStreaming(fetch(workerWasmUrl)).then(
      ({ instance }) => instance.exports as unknown as WorkerExports,
    );
    const m = await wasm;
    let result: unknown;
    let transfer: Transferable[] = [];
    switch (request.kind) {
      case "decode": {
        const decoded = decodeAudio(m, new Uint8Array(request.bytes), request.extension, request.targetRate);
        result = decoded;
        transfer = [...decoded.channels, ...decoded.peaks].map((a) => a.buffer);
        break;
      }
      case "loadProject":
        result = loadProjectJson(m, request.json);
        break;
      case "pack": {
        const zip = packArchive(m, request.entries);
        result = zip;
        transfer = [zip.buffer];
        break;
      }
      case "unpack": {
        const entries = unpackArchive(m, new Uint8Array(request.bytes));
        result = entries;
        transfer = entries.map(([, data]) => data.buffer);
        break;
      }
    }
    self.postMessage({ id: request.id, ok: true, result } satisfies WorkerResponse, transfer);
  } catch (e) {
    self.postMessage({
      id: request.id,
      ok: false,
      error: e instanceof Error ? e.message : String(e),
    } satisfies WorkerResponse);
  }
};
