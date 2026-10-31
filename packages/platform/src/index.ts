import type { AudioDeviceList, Command, Event } from "@tessera/schema";

export type Edition = "web" | "desktop";

export interface PlatformCapabilities {
  /** Third-party plugin hosting (VST3/CLAP). Desktop only, from M7. */
  plugins: boolean;
  /** The output device can be chosen from inside the app. */
  outputDeviceSelection: boolean;
  /** MIDI input is available. */
  midi: boolean;
}

export type Diagnostics = Record<string, string | number | boolean>;

export type EngineEventListener = (event: Event) => void;

/**
 * Everything the UI may ask of the audio engine. The UI never imports Web Audio or Tauri
 * APIs directly; it only sees this interface.
 */
export interface AudioPlatform {
  readonly edition: Edition;
  readonly capabilities: PlatformCapabilities;
  /**
   * Starts the audio engine. On the web this must run from a user gesture. Safe to call
   * more than once.
   */
  start(): Promise<void>;
  /** Sends a command to the engine. Commands sent before `start()` are queued. */
  send(command: Command): void;
  /** Subscribes to engine events. Returns an unsubscribe function. */
  onEvent(listener: EngineEventListener): () => void;
  listDevices(): Promise<AudioDeviceList>;
  /** Edition-specific facts for the status panel (sample rate, isolation, host, ...). */
  diagnostics(): Promise<Diagnostics>;
}
