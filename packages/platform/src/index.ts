import type { AudioDeviceList, Command, Event, SourceInfo } from "@tessera/schema";

export type Edition = "web" | "desktop";

export interface PlatformCapabilities {
  /** Third-party plugin hosting (VST3/CLAP). Desktop only, from M7. */
  plugins: boolean;
  /** The output device can be chosen from inside the app. */
  outputDeviceSelection: boolean;
  /** MIDI input is available. */
  midi: boolean;
}

export interface EngineInfo {
  /** Engine sample rate. Command positions and lengths are frames at this rate. */
  sampleRate: number;
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
  start(): Promise<EngineInfo>;
  /** Sends a command to the engine. Commands sent before `start()` are queued. */
  send(command: Command): void;
  /** Subscribes to engine events. Returns an unsubscribe function. */
  onEvent(listener: EngineEventListener): () => void;
  /**
   * Decodes an audio file (WAV, FLAC, MP3, OGG Vorbis, AAC/M4A) off the audio thread,
   * resamples it to the engine rate and hands it to the engine. Reference the returned
   * `id` as `source` in `SetClip`.
   */
  importAudio(file: File): Promise<SourceInfo>;
  listDevices(): Promise<AudioDeviceList>;
  /** Edition-specific facts for the status panel (sample rate, isolation, host, ...). */
  diagnostics(): Promise<Diagnostics>;
}
