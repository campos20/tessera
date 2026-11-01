import type {
  AudioPlatform,
  AudioSettings,
  EngineInfo,
  ProjectSummary,
  RecordedTake,
} from "@tessera/platform";
import type { Peaks, Project, SourceInfo, TakeProgress, TuneAnalysis } from "@tessera/schema";
import { isEdited } from "../tune/model";
import { createStore } from "zustand/vanilla";
import type { MeterReading } from "../Meter";
import { addClip, addSource, addTrack, findTrack, newProject, projectEnd } from "../model/edits";
import { framesPerBar } from "../arrange/timeScale";
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
  /** Input level per armed or monitored track. */
  inputs: ReadonlyMap<number, MeterReading>;
  /** Gain reduction (dB) per dynamics device. */
  reduction: ReadonlyMap<number, number>;
  /** Input is being captured right now. */
  recording: boolean;
  countingIn: boolean;
}

/** A take being recorded, in project frames. */
export interface LiveTake {
  start: number;
  frames: number;
  framesPerPeak: number;
  /** `[min, max, ...]` so far. */
  peaks: number[];
}

export interface TuneState {
  /** The clip open in the Tune editor. */
  editing: number | undefined;
  /** Analyses of clips with an open tuning session. */
  analyses: ReadonlyMap<number, TuneAnalysis>;
  /** Clips temporarily playing their original audio (A/B comparison). */
  bypass: ReadonlySet<number>;
}

export interface RecordState {
  armed: ReadonlySet<number>;
  monitored: ReadonlySet<number>;
  /** Between `record()` and the end of `stopRecording()`. */
  active: boolean;
  countInBars: number;
  /** Record only inside the loop region. */
  punch: boolean;
  live: ReadonlyMap<number, LiveTake>;
  settings: AudioSettings;
  engine: EngineInfo | undefined;
  /** Round-trip latency compensation in engine frames, and whether it was measured. */
  latency: { frames: number; calibrated: boolean };
  xruns: number;
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
const SETTINGS_KEY = "tessera.audioSettings";
const LATENCY_KEY = "tessera.latency";
/** Calibration: metronome tempo, recording length, and the engine id of the temporary track. */
const CALIBRATION_BPM = 120;
const CALIBRATION_SECONDS = 3;
const CALIBRATION_TRACK = 0x7fff_fff0;
const MIN_CONFIDENCE = 0.5;
/** Takes shorter than this (a stray block) are discarded. */
const MIN_TAKE_FRAMES = 1024;
/** Time for the engine to process Stop before the capture queue is drained. */
const STOP_SETTLE_MS = 120;
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
    reduction: new Map(),
    inputs: new Map(),
    recording: false,
    countingIn: false,
  }));
  readonly tune = createStore<TuneState>()(() => ({
    editing: undefined,
    analyses: new Map(),
    bypass: new Set(),
  }));
  readonly recording = createStore<RecordState>()(() => ({
    armed: new Set(),
    monitored: new Set(),
    active: false,
    countInBars: 1,
    punch: false,
    live: new Map(),
    settings: loadJson<AudioSettings>(SETTINGS_KEY) ?? {},
    engine: undefined,
    latency: { frames: 0, calibrated: false },
    xruns: 0,
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
  /** Tracks that lost captured audio during the current recording. */
  private readonly overrunTracks = new Set<number>();
  private saveTimer: ReturnType<typeof setTimeout> | undefined;
  private saving: Promise<void> = Promise.resolve();
  /** Serializes project loads, imports and saves. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(readonly platform: AudioPlatform) {
    this.store = createProjectStore(newProject(newId(), "Untitled", now()));
    this.sync = new EngineSync(platform, DEFAULT_ENGINE_RATE);
    this.sync.sync(this.store.getState().project);

    this.store.subscribe((state, prev) => {
      if (state.project !== prev.project) {
        this.sync.sync(state.project);
        this.onTuneEdits(state.project, prev.project);
      }
      if (state.revision !== prev.revision && state.project.id === prev.project.id) this.scheduleSave();
    });
    platform.onEvent((event) => this.onEngineEvent(event));
    platform.onRecordingProgress((p) => this.onTakeProgress(p));
    platform.onXruns((xruns) => this.recording.setState({ xruns }));
  }

  get project(): Project {
    return this.store.getState().project;
  }

  private initializing: Promise<void> | undefined;

  /** Opens the last project (or a new one) and lists saved projects. Runs once. */
  init(): Promise<void> {
    this.initializing ??= this.run("Opening project…", async () => {
      // Desktop: reopen the saved devices (no user gesture or permission prompt needed). The web
      // opens the microphone only when a track is armed.
      if (
        this.platform.capabilities.settings.host &&
        Object.keys(this.recording.getState().settings).length
      ) {
        await this.applyAudioSettings(this.recording.getState().settings).catch((e: unknown) =>
          this.reportError(`Audio settings could not be applied: ${message(e)}`),
        );
      }
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
    if (this.ui.getState().engineRate !== info.sampleRate) this.ui.setState({ engineRate: info.sampleRate });
    this.setEngineInfo(info);
    this.adoptEngineRate(info.sampleRate);
  }

  private setEngineInfo(info: EngineInfo) {
    const key = this.latencyKey(info);
    const calibrated = loadJson<Record<string, number>>(LATENCY_KEY)?.[key];
    this.recording.setState({
      engine: info,
      latency:
        calibrated !== undefined
          ? { frames: calibrated, calibrated: true }
          : { frames: info.latencyEstimate, calibrated: false },
    });
  }

  /** Calibrations are stored per device combination. */
  private latencyKey(info: EngineInfo): string {
    const s = this.recording.getState().settings;
    return [
      this.platform.edition,
      s.host,
      s.inputDevice,
      s.outputDevice,
      info.sampleRate,
      info.bufferSize,
    ].join("|");
  }

  // Devices --------------------------------------------------------------------------------

  /**
   * Applies and remembers device settings. When the platform restarts its engine (desktop),
   * the project and its audio are sent to the new engine.
   */
  async applyAudioSettings(settings: AudioSettings): Promise<void> {
    if (this.recording.getState().active) throw new Error("Stop recording before changing devices.");
    const position = this.transport.getState().position;
    this.stop();
    const { info, restarted } = await this.platform.configureAudio(settings);
    this.recording.setState({ settings });
    safeLocalStorage()?.setItem(SETTINGS_KEY, JSON.stringify(settings));
    this.ui.setState({ engineRate: info.sampleRate });
    this.setEngineInfo(info);
    if (restarted) await this.reloadEngine(info.sampleRate, position);
    else this.adoptEngineRate(info.sampleRate);
  }

  /** Opens an input (the saved one, or the default) if none is open yet. */
  private async ensureInput(): Promise<void> {
    if ((this.recording.getState().engine?.inputChannels ?? 0) > 0) return;
    const settings = this.recording.getState().settings;
    await this.applyAudioSettings({ ...settings, inputDevice: settings.inputDevice ?? "default" });
    if (!this.recording.getState().engine?.inputChannels) throw new Error("No audio input is available.");
  }

  /** A fresh engine (after a device change): resend everything and reload the audio. */
  private async reloadEngine(rate: number, position: number) {
    // Tune sessions decoded audio at the old rate: reopen them after the audio reloads.
    this.closeTuneSessions(this.project.id);
    this.sync.reset();
    this.sync.setEngineRate(rate);
    this.sync.sync(this.project);
    const { armed, monitored } = this.recording.getState();
    for (const track of armed) this.platform.send({ type: "SetTrackArm", track, armed: true });
    for (const track of monitored) this.platform.send({ type: "SetTrackMonitor", track, monitor: true });
    await this.loadAudio(this.project);
    await this.loadTuning(this.project);
    this.seek(position);
  }

  // Recording ------------------------------------------------------------------------------

  async toggleArm(trackId: number) {
    const armed = new Set(this.recording.getState().armed);
    const on = !armed.has(trackId);
    if (on) {
      try {
        await this.ensureInput();
      } catch (e) {
        this.reportError(`Can't arm the track: ${message(e)}`);
        return;
      }
      armed.add(trackId);
    } else armed.delete(trackId);
    this.recording.setState({ armed });
    this.platform.send({ type: "SetTrackArm", track: trackId, armed: on });
  }

  async toggleMonitor(trackId: number) {
    const monitored = new Set(this.recording.getState().monitored);
    const on = !monitored.has(trackId);
    if (on) {
      try {
        await this.ensureInput();
      } catch (e) {
        this.reportError(`Can't monitor the track: ${message(e)}`);
        return;
      }
      monitored.add(trackId);
    } else monitored.delete(trackId);
    this.recording.setState({ monitored });
    this.platform.send({ type: "SetTrackMonitor", track: trackId, monitor: on });
  }

  setTrackInput(trackId: number, channel: number, stereo: boolean) {
    this.store.getState().edit("Change track input", (p) => {
      const track = findTrack(p, trackId);
      if (track) Object.assign(track, { inputChannel: channel, inputStereo: stereo });
    });
  }

  setCountIn(bars: number) {
    this.recording.setState({ countInBars: bars });
  }

  setPunch(punch: boolean) {
    this.recording.setState({ punch });
  }

  /** Starts recording the armed tracks from the playhead (after the count-in). */
  record(): Promise<void> {
    return this.run("Starting recording…", async () => {
      if (this.recording.getState().active) return;
      if (this.recording.getState().armed.size === 0) throw new Error("Arm a track (●) before recording.");
      await this.startEngine();
      await this.ensureInput();
      const project = this.project;
      await this.platform.beginRecording(project.id);
      const { countInBars, punch } = this.recording.getState();
      const bar = framesPerBar({
        sampleRate: project.sampleRate,
        tempo: project.tempo,
        timeSignature: project.timeSignature,
      });
      this.stop();
      this.platform.send({ type: "SetCountIn", frames: this.sync.toEngine(countInBars * bar, project) });
      this.platform.send({
        type: "SetPunch",
        enabled: punch,
        start: this.sync.toEngine(project.loop.start, project),
        end: this.sync.toEngine(project.loop.end, project),
      });
      this.platform.send({ type: "SetRecord", enabled: true });
      this.platform.send({ type: "Play" });
      this.overrunTracks.clear();
      this.recording.setState({ active: true, live: new Map() });
      this.transport.setState({ playing: true, reportedAt: performance.now() });
    });
  }

  /** Stops the transport and turns the takes into clips (one undo step). */
  stopRecording(): Promise<void> {
    return this.run("Saving takes…", async () => {
      if (!this.recording.getState().active) return;
      this.stop();
      this.platform.send({ type: "SetRecord", enabled: false });
      await new Promise((r) => setTimeout(r, STOP_SETTLE_MS));
      let takes: RecordedTake[];
      try {
        takes = (await this.platform.endRecording()).filter((t) => t.frames >= MIN_TAKE_FRAMES);
      } finally {
        // Leave the recording state even if finishing failed, so Record works again.
        this.recording.setState({ active: false, live: new Map() });
      }
      if (takes.length) await this.placeTakes(takes);
    });
  }

  /** Stops whatever is running: recording if active, otherwise playback. */
  stopAll() {
    if (this.recording.getState().active) void this.stopRecording();
    else this.stop();
  }

  private async placeTakes(takes: RecordedTake[]) {
    const project = this.project;
    const engineRate = this.sync.rate;
    const latency = this.recording.getState().latency.frames;
    const toProject = (f: number) => Math.round((f * project.sampleRate) / engineRate);
    const placed: { take: RecordedTake; sourceId: number }[] = [];
    this.store.getState().edit(takes.length > 1 ? "Record takes" : "Record take", (p) => {
      for (const take of takes) {
        const track = findTrack(p, take.track);
        if (!track) continue;
        // Captured audio is stamped with when it arrived; it was played `latency` earlier.
        const start = toProject(take.start - latency);
        const offset = Math.max(0, -start);
        const frames = toProject(take.frames);
        if (offset >= frames) continue;
        const takeNumber = track.clips.length + 1;
        const sourceId = addSource(p, {
          name: `${track.name} take ${takeNumber}.wav`,
          file: take.path,
          frames,
          channels: take.channels,
          originalSampleRate: engineRate,
        });
        const clipId = addClip(p, track.id, sourceId, Math.max(0, start));
        const clip = clipId !== undefined ? track.clips.find((c) => c.id === clipId) : undefined;
        if (clip) {
          clip.offset = offset;
          clip.length = frames - offset;
          // Make lost audio visible on the clip itself, not just in a transient message.
          const lost = this.overrunTracks.has(track.id) ? " (audio lost)" : "";
          clip.name = `${track.name} take ${takeNumber}${lost}`;
        }
        placed.push({ take, sourceId });
      }
    });
    for (const { take, sourceId } of placed) {
      const file = await this.platform.storage.readFile(project.id, take.path);
      this.registerAudio(sourceId, await this.platform.importAudio(file));
    }
  }

  private onTakeProgress(p: TakeProgress) {
    const project = this.project;
    const scale = project.sampleRate / this.sync.rate;
    const live = new Map(this.recording.getState().live);
    const take = live.get(p.track);
    live.set(p.track, {
      start: Math.round((p.start - this.recording.getState().latency.frames) * scale),
      frames: Math.round(p.frames * scale),
      framesPerPeak: 256 * scale,
      peaks:
        take && take.start === Math.round((p.start - this.recording.getState().latency.frames) * scale)
          ? [...take.peaks, ...p.peaks]
          : p.peaks,
    });
    this.recording.setState({ live });
  }

  /**
   * Measures round-trip latency with a loopback cable from an output to `inputChannel`: plays
   * the metronome for a few seconds while recording, then finds the clicks in the recording.
   */
  calibrate(inputChannel: number): Promise<number | undefined> {
    let result: number | undefined;
    return this.run("Calibrating latency…", async () => {
      await this.startEngine();
      await this.ensureInput();
      const project = this.project;
      const position = this.transport.getState().position;
      const send = (c: Parameters<AudioPlatform["send"]>[0]) => this.platform.send(c);
      const track = CALIBRATION_TRACK;
      const armed = this.recording.getState().armed;
      this.stop();
      await this.platform.beginRecording(project.id);
      let takes: RecordedTake[];
      try {
        send({ type: "AddTrack", track });
        send({ type: "SetTrackInput", track, channel: inputChannel, stereo: false });
        send({ type: "SetTrackArm", track, armed: true });
        for (const t of armed) send({ type: "SetTrackArm", track: t, armed: false });
        send({ type: "SetTempo", bpm: CALIBRATION_BPM });
        send({ type: "SetMetronome", enabled: true, gain: 0.8, beatsPerBar: 4 });
        send({ type: "SetLoop", enabled: false, start: 0, end: 0 });
        send({ type: "SetPunch", enabled: false, start: 0, end: 0 });
        send({ type: "SetCountIn", frames: 0 });
        send({ type: "Seek", frame: 0 });
        send({ type: "SetRecord", enabled: true });
        send({ type: "Play" });
        await new Promise((r) => setTimeout(r, CALIBRATION_SECONDS * 1000));
      } finally {
        // Always restore the engine, even if something failed mid-way.
        send({ type: "Stop" });
        send({ type: "SetRecord", enabled: false });
        await new Promise((r) => setTimeout(r, STOP_SETTLE_MS));
        takes = await this.platform.endRecording().catch(() => []);
        send({ type: "RemoveTrack", track });
        for (const t of armed) send({ type: "SetTrackArm", track: t, armed: true });
        this.sync.resend(this.project); // Tempo, metronome and loop as the project has them.
        this.seek(position);
      }

      const take = takes.find((t) => t.track === track);
      try {
        const m = take && (await this.platform.measureLatency(project.id, take.path, CALIBRATION_BPM));
        if (!m || m.confidence < MIN_CONFIDENCE) {
          throw new Error(
            "No clicks were detected. Check the loopback cable and the input channel, then try again.",
          );
        }
        const info = this.recording.getState().engine!;
        const stored = loadJson<Record<string, number>>(LATENCY_KEY) ?? {};
        stored[this.latencyKey(info)] = m.frames;
        safeLocalStorage()?.setItem(LATENCY_KEY, JSON.stringify(stored));
        this.recording.setState({ latency: { frames: m.frames, calibrated: true } });
        result = m.frames;
      } finally {
        // Calibration recordings aren't part of the project.
        for (const t of takes) await this.platform.storage.deleteFile(project.id, t.path).catch(() => {});
      }
    }).then(() => result);
  }

  /**
   * Converts everything sent to the engine to its real sample rate. Called as soon as the rate
   * is known, either from `start()` or from an import (whose `SourceInfo.sampleRate` is the
   * engine rate). Importing doesn't need a user gesture, so after a reload the rate is right
   * before the first Play.
   */
  private adoptEngineRate(rate: number) {
    if (this.sync.rate === rate) return;
    this.sync.setEngineRate(rate); // Re-sends every clip and the loop in the new units.
    // The playhead too; the guard ignores reports still in the old units.
    this.seek(this.transport.getState().position);
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

  // Tune -----------------------------------------------------------------------------------

  /** Opens a clip in the Tune editor, analyzing it first if needed. */
  openTune(clipId: number): Promise<void> {
    return this.run("Analyzing pitch…", async () => {
      await this.startEngine().catch(() => {}); // Analysis works before audio output starts.
      await this.openTuneSession(clipId);
      const found = this.findClipById(clipId);
      const analysis = this.tune.getState().analyses.get(clipId);
      if (!found || !analysis) return;
      if (!found.clip.tune) {
        this.store.getState().edit("Open in Tune", (p) => {
          const clip = p.tracks.flatMap((t) => t.clips).find((c) => c.id === clipId);
          if (clip) clip.tune = { notes: analysis.notes, key: analysis.key };
        });
      }
      this.tune.setState({ editing: clipId });
      void this.planClip(clipId);
    });
  }

  closeTuneEditor() {
    this.tune.setState({ editing: undefined });
  }

  /** A/B: play the clip's original audio instead of the tuned result (not saved). */
  setTuneBypass(clipId: number, bypass: boolean) {
    const set = new Set(this.tune.getState().bypass);
    if (bypass) set.add(clipId);
    else set.delete(clipId);
    this.tune.setState({ bypass: set });
    void this.planClip(clipId);
  }

  private tuneSessionId(clipId: number) {
    return `${this.project.id}:${clipId}`;
  }

  private findClipById(clipId: number) {
    for (const track of this.project.tracks) {
      const clip = track.clips.find((c) => c.id === clipId);
      if (clip) return { track, clip };
    }
    return undefined;
  }

  private readonly opening = new Map<number, Promise<void>>();

  /** Starts a tuning session (analysis) for a clip's source, once. */
  private openTuneSession(clipId: number): Promise<void> {
    if (this.tune.getState().analyses.has(clipId)) return Promise.resolve();
    let pending = this.opening.get(clipId);
    if (!pending) {
      const projectId = this.project.id;
      pending = (async () => {
        const found = this.findClipById(clipId);
        const source = found && this.project.sources.find((s) => s.id === found.clip.sourceId);
        if (!source) throw new Error("The clip's audio is missing.");
        const analysis = await this.platform.tune.open(this.tuneSessionId(clipId), projectId, source.file);
        if (this.project.id !== projectId) return;
        this.tune.setState((s) => ({ analyses: new Map(s.analyses).set(clipId, analysis) }));
      })().finally(() => this.opening.delete(clipId));
      this.opening.set(clipId, pending);
    }
    return pending;
  }

  /** Re-plans clips whose Tune edits changed, and opens sessions for tuned clips without one. */
  private onTuneEdits(next: Project, prev: Project) {
    if (next.id !== prev.id) return;
    const before = new Map(prev.tracks.flatMap((t) => t.clips.map((c) => [c.id, c.tune] as const)));
    for (const clip of next.tracks.flatMap((t) => t.clips)) {
      if (clip.tune === before.get(clip.id)) continue;
      if (!clip.tune) this.sync.setTunePlan(clip.id, undefined);
      else void this.ensureTuned(clip.id);
    }
  }

  /** Makes a clip with edited notes play tuned (opening its session in the background). */
  private async ensureTuned(clipId: number) {
    const clip = this.findClipById(clipId)?.clip;
    if (!clip?.tune) return;
    if (!this.tune.getState().analyses.has(clipId)) {
      if (!clip.tune.notes.some(isEdited)) return; // Unedited: the source plays as is.
      try {
        await this.openTuneSession(clipId);
      } catch (e) {
        this.reportError(`Tune could not analyze "${clip.name}": ${message(e)}`);
        return;
      }
    }
    await this.planClip(clipId);
  }

  private readonly planning = new Set<number>();
  private readonly replan = new Set<number>();

  /** Asks the platform for a clip's playback plan; coalesces edits made while one is running. */
  private async planClip(clipId: number) {
    if (this.planning.has(clipId)) {
      this.replan.add(clipId);
      return;
    }
    this.planning.add(clipId);
    try {
      for (;;) {
        const clip = this.findClipById(clipId)?.clip;
        if (
          !clip?.tune ||
          this.tune.getState().bypass.has(clipId) ||
          !this.tune.getState().analyses.has(clipId)
        ) {
          this.sync.setTunePlan(clipId, undefined);
        } else {
          const tune = clip.tune;
          const plan = await this.platform.tune.plan(this.tuneSessionId(clipId), tune.notes);
          // Only apply the plan if the notes didn't change meanwhile (a re-plan is queued).
          if (this.findClipById(clipId)?.clip.tune === tune) this.sync.setTunePlan(clipId, plan);
        }
        if (!this.replan.delete(clipId)) break;
      }
    } catch (e) {
      this.reportError(`Tune could not render: ${message(e)}`);
    } finally {
      this.planning.delete(clipId);
    }
  }

  /** Ends every tuning session (switching projects, engine restart). */
  private closeTuneSessions(projectId: string) {
    for (const clipId of this.tune.getState().analyses.keys()) {
      void this.platform.tune.close(`${projectId}:${clipId}`).catch(() => {});
    }
    this.tune.setState({ editing: undefined, analyses: new Map(), bypass: new Set() });
  }

  // Internals ------------------------------------------------------------------------------

  /** Replaces the open project: empties the engine, then loads the new project's audio. */
  private async loadProject(project: Project) {
    clearTimeout(this.saveTimer);
    this.stop();
    this.closeTuneSessions(this.project.id);
    this.sync.reset();
    // Arming and monitoring belong to the session, not the project.
    for (const track of this.recording.getState().armed)
      this.platform.send({ type: "SetTrackArm", track, armed: false });
    for (const track of this.recording.getState().monitored)
      this.platform.send({ type: "SetTrackMonitor", track, monitor: false });
    this.recording.setState({ armed: new Set(), monitored: new Set() });
    this.store.getState().load(project);
    this.seek(0);
    safeLocalStorage()?.setItem(LAST_PROJECT_KEY, project.id);
    this.ui.setState({ saveState: "saved" });
    await this.loadAudio(project);
    await this.loadTuning(project);
  }

  /** Re-renders the edited Tune clips of a freshly loaded project. */
  private async loadTuning(project: Project) {
    const tuned = project.tracks.flatMap((t) => t.clips).filter((c) => c.tune?.notes.some(isEdited));
    for (const [i, clip] of tuned.entries()) {
      if (this.project.id !== project.id) return;
      this.ui.setState({ busy: `Preparing Tune ${i + 1}/${tuned.length}: ${clip.name}` });
      await this.ensureTuned(clip.id);
    }
  }

  /** Decodes every source the project's clips use into the engine. */
  private async loadAudio(project: Project) {
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
    this.adoptEngineRate(info.sampleRate);
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
        this.transport.setState({
          playing: event.playing,
          position,
          reportedAt: performance.now(),
          recording: event.recording,
          countingIn: event.countingIn,
        });
        break;
      }
      case "InputMeter":
        this.transport.setState((s) => ({ inputs: new Map(s.inputs).set(event.track, event) }));
        break;
      case "CaptureOverrun": {
        // Remember the track so its take is marked, and say which track lost audio.
        if (this.recording.getState().active) this.overrunTracks.add(event.track);
        const name = this.project.tracks.find((t) => t.id === event.track)?.name ?? "a track";
        this.reportError(
          `Recording fell behind and audio was lost on "${name}"; its take has a gap. Try a larger buffer or fewer armed tracks.`,
        );
        break;
      }
      case "MasterMeter":
        this.transport.setState({ master: event });
        break;
      case "TrackMeter":
        this.transport.setState((s) => ({ tracks: new Map(s.tracks).set(event.track, event) }));
        break;
      case "DeviceMeter":
        this.transport.setState((s) => ({
          reduction: new Map(s.reduction).set(event.device, event.reduction),
        }));
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

function loadJson<T>(key: string): T | undefined {
  try {
    const text = safeLocalStorage()?.getItem(key);
    return text ? (JSON.parse(text) as T) : undefined;
  } catch {
    return undefined;
  }
}

function safeLocalStorage(): Storage | undefined {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
}
