import type { AudioDeviceList, Command, Event, Project, SourceInfo } from "@tessera/schema";

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

export interface ProjectSummary {
  id: string;
  name: string;
  modifiedAt: string;
}

/**
 * Where projects live: the browser's private file system (OPFS) on the web, the app data
 * folder on desktop. A project is `project.json` plus its audio files under `audio/`.
 */
export interface ProjectStorage {
  /** Saved projects, most recently modified first. */
  list(): Promise<ProjectSummary[]>;
  /** Reads a project, migrating older schema versions. Rejects invalid or too-new files. */
  open(id: string): Promise<Project>;
  save(project: Project): Promise<void>;
  /** Stores a file (e.g. imported audio) at `path`, relative to the project root. */
  writeFile(projectId: string, path: string, data: Blob): Promise<void>;
  readFile(projectId: string, path: string): Promise<File>;
  delete(projectId: string): Promise<void>;
  /** Writes the project and its audio as a `.tessera` file. Resolves false if cancelled. */
  exportArchive(projectId: string): Promise<boolean>;
  /** Imports a `.tessera` file as a new project under `newId`. */
  importArchive(file: File, newId: string): Promise<Project>;
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
  readonly storage: ProjectStorage;
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
