import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type {
  AudioConfig,
  AudioDeviceList,
  AudioInfo,
  Command,
  Event,
  Note,
  SourceInfo,
  TakeProgress,
  TuneAnalysis,
} from "@tessera/schema";
import type { RecordedTake as NativeTake } from "@tessera/schema";
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
import { TauriStorage } from "./storage";

/** Must match the event names emitted by apps/desktop/src-tauri. */
const ENGINE_EVENTS = "engine-events";
const RECORDING_PROGRESS = "recording-progress";
const AUDIO_XRUNS = "audio-xruns";

/** Desktop edition: engine-native runs in the Tauri backend; this forwards over IPC. */
export class TauriPlatform implements AudioPlatform {
  readonly edition = "desktop";
  readonly capabilities: PlatformCapabilities = {
    plugins: false, // VST3/CLAP hosting lands in M7.
    outputDeviceSelection: true,
    midi: false, // midir lands in M6.
    settings: { host: true, outputDevice: true, inputDevice: true, sampleRate: true, bufferSize: true },
  };
  readonly storage: ProjectStorage = new TauriStorage();
  /** Sessions live in the backend, which hands rendered regions straight to the engine. */
  readonly tune: TuneService = {
    open: async (sessionId, projectId, path) => {
      await this.start();
      return invoke<TuneAnalysis>("tune_open", { sessionId, projectId, path });
    },
    plan: (sessionId, notes: Note[]) => invoke<TunePlan>("tune_plan", { sessionId, notes }),
    close: (sessionId) => invoke("tune_close", { sessionId }),
  };

  private starting: Promise<EngineInfo> | undefined;
  private started = false;
  private pending: Command[] = [];
  private readonly listeners = new Set<EngineEventListener>();
  private readonly progressListeners = new Set<(p: TakeProgress) => void>();
  private readonly xrunListeners = new Set<(count: number) => void>();
  private listening: Promise<void> | undefined;

  start(): Promise<EngineInfo> {
    this.starting ??= this.init().catch((e: unknown) => {
      this.starting = undefined;
      throw e;
    });
    return this.starting;
  }

  send(command: Command): void {
    if (!this.started) {
      this.pending.push(command);
      return;
    }
    invoke("audio_send", { command }).catch((e: unknown) => console.error("tessera: audio_send failed", e));
  }

  onEvent(listener: EngineEventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  onRecordingProgress(listener: (progress: TakeProgress) => void): () => void {
    this.progressListeners.add(listener);
    return () => this.progressListeners.delete(listener);
  }

  onXruns(listener: (count: number) => void): () => void {
    this.xrunListeners.add(listener);
    return () => this.xrunListeners.delete(listener);
  }

  async importAudio(file: File): Promise<SourceInfo> {
    await this.start();
    // Sent as a raw IPC body (no JSON encoding of the samples); decoded in the backend.
    const bytes = new Uint8Array(await file.arrayBuffer());
    return invoke<SourceInfo>("import_audio", bytes, {
      headers: { "x-file-name": encodeURIComponent(file.name) },
    });
  }

  listDevices(): Promise<AudioDeviceList> {
    return invoke<AudioDeviceList>("list_devices");
  }

  async configureAudio(settings: AudioSettings): Promise<{ info: EngineInfo; restarted: boolean }> {
    await this.listen();
    const config: AudioConfig = {
      host: settings.host ?? null,
      outputDevice: settings.outputDevice ?? null,
      inputDevice: settings.inputDevice ?? null,
      sampleRate: settings.sampleRate ?? null,
      bufferSize: settings.bufferSize ?? null,
    };
    const info = engineInfo(await invoke<AudioInfo>("audio_configure", { config }));
    this.started = true;
    this.starting = Promise.resolve(info);
    this.flushPending();
    return { info, restarted: true };
  }

  async beginRecording(projectId: string): Promise<void> {
    await invoke("recording_begin", { projectId, prefix: `rec-${crypto.randomUUID().slice(0, 8)}` });
  }

  async endRecording(): Promise<RecordedTake[]> {
    const takes = await invoke<NativeTake[]>("recording_end");
    return takes.map((t) => ({
      track: t.track,
      path: `audio/${t.file}`,
      start: t.start,
      frames: t.frames,
      channels: t.channels,
    }));
  }

  measureLatency(projectId: string, path: string, bpm: number): Promise<LatencyMeasurement | null> {
    return invoke("measure_latency", { projectId, path, bpm });
  }

  async diagnostics(): Promise<Diagnostics> {
    const info = await invoke<AudioInfo | null>("audio_info");
    const d: Diagnostics = { edition: this.edition };
    if (info) {
      d.host = info.host;
      d.output = info.outputDevice;
      d.input = info.inputDevice ?? "none";
      d.sampleRate = info.sampleRate;
      d.bufferSize = info.bufferSize ?? "default";
      d.sampleFormat = info.sampleFormat;
    }
    return d;
  }

  private listen(): Promise<void> {
    this.listening ??= Promise.all([
      listen<Event[]>(ENGINE_EVENTS, (e) => {
        for (const event of e.payload) for (const listener of this.listeners) listener(event);
      }),
      listen<TakeProgress[]>(RECORDING_PROGRESS, (e) => {
        for (const p of e.payload) for (const listener of this.progressListeners) listener(p);
      }),
      listen<number>(AUDIO_XRUNS, (e) => {
        for (const listener of this.xrunListeners) listener(e.payload);
      }),
    ]).then(() => undefined);
    return this.listening;
  }

  private async init(): Promise<EngineInfo> {
    await this.listen();
    const info = engineInfo(await invoke<AudioInfo>("audio_start"));
    this.started = true;
    this.flushPending();
    return info;
  }

  private flushPending() {
    const pending = this.pending;
    this.pending = [];
    for (const command of pending) this.send(command);
  }
}

function engineInfo(info: AudioInfo): EngineInfo {
  // Until calibrated: input + output buffers plus a typical converter/driver allowance.
  const buffer = info.bufferSize ?? 512;
  return {
    sampleRate: info.sampleRate,
    inputChannels: info.inputChannels,
    latencyEstimate: Math.round(2 * buffer + 0.003 * info.sampleRate),
    bufferSize: info.bufferSize ?? undefined,
  };
}
