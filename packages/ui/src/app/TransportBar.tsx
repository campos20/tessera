import { useLayoutEffect, useRef } from "react";
import { formatBarsBeats, formatTime, type Meter } from "../arrange/timeScale";
import { usePlayhead } from "../hooks/usePlayhead";
import { useProject, useRecording, useSession, useTransport } from "../state/hooks";
import { RecordOptions } from "./RecordOptions";
import { LoopIcon, MagnetIcon, MetronomeIcon, PlayIcon, RecordIcon, RewindIcon, StopIcon } from "./icons";
import { ProjectMenu } from "./ProjectMenu";
import "./TransportBar.css";

export interface TransportBarProps {
  onOpenSettings: () => void;
  snap: boolean;
  onToggleSnap: () => void;
  onZoom: (factor: number) => void;
}

export function TransportBar({ snap, onToggleSnap, onZoom, onOpenSettings }: TransportBarProps) {
  const session = useSession();
  const edit = useProject((s) => s.edit);
  const tempo = useProject((s) => s.project.tempo);
  const timeSignature = useProject((s) => s.project.timeSignature);
  const sampleRate = useProject((s) => s.project.sampleRate);
  const loop = useProject((s) => s.project.loop.enabled);
  const metronome = useProject((s) => s.project.metronome);
  const playing = useTransport((s) => s.playing);
  const recording = useRecording((s) => s.active);
  const countingIn = useTransport((s) => s.countingIn);
  const meter: Meter = { sampleRate, tempo, timeSignature };

  // The position display updates every animation frame without re-rendering React.
  const barsBeats = useRef<HTMLSpanElement>(null);
  const time = useRef<HTMLSpanElement>(null);
  const display = useRef<HTMLDivElement>(null);
  const meterRef = useRef(meter);
  useLayoutEffect(() => {
    meterRef.current = meter;
  });
  usePlayhead((frame) => {
    if (barsBeats.current) barsBeats.current.textContent = formatBarsBeats(frame, meterRef.current);
    if (time.current) time.current.textContent = formatTime(frame, meterRef.current.sampleRate);
    display.current?.setAttribute("data-frames", String(Math.round(frame)));
  });

  return (
    <header className="transport-bar">
      <div className="brand">
        <span className="logo" aria-hidden>
          ▦
        </span>
        <span className="app-name">Tessera</span>
        <ProjectMenu />
      </div>

      <div className="transport-controls" role="group" aria-label="Transport">
        <button
          className="icon-button"
          onClick={() => session.seek(0)}
          aria-label="Return to start"
          title="Return to start (Home)"
        >
          <RewindIcon />
        </button>
        <button
          className={playing ? "icon-button play on" : "icon-button play"}
          onClick={() => (recording ? void session.stopRecording() : session.togglePlay())}
          aria-label={playing ? "Pause" : "Play"}
          title="Play / pause (Space)"
        >
          <PlayIcon />
        </button>
        <button className="icon-button" onClick={() => session.stopAll()} aria-label="Stop" title="Stop">
          <StopIcon />
        </button>
        <button
          className={`icon-button record${recording ? " on" : ""}${countingIn ? " counting-in" : ""}`}
          onClick={() => (recording ? void session.stopRecording() : void session.record())}
          aria-pressed={recording}
          aria-label="Record"
          title="Record armed tracks (R)"
        >
          <RecordIcon />
        </button>
        <RecordOptions />
        <button
          className={loop ? "icon-button toggle on" : "icon-button toggle"}
          onClick={() => edit(loop ? "Loop off" : "Loop on", (p) => void (p.loop.enabled = !p.loop.enabled))}
          aria-pressed={loop}
          aria-label="Loop"
          title="Loop (L)"
        >
          <LoopIcon />
        </button>
      </div>

      <div className="position-display" data-testid="position" data-frames="0" ref={display}>
        <span className="bars-beats" ref={barsBeats}>
          1.1.000
        </span>
        <span className="time" ref={time}>
          0:00.000
        </span>
      </div>

      <div className="tempo-group">
        <label className="field">
          <input
            key={tempo}
            type="number"
            min={20}
            max={300}
            step={0.1}
            defaultValue={tempo}
            onBlur={(e) => commitTempo(Number(e.target.value))}
            onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
            aria-label="Tempo"
          />
          <span>BPM</span>
        </label>
        <span className="field signature">
          {timeSignature.numerator}/{timeSignature.denominator}
        </span>
        <button
          className={metronome ? "icon-button toggle on" : "icon-button toggle"}
          onClick={() => edit("Metronome", (p) => void (p.metronome = !p.metronome))}
          aria-pressed={metronome}
          aria-label="Metronome"
          title="Metronome (C)"
        >
          <MetronomeIcon />
        </button>
      </div>

      <div className="view-group">
        <button
          className="icon-button"
          onClick={onOpenSettings}
          aria-label="Audio settings"
          title="Audio settings"
        >
          ⚙
        </button>
        <button
          className={snap ? "icon-button toggle on" : "icon-button toggle"}
          onClick={onToggleSnap}
          aria-pressed={snap}
          aria-label="Snap to grid"
          title="Snap to grid (N) — hold ⌘/Ctrl while dragging to bypass"
        >
          <MagnetIcon />
        </button>
        <button
          className="icon-button"
          onClick={() => onZoom(1.5)}
          aria-label="Zoom out"
          title="Zoom out (−)"
        >
          −
        </button>
        <button
          className="icon-button"
          onClick={() => onZoom(1 / 1.5)}
          aria-label="Zoom in"
          title="Zoom in (+)"
        >
          +
        </button>
      </div>
    </header>
  );

  function commitTempo(bpm: number) {
    if (Number.isFinite(bpm) && bpm >= 20 && bpm <= 300 && bpm !== tempo) {
      edit("Change tempo", (p) => void (p.tempo = bpm));
    }
  }
}
