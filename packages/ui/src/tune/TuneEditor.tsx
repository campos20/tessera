import type { Clip, Key, Note, Project, TuneAnalysis } from "@tessera/schema";
import type { Draft } from "immer";
import { type PointerEvent as ReactPointerEvent, useEffect, useMemo, useRef, useState } from "react";
import { useElementSize } from "../hooks/useElementSize";
import { usePlayhead } from "../hooks/usePlayhead";
import { useProject, useSession, useTune } from "../state/hooks";
import {
  correctPitch,
  enforceOrder,
  MIN_DURATION,
  NOTE_NAMES,
  quantizeTiming,
  splitNote,
  target,
} from "./model";
import { KEYBOARD, RULER, TuneCanvas, type TuneView } from "./TuneCanvas";
import "./Tune.css";

const KEYS: Key[] = (["major", "minor"] as const).flatMap((mode) =>
  NOTE_NAMES.map((_, tonic) => ({ tonic, mode })),
);
const keyLabel = (k: Key) => `${NOTE_NAMES[k.tonic]} ${k.mode}`;
const keyValue = (k: Key | null) => (k ? `${k.tonic}:${k.mode}` : "chromatic");
const PANEL = 232;

/** Bottom pane for note-level pitch and timing editing of the clip open in Tune. */
export function TuneEditor() {
  const session = useSession();
  const clipId = useTune((s) => s.editing);
  const analysis = useTune((s) => (clipId === undefined ? undefined : s.analyses.get(clipId)));
  const clip = useProject((s) => (clipId === undefined ? undefined : findClip(s.project, clipId)));
  const [height, setHeight] = useState(320);
  if (clipId === undefined || !analysis || !clip?.tune) return null;

  const onResize = (e: ReactPointerEvent<HTMLDivElement>) => {
    const startY = e.clientY;
    const start = height;
    const move = (ev: PointerEvent) =>
      setHeight(Math.round(Math.min(window.innerHeight * 0.8, Math.max(180, start + startY - ev.clientY))));
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  return (
    <section className="tune-pane" style={{ height }} aria-label="Tune editor" data-testid="tune-editor">
      <div className="tune-resizer" onPointerDown={onResize} />
      <TuneBody
        key={clipId}
        clip={clip as Clip & { tune: NonNullable<Clip["tune"]> }}
        analysis={analysis}
        onClose={() => session.closeTuneEditor()}
      />
    </section>
  );
}

interface BodyProps {
  clip: Clip & { tune: NonNullable<Clip["tune"]> };
  analysis: TuneAnalysis;
  onClose: () => void;
}

function TuneBody({ clip, analysis, onClose }: BodyProps) {
  const session = useSession();
  const project = useProject((s) => s.project);
  const bypass = useTune((s) => s.bypass.has(clip.id));
  const notes = clip.tune.notes;
  const keySig = clip.tune.key;
  const sr = project.sampleRate;
  const area = useRef<HTMLDivElement>(null);
  const size = useElementSize(area);

  // Clip window in source seconds, and where source time 0 sits on the timeline.
  const winStart = clip.offset / sr;
  const winEnd = (clip.offset + clip.length) / sr;
  const origin = (clip.start - clip.offset) / sr;

  const [picked, setSelected] = useState<ReadonlySet<number>>(new Set());
  const [view, setView] = useState<TuneView>(() => fitView(notes, winStart, winEnd, 600, 260));
  const fitted = useRef(false);
  useEffect(() => {
    if (fitted.current || size.width <= 0) return;
    fitted.current = true;
    setView(fitView(notes, winStart, winEnd, size.width - KEYBOARD, size.height - RULER));
  }, [size, notes, winStart, winEnd]);

  // Selected ids that still exist (undo and reset can remove notes).
  const selected = useMemo<ReadonlySet<number>>(() => {
    const ids = new Set(notes.map((n) => n.id));
    return [...picked].every((id) => ids.has(id)) ? picked : new Set([...picked].filter((id) => ids.has(id)));
  }, [notes, picked]);

  const [playhead, setPlayhead] = useState<number | undefined>();
  const [follow, setFollow] = useState(true);
  usePlayhead((frame) => {
    const t = frame / sr - origin;
    const inside = t >= winStart - 0.05 && t <= winEnd + 0.05;
    setPlayhead(inside ? Math.round(t * 1000) / 1000 : undefined);
    if (!follow || !inside || !session.transport.getState().playing) return;
    setView((v) => {
      const visible = (size.width - KEYBOARD) / v.pps;
      return t > v.t0 + visible * 0.92 || t < v.t0 ? { ...v, t0: t - visible * 0.1 } : v;
    });
  });

  const grid = useMemo(() => {
    const beat = 60 / project.tempo;
    const perBar = project.timeSignature.numerator;
    const out: [number, boolean][] = [];
    const first = Math.ceil((view.t0 + origin) / beat);
    const last = view.t0 + origin + Math.max(1, size.width) / view.pps;
    if (beat * view.pps < 6) return out;
    for (let k = Math.max(0, first); k * beat <= last; k++) out.push([k * beat - origin, k % perBar === 0]);
    return out;
  }, [project.tempo, project.timeSignature, view, origin, size.width]);

  /** Applies an undoable edit to this clip's notes (and optionally its key). */
  const edit = (
    label: string,
    recipe: (notes: Draft<Note>[], tune: Draft<NonNullable<Clip["tune"]>>) => void,
  ) =>
    session.store.getState().edit(label, (p) => {
      const tune = findClip(p, clip.id)?.tune;
      if (tune) recipe(tune.notes, tune);
    });
  const targets = () => (selected.size ? selected : new Set(notes.map((n) => n.id)));

  // Panel settings (not saved).
  const [center, setCenter] = useState(1);
  const [drift, setDrift] = useState(0.5);
  const [vibrato, setVibrato] = useState(0);
  const [division, setDivision] = useState(16);
  const [tolerance, setTolerance] = useState(0.08);
  const [strength, setStrength] = useState(1);

  const selNotes = notes.filter((n) => selected.has(n.id));
  const selDrift = selNotes.length ? selNotes.reduce((a, n) => a + n.drift, 0) / selNotes.length : 0;
  const selMod = selNotes.length ? selNotes.reduce((a, n) => a + n.mod, 0) / selNotes.length : 0;

  const setSelectionParam = (field: "drift" | "mod", value: number, phase: "move" | "end") => {
    const s = session.store.getState();
    if (!s.gesture) s.beginGesture(field === "drift" ? "Tune: drift" : "Tune: vibrato");
    const ids = new Set(selected);
    s.updateGesture((p) => {
      for (const n of findClip(p, clip.id)?.tune?.notes ?? []) if (ids.has(n.id)) n[field] = value;
    });
    if (phase === "end") s.commitGesture();
  };

  const moveSelection = (semitones: number) =>
    selected.size &&
    edit("Tune: move notes", (ns) => {
      for (const n of ns) if (selected.has(n.id)) n.shift = Math.round(target(n) + semitones) - n.center;
    });

  // Keys while the pointer is over the editor: arrows move notes, ⌘A selects all, Esc clears.
  const hover = useRef(false);
  const keys = useRef<(e: KeyboardEvent) => void>(() => {});
  const onKey = (e: KeyboardEvent) => {
    if (!hover.current || (e.target as HTMLElement).closest("input, select, textarea")) return;
    const mod = e.metaKey || e.ctrlKey;
    if (e.key === "ArrowUp" || e.key === "ArrowDown") {
      moveSelection((e.key === "ArrowUp" ? 1 : -1) * (e.shiftKey ? 12 : 1));
    } else if (mod && e.key.toLowerCase() === "a") {
      setSelected(new Set(notes.map((n) => n.id)));
    } else if (e.key === "Escape") {
      setSelected(new Set());
    } else return;
    e.preventDefault();
    e.stopImmediatePropagation();
  };
  useEffect(() => {
    keys.current = onKey;
  });
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => keys.current(e);
    window.addEventListener("keydown", onKey, { capture: true });
    return () => window.removeEventListener("keydown", onKey, { capture: true });
  }, []);

  const zoomToSelection = () => {
    const list = selNotes.length ? selNotes : notes;
    if (!list.length) return;
    const t0 = Math.min(...list.map((n) => n.ns));
    const t1 = Math.max(...list.map((n) => n.ne));
    setView(fitView(list, t0, t1, size.width - KEYBOARD, size.height - RULER));
  };

  return (
    <div className="tune-body">
      <div
        className="tune-area"
        ref={area}
        onPointerEnter={() => (hover.current = true)}
        onPointerLeave={() => (hover.current = false)}
      >
        {size.width > 0 && (
          <TuneCanvas
            width={size.width}
            height={size.height}
            analysis={analysis}
            notes={notes}
            keySig={keySig}
            selected={selected}
            view={view}
            playhead={playhead}
            grid={grid}
            duration={Math.min(analysis.duration, winEnd)}
            bypass={bypass}
            onView={setView}
            onSeek={(t) => session.seek(Math.max(0, Math.round((t + origin) * sr)))}
            onSelect={setSelected}
            onDrag={(phase, update) => {
              const s = session.store.getState();
              if (phase === "start") s.beginGesture("Tune: edit notes");
              else if (phase === "move" && update)
                s.updateGesture((p) => {
                  const tune = findClip(p, clip.id)?.tune;
                  if (tune) update(tune.notes);
                });
              else if (phase === "end") s.commitGesture();
              else if (phase === "cancel") s.cancelGesture();
            }}
            onSplit={(id, t) =>
              edit("Tune: split note", (ns) => {
                const i = ns.findIndex((n) => n.id === id);
                const nextId = Math.max(0, ...ns.map((n) => n.id)) + 1;
                splitNote(analysis, ns, i, t, nextId);
              })
            }
          />
        )}
      </div>
      <aside className="tune-panel" style={{ width: PANEL }}>
        <header>
          <strong title={clip.name}>Tune · {clip.name}</strong>
          <button className="tune-close" aria-label="Close Tune" onClick={onClose}>
            ✕
          </button>
        </header>
        <div className="tune-row">
          <button
            className={bypass ? "on" : ""}
            aria-pressed={bypass}
            title="Compare with the original audio"
            onClick={() => session.setTuneBypass(clip.id, !bypass)}
          >
            A/B {bypass ? "original" : "tuned"}
          </button>
          <button onClick={zoomToSelection} title="Zoom to the selection (or all notes)">
            Zoom
          </button>
          <label className="tune-check" title="Scroll with the playhead">
            <input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} />
            Follow
          </label>
        </div>

        <h4>Scale</h4>
        <select
          aria-label="Key"
          value={keyValue(keySig)}
          onChange={(e) => {
            const value = e.target.value;
            const key = KEYS.find((k) => keyValue(k) === value) ?? null;
            edit("Tune: key", (_, tune) => void (tune.key = key));
          }}
        >
          <option value="chromatic">Chromatic</option>
          {KEYS.map((k) => (
            <option key={keyValue(k)} value={keyValue(k)}>
              {keyLabel(k)}
              {keyValue(k) === keyValue(analysis.key) ? " (detected)" : ""}
            </option>
          ))}
        </select>

        <h4>Auto-correct {selected.size ? `${selected.size} selected` : "all notes"}</h4>
        <Slider label="Pitch center" value={center} onChange={setCenter} />
        <Slider label="Pitch drift" value={drift} onChange={setDrift} />
        <Slider label="Vibrato" value={vibrato} onChange={setVibrato} />
        <button
          className="primary"
          onClick={() =>
            edit("Tune: auto-correct", (ns) => {
              const ids = targets();
              correctPitch(
                ns.filter((n) => ids.has(n.id)),
                keySig,
                center,
                drift,
                vibrato,
              );
            })
          }
        >
          Correct pitch
        </button>

        <h4>Quantize timing ({project.tempo} BPM)</h4>
        <div className="tune-row">
          <select aria-label="Grid" value={division} onChange={(e) => setDivision(Number(e.target.value))}>
            <option value={4}>1/4</option>
            <option value={8}>1/8</option>
            <option value={16}>1/16</option>
            <option value={32}>1/32</option>
          </select>
          <label className="tune-inline">
            ±
            <input
              type="number"
              aria-label="Tolerance (ms)"
              min={5}
              max={500}
              step={5}
              value={Math.round(tolerance * 1000)}
              onChange={(e) => setTolerance(Math.max(0.005, Number(e.target.value) / 1000))}
            />
            ms
          </label>
        </div>
        <Slider label="Strength" value={strength} onChange={setStrength} />
        <button
          onClick={() =>
            edit("Tune: quantize", (ns) => {
              const beat = 60 / project.tempo;
              const phase = (((-origin % beat) + beat) % beat) as number;
              quantizeTiming(
                ns,
                selected.size ? new Set(selected) : null,
                project.tempo,
                phase,
                division,
                tolerance,
                strength,
              );
              enforceOrder(ns, new Set());
            })
          }
        >
          Quantize
        </button>

        <h4>Selection</h4>
        <Slider
          label="Drift"
          value={selDrift}
          disabled={!selected.size}
          onChange={(v) => setSelectionParam("drift", v, "move")}
          onCommit={(v) => setSelectionParam("drift", v, "end")}
        />
        <Slider
          label="Vibrato"
          value={selMod}
          disabled={!selected.size}
          onChange={(v) => setSelectionParam("mod", v, "move")}
          onCommit={(v) => setSelectionParam("mod", v, "end")}
        />
        <div className="tune-row">
          <button
            disabled={!selected.size}
            onClick={() => moveSelection(0)}
            title="Snap to the nearest semitone"
          >
            Snap
          </button>
          <button
            disabled={!selected.size}
            onClick={() =>
              edit("Tune: reset notes", (ns) => {
                for (const n of ns) if (selected.has(n.id)) resetNote(n);
                enforceOrder(ns, new Set());
              })
            }
          >
            Reset
          </button>
          <button
            onClick={() =>
              edit("Tune: reset all", (_, tune) => {
                tune.notes = analysis.notes.map((n) => ({ ...n }));
              })
            }
          >
            Reset all
          </button>
        </div>
        <p className="tune-hint">
          Drag notes up or down (Alt: free pitch), sideways to move them, edges to stretch. Double-click
          splits. Wheel scrolls; ⌘/Ctrl + wheel zooms time, Alt + wheel zooms pitch.
        </p>
      </aside>
    </div>
  );
}

function Slider(p: {
  label: string;
  value: number;
  disabled?: boolean;
  onChange: (v: number) => void;
  onCommit?: (v: number) => void;
}) {
  return (
    <label className="tune-slider">
      <span>{p.label}</span>
      <input
        type="range"
        min={0}
        max={100}
        aria-label={p.label}
        disabled={p.disabled}
        value={Math.round(p.value * 100)}
        onChange={(e) => p.onChange(Number(e.target.value) / 100)}
        onPointerUp={(e) => p.onCommit?.(Number(e.currentTarget.value) / 100)}
        onKeyUp={(e) => p.onCommit?.(Number(e.currentTarget.value) / 100)}
      />
      <output>{Math.round(p.value * 100)}%</output>
    </label>
  );
}

function resetNote(n: Draft<Note>) {
  n.shift = 0;
  n.drift = 0;
  n.mod = 0;
  n.ns = n.os;
  n.ne = Math.max(n.oe, n.os + MIN_DURATION);
}

function findClip<P extends Project | Draft<Project>>(project: P, clipId: number) {
  for (const track of project.tracks) {
    const clip = track.clips.find((c) => c.id === clipId);
    if (clip) return clip as P extends Project ? Clip : Draft<Clip>;
  }
  return undefined;
}

/** A view showing `[t0, t1]` and the pitch range of `notes` in a `width`×`height` area. */
function fitView(notes: readonly Note[], t0: number, t1: number, width: number, height: number): TuneView {
  const span = Math.max(0.5, t1 - t0);
  const pps = Math.max(10, Math.min(4000, (width * 0.96) / span));
  const pitches = notes.filter((n) => n.ne > t0 && n.ns < t1).map(target);
  const lo = pitches.length ? Math.min(...pitches) : 55;
  const hi = pitches.length ? Math.max(...pitches) : 67;
  const range = Math.max(12, hi - lo + 6);
  const ppst = Math.max(5, Math.min(40, height / range));
  const mid = (lo + hi) / 2;
  return { t0: t0 - span * 0.02, pps, ppst, top: mid + height / ppst / 2 };
}
