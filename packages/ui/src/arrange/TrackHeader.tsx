import type { LaneTarget, Track } from "@tessera/schema";
import { type ChangeEvent, type PointerEvent, useEffect, useRef, useState } from "react";
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
  armed: boolean;
  monitored: boolean;
  /** Input level, shown instead of the output meter while armed or monitored. */
  inputMeter: MeterReading;
  /** Channels of the open input (0 when none is open yet). */
  inputChannels: number;
  onArm: () => void;
  onMonitor: () => void;
  onInput: (channel: number, stereo: boolean) => void;
  onDelete: () => void;
  onChange: (patch: TrackPatch, phase: ChangePhase, label: string) => void;
  onSelect: () => void;
  /** Dragging the header reorders tracks; `rows` is the offset from the starting row. */
  onReorder: (rows: number, phase: "start" | "move" | "end") => void;
  /** What can be automated on this track (volume, pan, sends, device parameters). */
  automationTargets: { label: string; target: LaneTarget }[];
  onShowLane: (target: LaneTarget) => void;
}

const MIN_DB = -60;
const gainToDb = (gain: number) => (gain <= 0 ? MIN_DB : Math.max(MIN_DB, 20 * Math.log10(gain)));
const dbToGain = (db: number) => (db <= MIN_DB ? 0 : 10 ** (db / 20));
const DRAG_THRESHOLD_PX = 6;

export function TrackHeader(props: TrackHeaderProps) {
  const { track, height, meter, selected, armed, monitored, onChange, onSelect, onReorder } = props;
  const db = gainToDb(track.gain);
  const [editing, setEditing] = useState(false);
  const [menu, setMenu] = useState(false);
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
          {track.kind === "bus" ? (
            <span className="bus-tag" title="Bus: mixes the tracks routed to it">
              BUS
            </span>
          ) : (
            <button
              className={armed ? "ms arm on" : "ms arm"}
              aria-pressed={armed}
              aria-label="Arm for recording"
              title="Arm for recording"
              onClick={props.onArm}
            >
              ●
            </button>
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
          <button
            className="ms more"
            aria-label="Track options"
            aria-expanded={menu}
            onClick={() => setMenu(!menu)}
          >
            ⋯
          </button>
          {menu && (
            <TrackMenu
              track={track}
              monitored={monitored}
              inputChannels={props.inputChannels}
              onClose={() => setMenu(false)}
              onMonitor={props.onMonitor}
              onInput={props.onInput}
              onDelete={props.onDelete}
              automationTargets={props.automationTargets}
              onShowLane={props.onShowLane}
            />
          )}
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
        {armed || monitored ? (
          <div className="input-meter" title="Input level">
            <Meter reading={props.inputMeter} testId={`input-meter-${track.id}`} />
          </div>
        ) : (
          <Meter reading={meter} testId={`track-meter-${track.id}`} />
        )}
      </div>
    </div>
  );
}

/** Input routing and less frequent track actions. */
function TrackMenu(p: {
  track: Track;
  monitored: boolean;
  inputChannels: number;
  onClose: () => void;
  onMonitor: () => void;
  onInput: (channel: number, stereo: boolean) => void;
  onDelete: () => void;
  automationTargets: { label: string; target: LaneTarget }[];
  onShowLane: (target: LaneTarget) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const { onClose } = p;
  useEffect(() => {
    const close = (e: globalThis.PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    window.addEventListener("pointerdown", close);
    return () => window.removeEventListener("pointerdown", close);
  }, [onClose]);
  // Offer at least two channels so the input can be chosen before the device is open.
  const channels = Math.max(2, p.inputChannels);
  const options: { label: string; channel: number; stereo: boolean }[] = [];
  for (let c = 0; c < channels; c++) options.push({ label: `In ${c + 1}`, channel: c, stereo: false });
  for (let c = 0; c + 1 < channels; c += 2)
    options.push({ label: `In ${c + 1}+${c + 2}`, channel: c, stereo: true });
  return (
    <div className="track-menu" ref={ref} role="menu" onPointerDown={(e) => e.stopPropagation()}>
      <label>
        Automation
        <select
          value=""
          aria-label="Show automation"
          onChange={(e) => {
            const target = p.automationTargets[Number(e.target.value)]?.target;
            if (target) p.onShowLane(target);
            p.onClose();
          }}
        >
          <option value="">Show lane…</option>
          {p.automationTargets.map((t, i) => (
            <option key={i} value={i}>
              {t.label}
            </option>
          ))}
        </select>
      </label>
      {p.track.kind === "audio" && (
        <>
          <label>
            Input
            <select
              value={`${p.track.inputChannel}:${p.track.inputStereo}`}
              aria-label="Input"
              onChange={(e) => {
                const [channel, stereo] = e.target.value.split(":");
                p.onInput(Number(channel), stereo === "true");
              }}
            >
              {options.map((o) => (
                <option key={`${o.channel}:${o.stereo}`} value={`${o.channel}:${o.stereo}`}>
                  {o.label}
                </option>
              ))}
            </select>
          </label>
          <label>
            <input type="checkbox" checked={p.monitored} onChange={p.onMonitor} aria-label="Monitor input" />
            Monitor input
          </label>
        </>
      )}
      <button
        className="danger"
        onClick={() => {
          p.onClose();
          p.onDelete();
        }}
      >
        Delete track
      </button>
    </div>
  );
}
