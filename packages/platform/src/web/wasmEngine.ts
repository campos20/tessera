/** Typed view of the raw C ABI exported by `crates/engine-wasm`. Pointers are byte offsets. */
export interface EngineExports {
  memory: WebAssembly.Memory;
  tessera_create(sampleRate: number): number;
  tessera_destroy(handle: number): void;
  tessera_command_args(handle: number): number;
  tessera_command(handle: number, op: number): number;
  tessera_process(handle: number, frames: number): number;
  tessera_output(handle: number, channel: number): number;
  tessera_event_args(handle: number): number;
  tessera_poll_event(handle: number): number;
  tessera_source_create(channels: number, frames: number): number;
  tessera_source_channel(pending: number, channel: number): number;
  tessera_source_commit(handle: number, pending: number, source: number): number;
  tessera_source_discard(pending: number): void;
  tessera_collect_garbage(handle: number): number;
}

/** Instantiates the engine module. It has no imports, so this works synchronously. */
export function instantiateEngine(module: WebAssembly.Module): EngineExports {
  return new WebAssembly.Instance(module, {}).exports as unknown as EngineExports;
}
