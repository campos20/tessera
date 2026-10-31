/** Typed view of the raw C ABI exported by `crates/engine-wasm`. */
export interface EngineExports {
  memory: WebAssembly.Memory;
  tessera_create(sampleRate: number): number;
  tessera_destroy(handle: number): void;
  tessera_command(handle: number, op: number, value: number): number;
  tessera_process(handle: number, frames: number): number;
  tessera_peak(handle: number): number;
}

/** Instantiates the engine module. It has no imports, so this works synchronously. */
export function instantiateEngine(module: WebAssembly.Module): EngineExports {
  return new WebAssembly.Instance(module, {}).exports as unknown as EngineExports;
}
