import { formatBarsBeats, formatTime, type Meter } from "../arrange/timeScale";
import { LoopIcon, MagnetIcon, MetronomeIcon, PlayIcon, RecordIcon, RewindIcon, StopIcon } from "./icons";
import "./TransportBar.css";

export interface TransportBarProps {
  projectName: string;
  playing: boolean;
  position: number;
  meter: Meter;
  loop: boolean;
  metronome: boolean;
  snap: boolean;
  onPlay: () => void;
  onStop: () => void;
  onRewind: () => void;
  onToggleLoop: () => void;
  onToggleMetronome: () => void;
  onToggleSnap: () => void;
  onTempo: (bpm: number) => void;
  onZoom: (factor: number) => void;
}

export function TransportBar(p: TransportBarProps) {
  return (
    <header className="transport-bar">
      <div className="brand">
        <span className="logo" aria-hidden>
          ▦
        </span>
        <span className="app-name">Tessera</span>
        <span className="project-name" title={p.projectName}>
          {p.projectName}
        </span>
      </div>

      <div className="transport-controls" role="group" aria-label="Transport">
        <button
          className="icon-button"
          onClick={p.onRewind}
          aria-label="Return to start"
          title="Return to start (Home)"
        >
          <RewindIcon />
        </button>
        <button
          className={p.playing ? "icon-button play on" : "icon-button play"}
          onClick={p.playing ? p.onStop : p.onPlay}
          aria-label={p.playing ? "Pause" : "Play"}
          title="Play / pause (Space)"
        >
          <PlayIcon />
        </button>
        <button className="icon-button" onClick={p.onStop} aria-label="Stop" title="Stop">
          <StopIcon />
        </button>
        <button className="icon-button record" disabled aria-label="Record" title="Recording arrives in M3">
          <RecordIcon />
        </button>
        <button
          className={p.loop ? "icon-button toggle on" : "icon-button toggle"}
          onClick={p.onToggleLoop}
          aria-pressed={p.loop}
          aria-label="Loop"
          title="Loop (L)"
        >
          <LoopIcon />
        </button>
      </div>

      <div className="position-display" data-testid="position" data-frames={p.position}>
        <span className="bars-beats">{formatBarsBeats(p.position, p.meter)}</span>
        <span className="time">{formatTime(p.position, p.meter.sampleRate)}</span>
      </div>

      <div className="tempo-group">
        <label className="field">
          <input
            type="number"
            min={20}
            max={300}
            step={0.1}
            value={p.meter.tempo}
            onChange={(e) => p.onTempo(Number(e.target.value))}
            aria-label="Tempo"
          />
          <span>BPM</span>
        </label>
        <span className="field signature">
          {p.meter.timeSignature.numerator}/{p.meter.timeSignature.denominator}
        </span>
        <button
          className={p.metronome ? "icon-button toggle on" : "icon-button toggle"}
          onClick={p.onToggleMetronome}
          aria-pressed={p.metronome}
          aria-label="Metronome"
          title="Metronome (C)"
        >
          <MetronomeIcon />
        </button>
      </div>

      <div className="view-group">
        <button
          className={p.snap ? "icon-button toggle on" : "icon-button toggle"}
          onClick={p.onToggleSnap}
          aria-pressed={p.snap}
          aria-label="Snap to grid"
          title="Snap to grid (N)"
        >
          <MagnetIcon />
        </button>
        <button
          className="icon-button"
          onClick={() => p.onZoom(1.5)}
          aria-label="Zoom out"
          title="Zoom out (−)"
        >
          −
        </button>
        <button
          className="icon-button"
          onClick={() => p.onZoom(1 / 1.5)}
          aria-label="Zoom in"
          title="Zoom in (+)"
        >
          +
        </button>
      </div>
    </header>
  );
}
