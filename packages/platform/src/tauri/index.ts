import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { AudioDeviceList, Command, Event, OutputInfo } from "@tessera/schema";
import type { AudioPlatform, Diagnostics, EngineEventListener, PlatformCapabilities } from "../index";

/** Must match the event name emitted by apps/desktop/src-tauri. */
const ENGINE_EVENT = "engine-event";

/** Desktop edition: engine-native runs in the Tauri backend; this forwards over IPC. */
export class TauriPlatform implements AudioPlatform {
  readonly edition = "desktop";
  readonly capabilities: PlatformCapabilities = {
    plugins: false, // VST3/CLAP hosting lands in M7.
    outputDeviceSelection: false, // Device settings land in M3.
    midi: false, // midir lands in M6.
  };

  private starting: Promise<void> | undefined;
  private started = false;
  private pending: Command[] = [];
  private readonly listeners = new Set<EngineEventListener>();

  async start(): Promise<void> {
    this.starting ??= this.init().catch((e: unknown) => {
      this.starting = undefined;
      throw e;
    });
    await this.starting;
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

  listDevices(): Promise<AudioDeviceList> {
    return invoke<AudioDeviceList>("list_devices");
  }

  async diagnostics(): Promise<Diagnostics> {
    const info = await invoke<OutputInfo | null>("audio_info");
    const d: Diagnostics = { edition: this.edition };
    if (info) {
      d.host = info.host;
      d.device = info.device;
      d.sampleRate = info.sampleRate;
      d.channels = info.channels;
      d.sampleFormat = info.sampleFormat;
    }
    return d;
  }

  private async init(): Promise<void> {
    await listen<Event>(ENGINE_EVENT, (e) => {
      for (const listener of this.listeners) listener(e.payload);
    });
    await invoke<OutputInfo>("audio_start");
    this.started = true;
    const pending = this.pending;
    this.pending = [];
    for (const command of pending) this.send(command);
  }
}
