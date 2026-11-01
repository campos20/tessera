/// <reference lib="webworker" />
/**
 * Web Worker running worker.wasm: decodes imported audio, migrates project files, packs or
 * unpacks `.tessera` archives, writes recorded takes and measures latency — off both the main
 * thread and the audio thread.
 */
import { CaptureRecorder } from "./captureRecorder";
import { CaptureRing } from "./captureRing";
import { type FileSink, type FinishedTake, type Progress, TakeWriter } from "./takeWriter";
import workerWasmUrl from "./worker.wasm?url";
import {
  type ArchiveEntry,
  type DecodedAudio,
  decodeAudio,
  loadProjectJson,
  measureLatency,
  packArchive,
  unpackArchive,
  type WorkerExports,
} from "./workerWasm";

export type WorkerRequest =
  | { kind: "decode"; id: number; bytes: ArrayBuffer; extension: string | undefined; targetRate: number }
  | { kind: "loadProject"; id: number; json: string }
  | { kind: "pack"; id: number; entries: ArchiveEntry[] }
  | { kind: "unpack"; id: number; bytes: ArrayBuffer }
  | { kind: "attachCapture"; id: number; ring: SharedArrayBuffer; capacity: number }
  | { kind: "recordStart"; id: number; projectId: string; prefix: string; sampleRate: number }
  | { kind: "recordStop"; id: number }
  | { kind: "measureLatency"; id: number; projectId: string; path: string; bpm: number };

export interface WorkerResults {
  decode: DecodedAudio;
  loadProject: string;
  pack: Uint8Array;
  unpack: ArchiveEntry[];
  attachCapture: undefined;
  recordStart: undefined;
  recordStop: FinishedTake[];
  measureLatency: { frames: number; confidence: number } | null;
}

/** Replies to requests carry their `id`; unsolicited events don't. */
export type WorkerResponse =
  | { id: number; ok: true; result: unknown }
  | { id: number; ok: false; error: string }
  | { id?: undefined; event: "recordProgress"; progress: Progress[] };

declare const self: DedicatedWorkerGlobalScope;

const DRAIN_INTERVAL_MS = 50;

let wasm: Promise<WorkerExports> | undefined;
let capture: CaptureRing | undefined;
let recording: { recorder: CaptureRecorder; timer: number } | undefined;
let idleTimer = 0;

const loadWasm = () =>
  (wasm ??= WebAssembly.instantiateStreaming(fetch(workerWasmUrl)).then(
    ({ instance }) => instance.exports as unknown as WorkerExports,
  ));

async function projectDir(projectId: string, create = false): Promise<FileSystemDirectoryHandle> {
  const root = await navigator.storage.getDirectory();
  const projects = await root.getDirectoryHandle("projects", { create: true });
  return projects.getDirectoryHandle(projectId, { create });
}

/** A take file written through a sync access handle (fast, worker-only OPFS API). */
async function openTakeFile(dir: FileSystemDirectoryHandle, path: string): Promise<FileSink> {
  const [folder, name] = path.split("/") as [string, string];
  const file = await (
    await dir.getDirectoryHandle(folder, { create: true })
  ).getFileHandle(name, { create: true });
  const handle = await file.createSyncAccessHandle();
  handle.truncate(0);
  return {
    write: (bytes, at) => void handle.write(bytes, { at }),
    close: () => {
      try {
        handle.flush();
      } finally {
        handle.close(); // Always release the file, even if flushing failed.
      }
    },
  };
}

async function startRecording(projectId: string, prefix: string, sampleRate: number) {
  if (!capture) throw new Error("capture is not attached");
  if (recording) throw new Error("already recording");
  const dir = await projectDir(projectId, true);
  const writer = new TakeWriter(sampleRate, prefix, (path) => openTakeFile(dir, path));
  const recorder = new CaptureRecorder(capture, writer, (progress) => {
    self.postMessage({ event: "recordProgress", progress } satisfies WorkerResponse);
  });
  recording = {
    recorder,
    timer: setInterval(() => void recorder.tick(), DRAIN_INTERVAL_MS) as unknown as number,
  };
}

async function stopRecording(): Promise<FinishedTake[]> {
  const r = recording;
  if (!r) throw new Error("not recording");
  clearInterval(r.timer);
  // Cleared first: whatever happens while finishing, the next recordStart works.
  recording = undefined;
  return r.recorder.stop();
}

async function readTake(
  projectId: string,
  path: string,
): Promise<{ samples: Float32Array; sampleRate: number }> {
  const [folder, name] = path.split("/") as [string, string];
  const file = await (
    await (await (await projectDir(projectId)).getDirectoryHandle(folder)).getFileHandle(name)
  ).getFile();
  const bytes = await file.arrayBuffer();
  const view = new DataView(bytes);
  const channels = view.getUint16(22, true);
  const sampleRate = view.getUint32(24, true);
  const all = new Float32Array(bytes, 44);
  const samples = new Float32Array(Math.floor(all.length / channels));
  for (let i = 0; i < samples.length; i++) samples[i] = all[i * channels]!;
  return { samples, sampleRate };
}

self.onmessage = async (event: MessageEvent<WorkerRequest>) => {
  const request = event.data;
  try {
    let result: unknown;
    let transfer: Transferable[] = [];
    switch (request.kind) {
      case "decode": {
        const decoded = decodeAudio(
          await loadWasm(),
          new Uint8Array(request.bytes),
          request.extension,
          request.targetRate,
        );
        result = decoded;
        transfer = [...decoded.channels, ...decoded.peaks].map((a) => a.buffer);
        break;
      }
      case "loadProject":
        result = loadProjectJson(await loadWasm(), request.json);
        break;
      case "pack": {
        const zip = packArchive(await loadWasm(), request.entries);
        result = zip;
        transfer = [zip.buffer];
        break;
      }
      case "unpack": {
        const entries = unpackArchive(await loadWasm(), new Uint8Array(request.bytes));
        result = entries;
        transfer = entries.map(([, data]) => data.buffer);
        break;
      }
      case "attachCapture":
        capture = new CaptureRing(request.ring, request.capacity);
        // Keep the ring empty while not recording, so stale audio never piles up.
        clearInterval(idleTimer);
        idleTimer = setInterval(() => !recording && capture?.drain(() => {}), 250) as unknown as number;
        break;
      case "recordStart":
        await startRecording(request.projectId, request.prefix, request.sampleRate);
        break;
      case "recordStop":
        result = await stopRecording();
        break;
      case "measureLatency": {
        const { samples, sampleRate } = await readTake(request.projectId, request.path);
        result = measureLatency(await loadWasm(), samples, sampleRate, request.bpm);
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
