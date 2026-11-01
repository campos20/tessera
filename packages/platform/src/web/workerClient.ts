import type { WorkerRequest, WorkerResponse, WorkerResults } from "./backgroundWorker";

export type WorkerEvent = Extract<WorkerResponse, { event: string }>;

type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void };

/** A request without its id (distributes over the union so each kind keeps its fields). */
type Request = WorkerRequest extends infer R ? (R extends WorkerRequest ? Omit<R, "id"> : never) : never;

/** The part of `Worker` this client uses (so tests can substitute a fake). */
export type WorkerLike = Pick<Worker, "postMessage" | "terminate"> & {
  onmessage: ((e: MessageEvent<WorkerResponse>) => void) | null;
  onerror: ((e: ErrorEvent) => void) | null;
  onmessageerror: ((e: MessageEvent) => void) | null;
};

const createBackgroundWorker = (): WorkerLike =>
  new Worker(new URL("./backgroundWorker.ts", import.meta.url), { type: "module" }) as WorkerLike;

/**
 * Lazily started background worker (worker.wasm) with promise-based requests. If the worker
 * dies (e.g. a WASM trap), every pending request is rejected and the next call starts a
 * fresh worker, so no request is left hanging.
 */
export class WorkerClient {
  private worker: WorkerLike | undefined;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly eventListeners = new Set<(event: WorkerEvent) => void>();

  constructor(private readonly createWorker: () => WorkerLike = createBackgroundWorker) {}

  /** Unsolicited messages from the worker (e.g. recording progress). */
  onEvent(listener: (event: WorkerEvent) => void): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  call<R extends Request>(request: R, transfer: Transferable[] = []): Promise<WorkerResults[R["kind"]]> {
    const worker = this.start();
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      worker.postMessage({ ...request, id }, transfer);
    });
  }

  private start(): WorkerLike {
    if (!this.worker) {
      const worker = this.createWorker();
      worker.onmessage = (e) => {
        const response = e.data;
        if (response.id === undefined) {
          for (const listener of this.eventListeners) listener(response);
          return;
        }
        const pending = this.pending.get(response.id);
        this.pending.delete(response.id);
        if (response.ok) pending?.resolve(response.result);
        else pending?.reject(new Error(response.error));
      };
      worker.onerror = (e) => {
        e.preventDefault?.();
        this.fail(worker, `The background worker stopped: ${e.message || "unknown error"}`);
      };
      worker.onmessageerror = () => this.fail(worker, "The background worker sent an unreadable message.");
      this.worker = worker;
    }
    return this.worker;
  }

  private fail(worker: WorkerLike, message: string) {
    if (this.worker !== worker) return;
    worker.terminate();
    this.worker = undefined;
    const pending = [...this.pending.values()];
    this.pending.clear();
    for (const p of pending) p.reject(new Error(message));
  }
}
