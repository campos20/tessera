import {
  type AudioDeviceList,
  type Command,
  MAX_ARGS,
  type Note,
  type PlannedSegment,
  type SourceInfo,
  type TakeProgress,
  type TuneAnalysis,
} from "@tessera/schema";
import type {
  AudioPlatform,
  AudioSettings,
  Diagnostics,
  EngineEventListener,
  EngineInfo,
  LatencyMeasurement,
  PlatformCapabilities,
  ProjectStorage,
  RecordedTake,
  TunePlan,
  TuneService,
} from "../index";
import { CaptureRing } from "./captureRing";
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
    outputDeviceSelection: canSetSink(),
    midi: typeof navigator !== "undefined" && "requestMIDIAccess" in navigator,
    settings: {
      host: false,
      outputDevice: canSetSink(),
      inputDevice: true,
      sampleRate: false,
      bufferSize: false,
    },
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
  private input: { stream: MediaStream; source: MediaStreamAudioSourceNode } | undefined;
  private readonly progressListeners = new Set<(p: TakeProgress) => void>();
  readonly storage: ProjectStorage = new OpfsStorage(this.worker);
  /** Engine sources of rendered Tune regions, per session, by region key. */
  private readonly tuneSources = new Map<string, Map<string, number>>();
  readonly tune: TuneService = {
    open: async (sessionId, projectId, path) => {
      await this.init();
      const json = await this.worker.call({
        kind: "tuneOpen",
        sessionId,
        projectId,
        path,
        targetRate: this.ctx!.sampleRate,
      });
      this.tuneSources.set(sessionId, this.tuneSources.get(sessionId) ?? new Map());
      return JSON.parse(json) as TuneAnalysis;
    },
    plan: async (sessionId, notes: Note[]): Promise<TunePlan> => {
      const sources = this.tuneSources.get(sessionId);
      if (!sources) throw new Error("tune session is not open");
      const { plan, regions } = await this.worker.call({
        kind: "tunePlan",
        sessionId,
        notesJson: JSON.stringify(notes),
        knownJson: JSON.stringify([...sources.keys()]),
      });
      const parsed = JSON.parse(plan) as {
        segments: PlannedSegment[];
        outputFrames: number;
        regions: { key: string }[];
      };
      // Upload only the regions this plan rendered; earlier ones are already in the engine.
      for (const [i, region] of parsed.regions.entries()) {
        const audio = regions[i]!;
        sources.set(region.key, await this.uploadSource(audio, audio[0]?.length ?? 0));
      }
      const used: Record<string, number> = {};
      for (const seg of parsed.segments) if (seg.kind === "rendered") used[seg.key] = sources.get(seg.key)!;
      return { segments: parsed.segments, outputFrames: parsed.outputFrames, sources: used };
    },
    close: async (sessionId) => {
      await this.worker.call({ kind: "tuneClose", sessionId });
      for (const id of this.tuneSources.get(sessionId)?.values() ?? [])
        this.send({ type: "RemoveSource", source: id });
      this.tuneSources.delete(sessionId);
    },
  };

  async start(): Promise<EngineInfo> {
    await this.init();
    await this.ctx!.resume();
    return this.engineInfo();
  }

  async configureAudio(settings: AudioSettings): Promise<{ info: EngineInfo; restarted: boolean }> {
    await this.init();
    const ctx = this.ctx!;
    if (this.capabilities.settings.outputDevice) {
      const sinkId =
        !settings.outputDevice || settings.outputDevice === "default" ? "" : settings.outputDevice;
      await (ctx as AudioContext & { setSinkId(id: string): Promise<void> }).setSinkId(sinkId);
    }
    this.input?.source.disconnect();
    this.input?.stream.getTracks().forEach((t) => t.stop());
    this.input = undefined;
    if (settings.inputDevice) {
      // Raw input: browser voice processing would color and delay the recording.
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          deviceId: settings.inputDevice === "default" ? undefined : { exact: settings.inputDevice },
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
          channelCount: { ideal: 2 },
        },
      });
      const source = ctx.createMediaStreamSource(stream);
      source.connect(this.node!);
      this.input = { stream, source };
    }
    return { info: this.engineInfo(), restarted: false };
  }

  async beginRecording(projectId: string): Promise<void> {
    await this.init();
    await this.worker.call({
      kind: "recordStart",
      projectId,
      prefix: `rec-${crypto.randomUUID().slice(0, 8)}`,
      sampleRate: this.ctx!.sampleRate,
    });
  }

  endRecording(): Promise<RecordedTake[]> {
    return this.worker.call({ kind: "recordStop" });
  }

  onRecordingProgress(listener: (progress: TakeProgress) => void): () => void {
    this.progressListeners.add(listener);
    return () => this.progressListeners.delete(listener);
  }

  /** Browsers don't report dropouts. */
  onXruns(): () => void {
    return () => {};
  }

  measureLatency(projectId: string, path: string, bpm: number): Promise<LatencyMeasurement | null> {
    return this.worker.call({ kind: "measureLatency", projectId, path, bpm });
  }

  private engineInfo(): EngineInfo {
    const ctx = this.ctx!;
    const settings = this.input?.stream.getAudioTracks()[0]?.getSettings() as
      (MediaTrackSettings & { latency?: number }) | undefined;
    const inputLatency = settings?.latency ?? 0.01;
    return {
      sampleRate: ctx.sampleRate,
      inputChannels: this.input ? Math.min(2, settings?.channelCount ?? 1) : 0,
      latencyEstimate: Math.round(
        (ctx.baseLatency + (ctx.outputLatency || 0) + inputLatency) * ctx.sampleRate,
      ),
      bufferSize: 128,
    };
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
    await this.uploadSourceAs(id, channels, frames);

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

  /** Hands planar audio (at the engine rate) to the engine as a new source; returns its id. */
  private async uploadSource(channels: Float32Array[], frames: number): Promise<number> {
    await this.init();
    const id = this.nextSourceId++;
    await this.uploadSourceAs(id, channels, frames);
    return id;
  }

  /** Copies audio into the worklet in acknowledged chunks (never inside `process()`). */
  private async uploadSourceAs(id: number, channels: Float32Array[], frames: number): Promise<void> {
    await this.request({ type: "source-begin", id, channels: channels.length, frames });
    for (let offset = 0; offset < frames; offset += SOURCE_CHUNK_FRAMES) {
      const data = channels.map((c) => c.slice(offset, offset + SOURCE_CHUNK_FRAMES));
      await this.request(
        { type: "source-chunk", id, offset, data },
        data.map((d) => d.buffer),
      );
    }
    await this.request({ type: "source-end", id });
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
            id: d.deviceId,
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
    const capture = CaptureRing.create();
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
        capture: capture.buffer,
        captureCapacity: capture.capacity,
      };
      const node = new AudioWorkletNode(ctx, PROCESSOR_NAME, {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [2],
        processorOptions,
      });
      node.port.onmessage = (e: MessageEvent<WorkletReply>) => this.onWorkletReply(e.data);
      node.connect(ctx.destination);
      this.ctx = ctx;
      this.node = node;
      this.events = events;
      await this.worker.call({ kind: "attachCapture", ring: capture.buffer, capacity: capture.capacity });
      this.worker.onEvent((e) => {
        if (e.event === "recordProgress")
          for (const p of e.progress) for (const l of this.progressListeners) l(p);
      });
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

function canSetSink(): boolean {
  return typeof AudioContext !== "undefined" && "setSinkId" in AudioContext.prototype;
}

function round(x: number): number {
  return Math.round(x * 10) / 10;
}
