/** Typed view of the raw C ABI exported by `crates/media-wasm`, plus a safe wrapper. */
export interface MediaExports {
  memory: WebAssembly.Memory;
  media_alloc(len: number): number;
  media_free(ptr: number, len: number): void;
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

/** Decodes, resamples and summarizes a file. Throws with the decoder's message on failure. */
export function decodeWithMedia(
  m: MediaExports,
  bytes: Uint8Array,
  extension: string | undefined,
  targetRate: number,
): DecodedAudio {
  // Memory can grow on every call, so views are always taken from the current buffer.
  const copyIn = (data: Uint8Array) => {
    const ptr = m.media_alloc(data.length);
    new Uint8Array(m.memory.buffer, ptr, data.length).set(data);
    return ptr;
  };
  const ext = extension ? new TextEncoder().encode(extension) : undefined;
  const extPtr = ext ? copyIn(ext) : 0;
  const dataPtr = copyIn(bytes);
  const handle = m.media_import(dataPtr, bytes.length, extPtr, ext?.length ?? 0, targetRate);
  if (ext) m.media_free(extPtr, ext.length);

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

/** Lowercased file extension used as a decoder hint (the content is probed regardless). */
export function extensionOf(name: string): string | undefined {
  const dot = name.lastIndexOf(".");
  const ext = dot >= 0 ? name.slice(dot + 1).toLowerCase() : "";
  return ext && ext.length <= 5 ? ext : undefined;
}
