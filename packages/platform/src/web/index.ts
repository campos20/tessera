import { type AudioDeviceList, type Command, MAX_ARGS, type SourceInfo } from "@tessera/schema";
import type {
  AudioPlatform,
  Diagnostics,
  EngineEventListener,
  EngineInfo,
  PlatformCapabilities,
  ProjectStorage,
} from "../index";
import { decodeEvent, encodeCommand } from "./codec";
import { MessageRing } from "./messageRing";
import {
  PROCESSOR_NAME,
  type ProcessorOptions,
  SOURCE_CHUNK_FRAMES,
  type WorkletReply,
  type WorkletRequest,
} from "./protocol";
import { OpfsStorage } from "./storage";
import { WorkerClient } from "./workerClient";
import { extensionOf } from "./workerWasm";
import wasmUrl from "./engine.wasm?url";
import workletUrl from "./worklet.ts?worker&url";

const RING_CAPACITY = 1024;
const GC_INTERVAL_MS = 1000;

type Pending<T> = { resolve: (value: T) => void; reject: (error: Error) => void };

/** Distributes `Omit` over a union, so each request variant keeps its own fields. */
type WithoutSeq<T> = T extends unknown ? Omit<T, "seq"> : never;

/** Web edition: AudioWorklet running engine-wasm, fed through SharedArrayBuffer rings. */
export class WebPlatform implements AudioPlatform {
  readonly edition = "web";
  readonly capabilities: PlatformCapabilities = {
    plugins: false,
    outputDeviceSelection: typeof AudioContext !== "undefined" && "setSinkId" in AudioContext.prototype,
    midi: typeof navigator !== "undefined" && "requestMIDIAccess" in navigator,
  };

  private ctx: AudioContext | undefined;
  private node: AudioWorkletNode | undefined;
  private initializing: Promise<void> | undefined;
  private commands: MessageRing | undefined;
  private readonly commandArgs = new Float64Array(MAX_ARGS);
  private events: MessageRing | undefined;
  private readonly listeners = new Set<EngineEventListener>();
  private pollHandle = 0;
  private warnedNotIsolated = false;

  private nextSeq = 1;
  private readonly workletRequests = new Map<number, Pending<void>>();
  private readonly worker = new WorkerClient();
  private nextSourceId = 1;
  readonly storage: ProjectStorage = new OpfsStorage(this.worker);

  async start(): Promise<EngineInfo> {
    await this.init();
    await this.ctx!.resume();
    return { sampleRate: this.ctx!.sampleRate };
  }

  send(command: Command): void {
    // Without cross-origin isolation there is no engine to talk to. Don't throw from here:
    // `start()` reports the problem, and on hosts using coi-sw.js the page reloads isolated.
    if (!globalThis.crossOriginIsolated) {
      if (!this.warnedNotIsolated)
        console.warn("tessera: not cross-origin isolated; engine commands are dropped");
      this.warnedNotIsolated = true;
      return;
    }
    const op = encodeCommand(command, this.commandArgs);
    if (!this.commandRing().push(op, this.commandArgs)) {
      console.warn("tessera: command ring full, dropped", command);
    }
  }

  onEvent(listener: EngineEventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async importAudio(file: File): Promise<SourceInfo> {
    // Creating the context doesn't need a user gesture; only resuming it does.
    await this.init();
    const sampleRate = this.ctx!.sampleRate;
    const id = this.nextSourceId++;
    const bytes = await file.arrayBuffer();
    const decoded = await this.worker.call(
      { kind: "decode", bytes, extension: extensionOf(file.name), targetRate: sampleRate },
      [bytes],
    );

    const { channels, frames } = decoded;
    await this.request({ type: "source-begin", id, channels: channels.length, frames });
    for (let offset = 0; offset < frames; offset += SOURCE_CHUNK_FRAMES) {
      const data = channels.map((c) => c.slice(offset, offset + SOURCE_CHUNK_FRAMES));
      await this.request(
        { type: "source-chunk", id, offset, data },
        data.map((d) => d.buffer),
      );
    }
    await this.request({ type: "source-end", id });

    return {
      id,
      name: file.name,
      frames,
      channels: channels.length,
      sampleRate,
      originalSampleRate: decoded.originalSampleRate,
      peaks: { framesPerPeak: decoded.framesPerPeak, data: decoded.peaks.map((p) => Array.from(p)) },
    };
  }

  async listDevices(): Promise<AudioDeviceList> {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const audio = devices.filter((d) => d.kind === "audioinput" || d.kind === "audiooutput");
    return {
      hosts: [
        {
          name: "Web Audio",
          isDefault: true,
          error: null,
          devices: audio.map((d) => ({
            id: `${d.kind}:${d.deviceId}`,
            // Labels stay empty until the page has microphone permission (M3).
            name:
              d.label ||
              (d.kind === "audioinput" ? "Input" : "Output") + (d.deviceId === "default" ? " (default)" : ""),
            // Browsers don't report channel counts; assume stereo.
            maxInputChannels: d.kind === "audioinput" ? 2 : 0,
            maxOutputChannels: d.kind === "audiooutput" ? 2 : 0,
            isDefaultInput: d.kind === "audioinput" && d.deviceId === "default",
            isDefaultOutput: d.kind === "audiooutput" && d.deviceId === "default",
          })),
        },
      ],
    };
  }

  async diagnostics(): Promise<Diagnostics> {
    const d: Diagnostics = {
      edition: this.edition,
      crossOriginIsolated: globalThis.crossOriginIsolated === true,
    };
    if (this.ctx) {
      d.sampleRate = this.ctx.sampleRate;
      d.state = this.ctx.state;
      d.baseLatencyMs = round(this.ctx.baseLatency * 1000);
      d.outputLatencyMs = round(this.ctx.outputLatency * 1000);
    }
    return d;
  }

  private commandRing(): MessageRing {
    if (!this.commands) {
      if (!globalThis.crossOriginIsolated) {
        throw new Error("Tessera needs cross-origin isolation (COOP/COEP headers) for SharedArrayBuffer.");
      }
      this.commands = MessageRing.create(RING_CAPACITY);
    }
    return this.commands;
  }

  private init(): Promise<void> {
    this.initializing ??= this.createEngine().catch((e: unknown) => {
      this.initializing = undefined;
      throw e;
    });
    return this.initializing;
  }

  private async createEngine(): Promise<void> {
    const commands = this.commandRing();
    const events = MessageRing.create(RING_CAPACITY);
    // Run at the output device's native rate (like the desktop edition). Forcing a rate makes the
    // browser resample the output, and resampling loud material creates inter-sample overs that
    // clip at the destination.
    const ctx = new AudioContext({ latencyHint: "interactive" });
    try {
      const [module] = await Promise.all([
        WebAssembly.compileStreaming(fetch(wasmUrl)),
        ctx.audioWorklet.addModule(workletUrl),
      ]);
      const processorOptions: ProcessorOptions = {
        module,
        commands: commands.buffer,
        events: events.buffer,
        ringCapacity: RING_CAPACITY,
      };
      const node = new AudioWorkletNode(ctx, PROCESSOR_NAME, {
        numberOfInputs: 0,
        numberOfOutputs: 1,
        outputChannelCount: [2],
        processorOptions,
      });
      node.port.onmessage = (e: MessageEvent<WorkletReply>) => this.onWorkletReply(e.data);
      node.connect(ctx.destination);
      this.ctx = ctx;
      this.node = node;
      this.events = events;
      this.pollEvents();
      // Released audio is freed in the worklet's message handler, never in process().
      setInterval(() => void this.request({ type: "gc" }).catch(() => {}), GC_INTERVAL_MS);
    } catch (e) {
      await ctx.close();
      throw e;
    }
  }

  /** Sends a request to the worklet and resolves when it acknowledges it. */
  private request(message: WithoutSeq<WorkletRequest>, transfer: Transferable[] = []): Promise<void> {
    const seq = this.nextSeq++;
    return new Promise((resolve, reject) => {
      this.workletRequests.set(seq, { resolve, reject });
      this.node!.port.postMessage({ ...message, seq }, transfer);
    });
  }

  private onWorkletReply(reply: WorkletReply) {
    if (reply.type !== "ack") return;
    const pending = this.workletRequests.get(reply.seq);
    this.workletRequests.delete(reply.seq);
    if (reply.ok) pending?.resolve();
    else pending?.reject(new Error(reply.error ?? "worklet request failed"));
  }

  /** Delivers engine events from the worklet's ring, once per animation frame. */
  private pollEvents(): void {
    const tick = () => {
      this.events?.drain((op, args, base) => {
        const event = decodeEvent(op, args, base);
        if (event) for (const listener of this.listeners) listener(event);
      });
      this.pollHandle = requestAnimationFrame(tick);
    };
    cancelAnimationFrame(this.pollHandle);
    this.pollHandle = requestAnimationFrame(tick);
  }
}

function round(x: number): number {
  return Math.round(x * 10) / 10;
}
