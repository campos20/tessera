/** Typed view of the raw C ABI exported by `crates/worker-wasm`, plus safe wrappers. */
export interface WorkerExports {
  memory: WebAssembly.Memory;
  worker_alloc(len: number): number;
  worker_free(ptr: number, len: number): void;
  media_import(data: number, dataLen: number, ext: number, extLen: number, targetRate: number): number;
  media_result_ok(handle: number): number;
  media_result_error_ptr(handle: number): number;
  media_result_error_len(handle: number): number;
  media_result_channels(handle: number): number;
  media_result_frames(handle: number): number;
  media_result_original_rate(handle: number): number;
  media_result_channel_ptr(handle: number, channel: number): number;
  media_result_frames_per_peak(handle: number): number;
  media_result_peaks_len(handle: number, channel: number): number;
  media_result_peaks_ptr(handle: number, channel: number): number;
  media_result_free(handle: number): void;
  project_load(data: number, len: number): number;
  archive_pack(data: number, len: number): number;
  archive_unpack(data: number, len: number): number;
  bytes_result_ok(handle: number): number;
  bytes_result_ptr(handle: number): number;
  bytes_result_len(handle: number): number;
  bytes_result_free(handle: number): void;
  calibration_measure(
    samples: number,
    frames: number,
    sampleRate: number,
    bpm: number,
    maxLag: number,
    out: number,
  ): number;
}

export interface DecodedAudio {
  /** Planar samples at the requested rate. */
  channels: Float32Array[];
  frames: number;
  originalSampleRate: number;
  framesPerPeak: number;
  /** Per channel: `[min0, max0, min1, max1, ...]`. */
  peaks: Float32Array[];
}

// Memory can grow on every call, so views are always taken from the current buffer.
function copyIn(m: WorkerExports, data: Uint8Array): number {
  const ptr = m.worker_alloc(data.length);
  new Uint8Array(m.memory.buffer, ptr, data.length).set(data);
  return ptr;
}

/** Decodes, resamples and summarizes a file. Throws with the decoder's message on failure. */
export function decodeAudio(
  m: WorkerExports,
  bytes: Uint8Array,
  extension: string | undefined,
  targetRate: number,
): DecodedAudio {
  const ext = extension ? new TextEncoder().encode(extension) : undefined;
  const extPtr = ext ? copyIn(m, ext) : 0;
  const handle = m.media_import(copyIn(m, bytes), bytes.length, extPtr, ext?.length ?? 0, targetRate);
  if (ext) m.worker_free(extPtr, ext.length);
  try {
    if (!m.media_result_ok(handle)) {
      const msg = new Uint8Array(
        m.memory.buffer,
        m.media_result_error_ptr(handle),
        m.media_result_error_len(handle),
      );
      throw new Error(new TextDecoder().decode(msg));
    }
    const count = m.media_result_channels(handle);
    const frames = m.media_result_frames(handle);
    const channels: Float32Array[] = [];
    const peaks: Float32Array[] = [];
    for (let ch = 0; ch < count; ch++) {
      channels.push(
        new Float32Array(m.memory.buffer, m.media_result_channel_ptr(handle, ch), frames).slice(),
      );
      const len = m.media_result_peaks_len(handle, ch);
      peaks.push(new Float32Array(m.memory.buffer, m.media_result_peaks_ptr(handle, ch), len).slice());
    }
    return {
      channels,
      frames,
      originalSampleRate: m.media_result_original_rate(handle),
      framesPerPeak: m.media_result_frames_per_peak(handle),
      peaks,
    };
  } finally {
    m.media_result_free(handle);
  }
}

/** Calls a `bytes in → bytes out` export; throws with its message on failure. */
function callBytes(
  m: WorkerExports,
  fn: (ptr: number, len: number) => number,
  input: Uint8Array,
): Uint8Array {
  const handle = fn(copyIn(m, input), input.length);
  try {
    const out = new Uint8Array(
      m.memory.buffer,
      m.bytes_result_ptr(handle),
      m.bytes_result_len(handle),
    ).slice();
    if (!m.bytes_result_ok(handle)) throw new Error(new TextDecoder().decode(out));
    return out;
  } finally {
    m.bytes_result_free(handle);
  }
}

/** Migrates and validates a saved `project.json`; returns current-schema JSON. */
export function loadProjectJson(m: WorkerExports, json: string): string {
  return new TextDecoder().decode(callBytes(m, m.project_load, new TextEncoder().encode(json)));
}

export type ArchiveEntry = [path: string, data: Uint8Array];

/** Builds a `.tessera` archive. */
export function packArchive(m: WorkerExports, entries: ArchiveEntry[]): Uint8Array {
  const encoder = new TextEncoder();
  const names = entries.map(([name]) => encoder.encode(name));
  const size = entries.reduce((n, [, data], i) => n + 8 + names[i]!.length + data.length, 0);
  const framed = new Uint8Array(size);
  const view = new DataView(framed.buffer);
  let pos = 0;
  entries.forEach(([, data], i) => {
    const name = names[i]!;
    view.setUint32(pos, name.length, true);
    framed.set(name, pos + 4);
    pos += 4 + name.length;
    view.setUint32(pos, data.length, true);
    framed.set(data, pos + 4);
    pos += 4 + data.length;
  });
  return callBytes(m, m.archive_pack, framed);
}

/** Reads a `.tessera` archive. Paths are validated by the Rust side. */
export function unpackArchive(m: WorkerExports, bytes: Uint8Array): ArchiveEntry[] {
  const framed = callBytes(m, m.archive_unpack, bytes);
  const view = new DataView(framed.buffer);
  const decoder = new TextDecoder();
  const entries: ArchiveEntry[] = [];
  let pos = 0;
  while (pos < framed.length) {
    const nameLen = view.getUint32(pos, true);
    const name = decoder.decode(framed.subarray(pos + 4, pos + 4 + nameLen));
    pos += 4 + nameLen;
    const dataLen = view.getUint32(pos, true);
    entries.push([name, framed.slice(pos + 4, pos + 4 + dataLen)]);
    pos += 4 + dataLen;
  }
  return entries;
}

/**
 * Measures round-trip latency from a mono calibration take recorded from timeline frame 0
 * while the metronome played at `bpm`. `null` when nothing recognizable was recorded.
 */
export function measureLatency(
  m: WorkerExports,
  samples: Float32Array,
  sampleRate: number,
  bpm: number,
): { frames: number; confidence: number } | null {
  const bytes = new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength);
  const ptr = m.worker_alloc(bytes.length);
  new Uint8Array(m.memory.buffer, ptr, bytes.length).set(bytes);
  const out = m.worker_alloc(16);
  try {
    const ok = m.calibration_measure(ptr, samples.length, sampleRate, bpm, Math.round(sampleRate / 2), out);
    const [frames, confidence] = new Float64Array(m.memory.buffer.slice(out, out + 16));
    return ok ? { frames: frames!, confidence: confidence! } : null;
  } finally {
    m.worker_free(ptr, bytes.length);
    m.worker_free(out, 16);
  }
}

/** Lowercased file extension used as a decoder hint (the content is probed regardless). */
export function extensionOf(name: string): string | undefined {
  const dot = name.lastIndexOf(".");
  const ext = dot >= 0 ? name.slice(dot + 1).toLowerCase() : "";
  return ext && ext.length <= 5 ? ext : undefined;
}
