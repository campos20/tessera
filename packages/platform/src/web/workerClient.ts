import type { WorkerRequest, WorkerResponse, WorkerResults } from "./backgroundWorker";

type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void };

/** A request without its id (distributes over the union so each kind keeps its fields). */
type Request = WorkerRequest extends infer R ? (R extends WorkerRequest ? Omit<R, "id"> : never) : never;

/** Lazily started background worker (worker.wasm) with promise-based requests. */
export class WorkerClient {
  private worker: Worker | undefined;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();

  call<R extends Request>(request: R, transfer: Transferable[] = []): Promise<WorkerResults[R["kind"]]> {
    const worker = this.start();
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      worker.postMessage({ ...request, id }, transfer);
    });
  }

  private start(): Worker {
    if (!this.worker) {
      this.worker = new Worker(new URL("./backgroundWorker.ts", import.meta.url), { type: "module" });
      this.worker.onmessage = (e: MessageEvent<WorkerResponse>) => {
        const response = e.data;
        const pending = this.pending.get(response.id);
        this.pending.delete(response.id);
        if (response.ok) pending?.resolve(response.result);
        else pending?.reject(new Error(response.error));
      };
    }
    return this.worker;
  }
}
