import type { AudioPlatform, ProjectSummary } from "@tessera/platform";
import type { Peaks, Project, SourceInfo } from "@tessera/schema";
import { createStore } from "zustand/vanilla";
import type { MeterReading } from "../Meter";
import { addClip, addSource, addTrack, newProject, projectEnd } from "../model/edits";
import { EngineSync } from "./engineSync";
import { createProjectStore, type ProjectStore } from "./store";

export interface TransportState {
  playing: boolean;
  /** Playhead in project frames. */
  position: number;
  /** `performance.now()` when `position` was reported, for smooth playhead animation. */
  reportedAt: number;
  master: MeterReading;
  tracks: ReadonlyMap<number, MeterReading>;
}

export type SaveState = "saved" | "saving" | "unsaved" | "error";

export interface SessionUiState {
  /** Engine sample rate once started. */
  engineRate: number | undefined;
  /** Long-running work in progress ("Loading audio 2/5…"). */
  busy: string | undefined;
  error: string | undefined;
  saveState: SaveState;
  projects: ProjectSummary[];
}

const LAST_PROJECT_KEY = "tessera.lastProject";
const AUTOSAVE_DELAY_MS = 800;
const DEFAULT_ENGINE_RATE = 48_000;
/** How long engine position reports may lag a seek before they are trusted again. */
const SEEK_GUARD_MS = 500;

/**
 * Owns everything around the open project: the undoable store, the engine mirror, audio
 * import, storage with autosave, and the transport. UI components only call into this.
 */
export class Session {
  readonly store: ProjectStore;
  readonly transport = createStore<TransportState>()(() => ({
    playing: false,
    position: 0,
    reportedAt: 0,
    master: { peakL: 0, peakR: 0 },
    tracks: new Map(),
  }));
  readonly ui = createStore<SessionUiState>()(() => ({
    engineRate: undefined,
    busy: undefined,
    error: undefined,
    saveState: "saved",
    projects: [],
  }));

  private readonly sync: EngineSync;
  /** Set by `seek`: engine reports from before the seek are ignored until they catch up. */
  private pendingSeek: { frame: number; until: number } | undefined;
  private saveTimer: ReturnType<typeof setTimeout> | undefined;
  private saving: Promise<void> = Promise.resolve();
  /** Serializes project loads, imports and saves. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(readonly platform: AudioPlatform) {
    this.store = createProjectStore(newProject(newId(), "Untitled", now()));
    this.sync = new EngineSync(platform, DEFAULT_ENGINE_RATE);
    this.sync.sync(this.store.getState().project);

    this.store.subscribe((state, prev) => {
      if (state.project !== prev.project) this.sync.sync(state.project);
      if (state.revision !== prev.revision && state.project.id === prev.project.id) this.scheduleSave();
    });
    platform.onEvent((event) => this.onEngineEvent(event));
  }

  get project(): Project {
    return this.store.getState().project;
  }

  private initializing: Promise<void> | undefined;

  /** Opens the last project (or a new one) and lists saved projects. Runs once. */
  init(): Promise<void> {
    this.initializing ??= this.run("Opening project…", async () => {
      await this.refreshProjects();
      const last = safeLocalStorage()?.getItem(LAST_PROJECT_KEY);
      const existing =
        this.ui.getState().projects.find((p) => p.id === last) ?? this.ui.getState().projects[0];
      if (existing) {
        try {
          await this.loadProject(await this.platform.storage.open(existing.id));
          return;
        } catch (e) {
          this.reportError(`Could not open "${existing.name}": ${message(e)}`);
        }
      }
      await this.loadProject(newProject(newId(), "Untitled", now()));
      await this.saveNow();
    });
    return this.initializing;
  }

  /** Starts the audio engine (on the web this needs a user gesture). */
  async startEngine(): Promise<void> {
    const info = await this.platform.start();
    if (this.ui.getState().engineRate !== info.sampleRate) {
      this.ui.setState({ engineRate: info.sampleRate });
      this.sync.setEngineRate(info.sampleRate);
    }
  }

  // Projects -------------------------------------------------------------------------------

  newProject(name = "Untitled"): Promise<void> {
    return this.run("Creating project…", async () => {
      await this.flushSave();
      await this.loadProject(newProject(newId(), name, now()));
      await this.saveNow();
    });
  }

  openProject(id: string): Promise<void> {
    return this.run("Opening project…", async () => {
      await this.flushSave();
      await this.loadProject(await this.platform.storage.open(id));
    });
  }

  importArchive(file: File): Promise<void> {
    return this.run("Importing project…", async () => {
      await this.flushSave();
      await this.loadProject(await this.platform.storage.importArchive(file, newId()));
      await this.refreshProjects();
    });
  }

  exportArchive(): Promise<void> {
    return this.run("Exporting…", async () => {
      await this.flushSave();
      await this.platform.storage.exportArchive(this.project.id);
    });
  }

  deleteProject(id: string): Promise<void> {
    return this.run("Deleting project…", async () => {
      if (id === this.project.id) {
        clearTimeout(this.saveTimer);
        await this.platform.storage.delete(id);
        const next = (await this.platform.storage.list())[0];
        await this.loadProject(
          next ? await this.platform.storage.open(next.id) : newProject(newId(), "Untitled", now()),
        );
        if (!next) await this.saveNow();
      } else {
        await this.platform.storage.delete(id);
      }
      await this.refreshProjects();
    });
  }

  rename(name: string) {
    const trimmed = name.trim();
    if (trimmed && trimmed !== this.project.name)
      this.store.getState().edit("Rename project", (p) => void (p.name = trimmed));
  }

  // Audio ----------------------------------------------------------------------------------

  /**
   * Imports audio files: stores each original file with the project, decodes it into the
   * engine and places it as a clip at `start` on `trackId`, or on a new track per file.
   */
  importFiles(files: File[], target: { trackId?: number; start?: number } = {}): Promise<void> {
    return this.run("Importing audio…", async () => {
      await this.startEngine().catch(() => {}); // Decoding works without output; playback resumes later.
      for (const [i, file] of files.entries()) {
        this.ui.setState({
          busy:
            files.length > 1 ? `Importing ${i + 1}/${files.length}: ${file.name}` : `Importing ${file.name}…`,
        });
        const info = await this.platform.importAudio(file);
        const projectId = this.project.id;
        const path = `audio/${newId().slice(0, 8)}-${safeFileName(file.name)}`;
        await this.platform.storage.writeFile(projectId, path, file);

        let sourceId = 0;
        const rate = this.project.sampleRate;
        this.store.getState().edit(`Import ${file.name}`, (p) => {
          sourceId = addSource(p, {
            name: file.name,
            file: path,
            frames: Math.round((info.frames * rate) / info.sampleRate),
            channels: info.channels,
            originalSampleRate: info.originalSampleRate,
          });
          const trackId =
            (target.trackId !== undefined && i === 0 ? target.trackId : undefined) ??
            addTrack(p, baseName(file.name));
          addClip(p, trackId, sourceId, target.start ?? 0);
        });
        this.registerAudio(sourceId, info);
      }
    });
  }

  // Transport ------------------------------------------------------------------------------

  async play() {
    try {
      await this.startEngine();
    } catch (e) {
      this.reportError(`Audio could not start: ${message(e)}`);
      return;
    }
    this.platform.send({ type: "Play" });
    this.transport.setState({ playing: true, reportedAt: performance.now() });
  }

  stop() {
    this.platform.send({ type: "Stop" });
    this.transport.setState({ playing: false });
  }

  togglePlay() {
    if (this.transport.getState().playing) this.stop();
    else void this.play();
  }

  seek(frame: number) {
    const position = Math.max(0, Math.round(frame));
    this.platform.send({ type: "Seek", frame: this.sync.toEngine(position, this.project) });
    this.pendingSeek = { frame: position, until: performance.now() + SEEK_GUARD_MS };
    this.transport.setState({ position, reportedAt: performance.now() });
  }

  /** End of the last clip, for "go to end". */
  end(): number {
    return projectEnd(this.project);
  }

  // Internals ------------------------------------------------------------------------------

  /** Replaces the open project: empties the engine, then loads the new project's audio. */
  private async loadProject(project: Project) {
    clearTimeout(this.saveTimer);
    this.stop();
    this.sync.reset();
    this.store.getState().load(project);
    this.seek(0);
    safeLocalStorage()?.setItem(LAST_PROJECT_KEY, project.id);
    this.ui.setState({ saveState: "saved" });

    const sources = project.sources.filter((s) =>
      project.tracks.some((t) => t.clips.some((c) => c.sourceId === s.id)),
    );
    for (const [i, source] of sources.entries()) {
      this.ui.setState({ busy: `Loading audio ${i + 1}/${sources.length}: ${source.name}` });
      try {
        const file = await this.platform.storage.readFile(project.id, source.file);
        const info = await this.platform.importAudio(new File([file], source.name));
        if (this.project.id !== project.id) return; // Another project was opened meanwhile.
        this.registerAudio(source.id, info);
      } catch (e) {
        this.reportError(`Missing audio "${source.name}": ${message(e)}`);
      }
    }
  }

  private registerAudio(sourceId: number, info: SourceInfo) {
    this.sync.registerSource(sourceId, info.id);
    // Peaks arrive in engine frames; the timeline draws in project frames.
    const scale = this.project.sampleRate / info.sampleRate;
    const peaks: Peaks = { framesPerPeak: info.peaks.framesPerPeak * scale, data: info.peaks.data };
    this.store.getState().setPeaks(sourceId, peaks);
  }

  private onEngineEvent(event: import("@tessera/schema").Event) {
    switch (event.type) {
      case "Transport": {
        const position = this.sync.toProject(event.position, this.project);
        const seek = this.pendingSeek;
        if (seek) {
          // A report still on the old side of the seek (queued before the engine saw it).
          const caughtUp = position >= seek.frame && position - seek.frame < this.project.sampleRate;
          if (!caughtUp && performance.now() < seek.until) break;
          this.pendingSeek = undefined;
        }
        this.transport.setState({ playing: event.playing, position, reportedAt: performance.now() });
        break;
      }
      case "MasterMeter":
        this.transport.setState({ master: event });
        break;
      case "TrackMeter":
        this.transport.setState((s) => ({ tracks: new Map(s.tracks).set(event.track, event) }));
        break;
    }
  }

  private scheduleSave() {
    this.ui.setState({ saveState: "unsaved" });
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => void this.saveNow(), AUTOSAVE_DELAY_MS);
  }

  /** Saves immediately if there are unsaved changes (before switching projects, exporting...). */
  async flushSave() {
    if (this.ui.getState().saveState === "unsaved") await this.saveNow();
    await this.saving;
  }

  private saveNow(): Promise<void> {
    clearTimeout(this.saveTimer);
    const project = { ...this.project, modifiedAt: now() };
    this.ui.setState({ saveState: "saving" });
    this.saving = this.saving
      .then(() => this.platform.storage.save(project))
      .then(
        () => {
          // Only "saved" if nothing changed while writing.
          if (this.project.id === project.id && this.ui.getState().saveState === "saving") {
            this.ui.setState({ saveState: "saved" });
          }
          void this.refreshProjects();
        },
        (e: unknown) => {
          this.ui.setState({ saveState: "error" });
          this.reportError(`Could not save: ${message(e)}`);
        },
      );
    return this.saving;
  }

  private async refreshProjects() {
    try {
      this.ui.setState({ projects: await this.platform.storage.list() });
    } catch (e) {
      this.reportError(`Could not list projects: ${message(e)}`);
    }
  }

  reportError(error: string | undefined) {
    this.ui.setState({ error });
  }

  /** Runs `task` after any running one, showing `label` while busy and reporting failures. */
  private run(label: string, task: () => Promise<void>): Promise<void> {
    const next = this.queue.then(async () => {
      this.ui.setState({ busy: label, error: undefined });
      try {
        await task();
      } catch (e) {
        this.reportError(message(e));
      } finally {
        this.ui.setState({ busy: undefined });
      }
    });
    this.queue = next;
    return next;
  }
}

function newId(): string {
  return crypto.randomUUID();
}

function now(): string {
  return new Date().toISOString();
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function baseName(name: string): string {
  return name.replace(/\.[^.]+$/, "");
}

function safeFileName(name: string): string {
  return name.replace(/[^\w.-]+/g, "_").slice(-80) || "audio";
}

function safeLocalStorage(): Storage | undefined {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
}
