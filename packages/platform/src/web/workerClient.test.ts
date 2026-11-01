import { describe, expect, it } from "vitest";
import type { WorkerResponse } from "./backgroundWorker";
import { WorkerClient, type WorkerLike } from "./workerClient";

class FakeWorker implements WorkerLike {
  onmessage: ((e: MessageEvent<WorkerResponse>) => void) | null = null;
  onerror: ((e: ErrorEvent) => void) | null = null;
  onmessageerror: ((e: MessageEvent) => void) | null = null;
  posted: { id: number }[] = [];
  terminated = false;
  postMessage(message: { id: number }) {
    this.posted.push(message);
  }
  terminate() {
    this.terminated = true;
  }
  reply(response: WorkerResponse) {
    this.onmessage?.({ data: response } as MessageEvent<WorkerResponse>);
  }
  crash(message: string) {
    this.onerror?.({ message, preventDefault() {} } as ErrorEvent);
  }
}

describe("WorkerClient", () => {
  it("resolves and rejects requests by id", async () => {
    const workers: FakeWorker[] = [];
    const client = new WorkerClient(() => workers[workers.push(new FakeWorker()) - 1]!);
    const a = client.call({ kind: "loadProject", json: "{}" });
    const b = client.call({ kind: "loadProject", json: "{}" });
    const [first, second] = workers[0]!.posted;
    workers[0]!.reply({ id: second!.id, ok: false, error: "bad" });
    workers[0]!.reply({ id: first!.id, ok: true, result: "ok" });
    await expect(a).resolves.toBe("ok");
    await expect(b).rejects.toThrow("bad");
  });

  it("rejects pending requests when the worker dies and restarts on the next call", async () => {
    const workers: FakeWorker[] = [];
    const client = new WorkerClient(() => workers[workers.push(new FakeWorker()) - 1]!);
    const pending = client.call({ kind: "loadProject", json: "{}" });
    workers[0]!.crash("RuntimeError: unreachable");
    await expect(pending).rejects.toThrow("The background worker stopped: RuntimeError: unreachable");
    expect(workers[0]!.terminated).toBe(true);

    const next = client.call({ kind: "loadProject", json: "{}" });
    expect(workers).toHaveLength(2);
    workers[1]!.reply({ id: workers[1]!.posted[0]!.id, ok: true, result: "fresh" });
    await expect(next).resolves.toBe("fresh");
  });
});
