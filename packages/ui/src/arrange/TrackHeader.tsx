import type { Track } from "@tessera/schema";
import { type ChangeEvent, type PointerEvent, useRef, useState } from "react";
import { Meter, type MeterReading } from "../Meter";
import { TRACK_COLORS } from "../model/colors";

export type TrackPatch = Partial<Pick<Track, "gain" | "pan" | "mute" | "solo" | "name" | "color">>;
/** `phase` lets continuous controls (sliders) become one undo step per drag. */
export type ChangePhase = "start" | "change" | "end" | "once";

export interface TrackHeaderProps {
  track: Track;
  height: number;
  meter: MeterReading;
  selected: boolean;
  onChange: (patch: TrackPatch, phase: ChangePhase, label: string) => void;
  onSelect: () => void;
  /** Dragging the header reorders tracks; `rows` is the offset from the starting row. */
  onReorder: (rows: number, phase: "start" | "move" | "end") => void;
}

const MIN_DB = -60;
const gainToDb = (gain: number) => (gain <= 0 ? MIN_DB : Math.max(MIN_DB, 20 * Math.log10(gain)));
const dbToGain = (db: number) => (db <= MIN_DB ? 0 : 10 ** (db / 20));
const DRAG_THRESHOLD_PX = 6;

export function TrackHeader({
  track,
  height,
  meter,
  selected,
  onChange,
  onSelect,
  onReorder,
}: TrackHeaderProps) {
  const db = gainToDb(track.gain);
  const [editing, setEditing] = useState(false);
  const drag = useRef<{ y: number; active: boolean } | null>(null);

  const slider = (label: string, toPatch: (value: number) => TrackPatch) => ({
    onPointerDown: () => onChange({}, "start", label),
    onPointerUp: () => onChange({}, "end", label),
    onChange: (e: ChangeEvent<HTMLInputElement>) =>
      onChange(toPatch(Number(e.target.value)), "change", label),
  });

  const isControl = (e: PointerEvent) => (e.target as HTMLElement).closest("button, input") !== null;

  return (
    <div
      className={selected ? "track-header selected" : "track-header"}
      style={{ height, ["--track-color" as string]: track.color }}
      data-testid={`track-header-${track.id}`}
      onPointerDown={(e) => {
        onSelect();
        if (isControl(e) || e.button !== 0) return;
        drag.current = { y: e.clientY, active: false };
        e.currentTarget.setPointerCapture(e.pointerId);
      }}
      onPointerMove={(e) => {
        const d = drag.current;
        if (!d) return;
        const dy = e.clientY - d.y;
        if (!d.active && Math.abs(dy) < DRAG_THRESHOLD_PX) return;
        if (!d.active) {
          d.active = true;
          onReorder(0, "start");
        }
        onReorder(Math.round(dy / height), "move");
      }}
      onPointerUp={() => {
        if (drag.current?.active) onReorder(0, "end");
        drag.current = null;
      }}
    >
      <button
        className="color-strip"
        aria-label="Change track color"
        title="Change color"
        onClick={() => {
          const next = TRACK_COLORS[(TRACK_COLORS.indexOf(track.color) + 1) % TRACK_COLORS.length]!;
          onChange({ color: next }, "once", "Change track color");
        }}
      />
      <div className="header-body">
        <div className="header-row">
          {editing ? (
            <input
              className="track-name-input"
              defaultValue={track.name}
              autoFocus
              aria-label="Track name"
              onFocus={(e) => e.target.select()}
              onBlur={(e) => {
                setEditing(false);
                const name = e.target.value.trim();
                if (name && name !== track.name) onChange({ name }, "once", "Rename track");
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") e.currentTarget.blur();
                if (e.key === "Escape") setEditing(false);
              }}
            />
          ) : (
            <span
              className="track-name"
              title={`${track.name} — double-click to rename`}
              onDoubleClick={() => setEditing(true)}
            >
              {track.name}
            </span>
          )}
          <button
            className={track.mute ? "ms mute on" : "ms mute"}
            aria-pressed={track.mute}
            aria-label="Mute"
            onClick={() => onChange({ mute: !track.mute }, "once", "Mute")}
          >
            M
          </button>
          <button
            className={track.solo ? "ms solo on" : "ms solo"}
            aria-pressed={track.solo}
            aria-label="Solo"
            onClick={() => onChange({ solo: !track.solo }, "once", "Solo")}
          >
            S
          </button>
        </div>
        <div className="header-row controls">
          <input
            className="volume"
            type="range"
            min={MIN_DB}
            max={6}
            step={0.5}
            value={db}
            {...slider("Volume", (v) => ({ gain: dbToGain(v) }))}
            aria-label="Volume"
            title={db <= MIN_DB ? "−∞ dB" : `${db.toFixed(1)} dB`}
          />
          <input
            className="pan"
            type="range"
            min={-1}
            max={1}
            step={0.05}
            value={track.pan}
            {...slider("Pan", (v) => ({ pan: v }))}
            onDoubleClick={() => onChange({ pan: 0 }, "once", "Pan")}
            aria-label="Pan"
            title={
              track.pan === 0
                ? "C"
                : track.pan < 0
                  ? `L${Math.round(-track.pan * 100)}`
                  : `R${Math.round(track.pan * 100)}`
            }
          />
        </div>
        <Meter reading={meter} testId={`track-meter-${track.id}`} />
      </div>
    </div>
  );
}
