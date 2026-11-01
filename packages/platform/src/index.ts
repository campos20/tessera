import type {
  AudioDeviceList,
  Command,
  Event,
  Note,
  PlannedSegment,
  Project,
  SourceInfo,
  TakeProgress,
  TuneAnalysis,
} from "@tessera/schema";

export type Edition = "web" | "desktop";

export interface PlatformCapabilities {
  /** Third-party plugin hosting (VST3/CLAP). Desktop only, from M7. */
  plugins: boolean;
  /** The output device can be chosen from inside the app. */
  outputDeviceSelection: boolean;
  /** MIDI input is available. */
  midi: boolean;
  /** Which `AudioSettings` fields this edition honors. */
  settings: { [K in keyof Required<AudioSettings>]: boolean };
}

/** Device settings. Unset fields mean "default"; except `inputDevice`, where unset means no input. */
export interface AudioSettings {
  /** Driver model (desktop): "CoreAudio", "WASAPI", "ASIO", "ALSA", "JACK". */
  host?: string;
  outputDevice?: string;
  /** Device id, or "default". */
  inputDevice?: string;
  sampleRate?: number;
  /** Frames per callback (desktop). */
  bufferSize?: number;
}

export interface EngineInfo {
  /** Engine sample rate. Command positions and lengths are frames at this rate. */
  sampleRate: number;
  /** Channels of the open input (0 = no input). */
  inputChannels: number;
  /** Rough round-trip latency in engine frames, used until a loopback calibration exists. */
  latencyEstimate: number;
  /** Frames per callback when known. */
  bufferSize?: number;
}

/** A recorded take, already stored in the project. */
export interface RecordedTake {
  track: number;
  /** Project-relative path, e.g. `audio/rec-…-3-1.wav`. */
  path: string;
  /** Timeline frame (engine rate) of the first sample, before latency compensation. */
  start: number;
  frames: number;
  channels: number;
}

export type { TakeProgress } from "@tessera/schema";

export interface LatencyMeasurement {
  frames: number;
  /** 0…1; below ~0.5 the loopback probably isn't connected. */
  confidence: number;
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
  /** Deletes a file inside a project; missing files are ignored. */
  deleteFile(projectId: string, path: string): Promise<void>;
  delete(projectId: string): Promise<void>;
  /** Writes the project and its audio as a `.tessera` file. Resolves false if cancelled. */
  exportArchive(projectId: string): Promise<boolean>;
  /** Imports a `.tessera` file as a new project under `newId`. */
  importArchive(file: File, newId: string): Promise<Project>;
}

/** Playback of a tuned clip: original segments and rendered regions (engine frames). */
export interface TunePlan {
  segments: PlannedSegment[];
  outputFrames: number;
  /** Engine source id of each rendered region, by region key. */
  sources: Record<string, number>;
}

/**
 * Note-level pitch and timing editing. Sessions run off the UI and audio threads (the web
 * worker, the desktop backend) and keep each source's analysis, so edits only render the
 * regions they change.
 */
export interface TuneService {
  /** Decodes and analyzes a project audio file at the engine rate. */
  open(sessionId: string, projectId: string, path: string): Promise<TuneAnalysis>;
  /** Plans playback for `notes`, rendering only regions not rendered before in this session. */
  plan(sessionId: string, notes: Note[]): Promise<TunePlan>;
  /** Ends the session and frees its rendered audio. */
  close(sessionId: string): Promise<void>;
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
  readonly tune: TuneService;
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
  /**
   * Applies device settings. On desktop this restarts the engine empty (`restarted`): the
   * caller must resend the project and reload its audio. On the web it changes the input and
   * output devices of the running engine.
   */
  configureAudio(settings: AudioSettings): Promise<{ info: EngineInfo; restarted: boolean }>;
  /** Starts writing armed tracks' input into the project's `audio/` folder. */
  beginRecording(projectId: string): Promise<void>;
  /** Finishes recording (after Stop) and returns the takes, one per contiguous run. */
  endRecording(): Promise<RecordedTake[]>;
  onRecordingProgress(listener: (progress: TakeProgress) => void): () => void;
  /** Called with the running dropout count whenever it changes. */
  onXruns(listener: (count: number) => void): () => void;
  /**
   * Measures round-trip latency from a calibration take that recorded the metronome at `bpm`
   * starting at timeline frame 0. `null` when nothing recognizable was recorded.
   */
  measureLatency(projectId: string, path: string, bpm: number): Promise<LatencyMeasurement | null>;
  /** Edition-specific facts for the status panel (sample rate, isolation, host, ...). */
  diagnostics(): Promise<Diagnostics>;
}
