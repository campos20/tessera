import type { AudioPlatform, Diagnostics } from "@tessera/platform";
import type { AudioDeviceList, Command, SourceInfo } from "@tessera/schema";
import { useCallback, useEffect, useRef, useState } from "react";
import { Meter, type MeterReading, SILENT } from "./Meter";
import { Waveform } from "./Waveform";
import "./Testbench.css";

/**
 * M1 engine test screen: import audio, mix tracks, run the transport. Throwaway; the real
 * timeline arrives in M2.
 */

interface TrackState {
  id: number;
  name: string;
  source: SourceInfo;
  gainDb: number;
  pan: number;
  mute: boolean;
  solo: boolean;
}

interface Readings {
  playing: boolean;
  position: number;
  master: MeterReading;
  tracks: Map<number, MeterReading>;
}

const MIN_DB = -60;
const UI_REFRESH_MS = 50;
const PERF_TRACKS = 16;

const dbToGain = (db: number) => (db <= MIN_DB ? 0 : 10 ** (db / 20));

const initialReadings = (): Readings => ({ playing: false, position: 0, master: SILENT, tracks: new Map() });

export function Testbench({ platform }: { platform: AudioPlatform }) {
  const [sampleRate, setSampleRate] = useState<number>();
  const [tracks, setTracks] = useState<TrackState[]>([]);
  const [tempo, setTempo] = useState(120);
  const [metronome, setMetronome] = useState(false);
  const [loop, setLoop] = useState(false);
  const [masterDb, setMasterDb] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [diagnostics, setDiagnostics] = useState<Diagnostics>({});
  const [devices, setDevices] = useState<AudioDeviceList>();
  const nextTrackId = useRef(1);

  // Engine events arrive far more often than React should render; keep the latest values in
  // a ref and copy them into state on a timer.
  const latest = useRef<Readings>(initialReadings());
  const [readings, setReadings] = useState<Readings>(initialReadings);

  useEffect(
    () =>
      platform.onEvent((event) => {
        const r = latest.current;
        switch (event.type) {
          case "Transport":
            r.playing = event.playing;
            r.position = event.position;
            break;
          case "MasterMeter":
            r.master = event;
            break;
          case "TrackMeter":
            r.tracks.set(event.track, event);
            break;
        }
      }),
    [platform],
  );

  useEffect(() => {
    const timer = setInterval(() => {
      const r = latest.current;
      setReadings({ ...r, tracks: new Map(r.tracks) });
    }, UI_REFRESH_MS);
    return () => clearInterval(timer);
  }, []);

  const refreshDiagnostics = useCallback(() => {
    platform.diagnostics().then(setDiagnostics, (e: unknown) => setError(String(e)));
  }, [platform]);
  useEffect(refreshDiagnostics, [refreshDiagnostics]);

  const send = useCallback((command: Command) => platform.send(command), [platform]);

  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setError(undefined);
    try {
      await action();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const ensureStarted = async () => {
    const info = await platform.start();
    setSampleRate(info.sampleRate);
    refreshDiagnostics();
    return info.sampleRate;
  };

  const addTrack = (source: SourceInfo, name: string): TrackState => {
    const id = nextTrackId.current++;
    send({ type: "AddTrack", track: id });
    send({
      type: "SetClip",
      clip: id,
      track: id,
      source: source.id,
      start: 0,
      offset: 0,
      length: source.frames,
      gain: 1,
      fadeIn: 0,
      fadeOut: 0,
    });
    return { id, name, source, gainDb: 0, pan: 0, mute: false, solo: false };
  };

  const importFiles = (files: File[]) =>
    run(async () => {
      if (!files.length) return;
      await ensureStarted();
      for (const file of files) {
        const source = await platform.importAudio(file);
        const track = addTrack(source, file.name);
        setTracks((ts) => [...ts, track]);
      }
    });

  const fillTo16 = () => {
    const first = tracks[0];
    if (!first) return;
    const extra = Array.from({ length: Math.max(0, PERF_TRACKS - tracks.length) }, (_, i) =>
      addTrack(first.source, `${first.name} (copy ${i + 1})`),
    );
    setTracks((ts) => [...ts, ...extra]);
  };

  const removeTrack = (track: TrackState) => {
    send({ type: "RemoveTrack", track: track.id });
    const remaining = tracks.filter((t) => t.id !== track.id);
    if (!remaining.some((t) => t.source.id === track.source.id)) {
      send({ type: "RemoveSource", source: track.source.id });
    }
    setTracks(remaining);
  };

  const updateTrack = (id: number, patch: Partial<TrackState>) => {
    setTracks((ts) => ts.map((t) => (t.id === id ? { ...t, ...patch } : t)));
    if (patch.gainDb !== undefined) send({ type: "SetTrackGain", track: id, gain: dbToGain(patch.gainDb) });
    if (patch.pan !== undefined) send({ type: "SetTrackPan", track: id, pan: patch.pan });
    if (patch.mute !== undefined) send({ type: "SetTrackMute", track: id, mute: patch.mute });
    if (patch.solo !== undefined) send({ type: "SetTrackSolo", track: id, solo: patch.solo });
  };

  const framesPerBar = (rate: number) => Math.round((rate * 60 * 4) / tempo);

  const play = () =>
    run(async () => {
      await ensureStarted();
      send({ type: "Play" });
    });
  const stop = () => send({ type: "Stop" });
  const rewind = () => send({ type: "Seek", frame: 0 });

  const changeTempo = (bpm: number) => {
    setTempo(bpm);
    if (bpm > 0) send({ type: "SetTempo", bpm });
    if (loop && sampleRate) {
      send({ type: "SetLoop", enabled: true, start: 0, end: Math.round((sampleRate * 60 * 16) / bpm) });
    }
  };

  const toggleMetronome = (enabled: boolean) => {
    setMetronome(enabled);
    send({ type: "SetMetronome", enabled, gain: 0.5, beatsPerBar: 4 });
  };

  const toggleLoop = (enabled: boolean) =>
    run(async () => {
      const rate = sampleRate ?? (await ensureStarted());
      setLoop(enabled);
      send({ type: "SetLoop", enabled, start: 0, end: framesPerBar(rate) * 4 });
    });

  const changeMaster = (db: number) => {
    setMasterDb(db);
    send({ type: "SetMasterGain", gain: dbToGain(db) });
  };

  const listDevices = () => platform.listDevices().then(setDevices, (e: unknown) => setError(String(e)));

  const seconds = sampleRate ? readings.position / sampleRate : 0;
  const beat = (seconds * tempo) / 60;
  const barsBeats = `${Math.floor(beat / 4) + 1}.${(Math.floor(beat) % 4) + 1}`;

  return (
    <main className="testbench">
      <header>
        <h1>Tessera</h1>
        <p className="edition">{platform.edition === "web" ? "Web" : "Desktop"} edition · engine testbench</p>
      </header>

      <section className="transport" aria-label="Transport">
        <button onClick={play} disabled={busy}>
          Play
        </button>
        <button onClick={stop}>Stop</button>
        <button onClick={rewind} aria-label="Return to start">
          ⏮
        </button>
        <span className="position" data-testid="position" data-frames={readings.position}>
          {barsBeats} · {seconds.toFixed(2)} s
        </span>
        <label>
          Tempo
          <input
            type="number"
            min={20}
            max={300}
            value={tempo}
            onChange={(e) => changeTempo(Number(e.target.value))}
          />
        </label>
        <label>
          <input type="checkbox" checked={metronome} onChange={(e) => toggleMetronome(e.target.checked)} />
          Metronome
        </label>
        <label>
          <input type="checkbox" checked={loop} onChange={(e) => toggleLoop(e.target.checked)} />
          Loop 4 bars
        </label>
      </section>

      <section className="toolbar">
        <label className="file-button">
          Import audio…
          <input
            type="file"
            accept="audio/*,.wav,.flac,.mp3,.ogg,.m4a"
            multiple
            disabled={busy}
            onChange={(e) => {
              // Copy first: the FileList is live and clearing the input empties it.
              void importFiles(Array.from(e.target.files ?? []));
              e.target.value = "";
            }}
            data-testid="import"
          />
        </label>
        <button onClick={fillTo16} disabled={!tracks.length || tracks.length >= PERF_TRACKS}>
          Duplicate to {PERF_TRACKS} tracks
        </button>
        <span data-testid="status">
          {busy ? "Working…" : readings.playing ? "Playing" : "Stopped"}
          {error && <span className="error"> · {error}</span>}
        </span>
      </section>

      <section className="tracks" aria-label="Tracks">
        {tracks.length === 0 && <p className="hint">Import an audio file to create a track.</p>}
        {tracks.map((t) => (
          <div className="track" key={t.id} data-testid={`track-${t.id}`}>
            <div className="name" title={t.name}>
              {t.name}
            </div>
            <Waveform peaks={t.source.peaks} />
            <label>
              Gain
              <input
                type="range"
                min={MIN_DB}
                max={6}
                step={0.5}
                value={t.gainDb}
                onChange={(e) => updateTrack(t.id, { gainDb: Number(e.target.value) })}
              />
              <span className="value">{t.gainDb <= MIN_DB ? "−∞" : `${t.gainDb.toFixed(1)} dB`}</span>
            </label>
            <label>
              Pan
              <input
                type="range"
                min={-1}
                max={1}
                step={0.05}
                value={t.pan}
                onChange={(e) => updateTrack(t.id, { pan: Number(e.target.value) })}
              />
            </label>
            <button
              className={t.mute ? "toggle on" : "toggle"}
              aria-pressed={t.mute}
              aria-label="Mute"
              onClick={() => updateTrack(t.id, { mute: !t.mute })}
            >
              M
            </button>
            <button
              className={t.solo ? "toggle on" : "toggle"}
              aria-pressed={t.solo}
              aria-label="Solo"
              onClick={() => updateTrack(t.id, { solo: !t.solo })}
            >
              S
            </button>
            <Meter reading={readings.tracks.get(t.id) ?? SILENT} testId={`track-meter-${t.id}`} />
            <button onClick={() => removeTrack(t)} aria-label={`Remove ${t.name}`}>
              ✕
            </button>
          </div>
        ))}
      </section>

      <section className="master" aria-label="Master">
        <strong>Master</strong>
        <input
          type="range"
          min={MIN_DB}
          max={6}
          step={0.5}
          value={masterDb}
          onChange={(e) => changeMaster(Number(e.target.value))}
          aria-label="Master gain"
        />
        <Meter reading={readings.master} testId="master-meter" />
      </section>

      <details>
        <summary>Diagnostics</summary>
        <dl>
          {Object.entries(diagnostics).map(([key, value]) => (
            <div key={key} style={{ display: "contents" }}>
              <dt>{key}</dt>
              <dd data-testid={`diag-${key}`}>{String(value)}</dd>
            </div>
          ))}
        </dl>
        <button onClick={listDevices}>List devices</button>
        {devices?.hosts.map((host) => (
          <div key={host.name}>
            <h3>
              {host.name}
              {host.isDefault && " (default)"}
            </h3>
            {host.error && <p className="error">{host.error}</p>}
            <ul>
              {host.devices.map((d) => (
                <li key={d.id}>
                  {d.name} — in {d.maxInputChannels}, out {d.maxOutputChannels}
                  {d.isDefaultOutput && " · default output"}
                  {d.isDefaultInput && " · default input"}
                </li>
              ))}
            </ul>
          </div>
        ))}
      </details>
    </main>
  );
}
