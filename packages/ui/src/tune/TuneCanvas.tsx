import type { Key, Note, TuneAnalysis } from "@tessera/schema";
import { type PointerEvent, useEffect, useRef, useState } from "react";
import { useCanvas } from "../hooks/useCanvas";
import { frameOut, MIN_DURATION, noteCurves, noteName, scalePitchClasses, target } from "./model";

/** Visible window: seconds at the left edge, pixels per second, top pitch, pixels per semitone. */
export interface TuneView {
  t0: number;
  pps: number;
  top: number;
  ppst: number;
}

export const KEYBOARD = 46;
export const RULER = 22;

export interface TuneCanvasProps {
  width: number;
  height: number;
  analysis: TuneAnalysis;
  notes: Note[];
  keySig: Key | null;
  selected: ReadonlySet<number>;
  view: TuneView;
  /** Playhead in clip output seconds (undefined when outside the clip). */
  playhead: number | undefined;
  /** Beat grid lines in clip output seconds, `true` for bar lines. */
  grid: [time: number, bar: boolean][];
  duration: number;
  bypass: boolean;
  onView: (view: TuneView) => void;
  onSeek: (t: number) => void;
  onSelect: (ids: Set<number>) => void;
  /** Drag gestures: `start`, then `move` with the latest notes, then `end` (or `cancel`). */
  onDrag: (phase: "start" | "move" | "end" | "cancel", update?: (notes: Note[]) => void) => void;
  onSplit: (noteId: number, t: number) => void;
}

type Drag =
  | { mode: "seek" }
  | { mode: "band"; x0: number; y0: number; base: Set<number> }
  | { mode: "body" | "left" | "right"; note: Note; x0: number; y0: number; axis?: "x" | "y"; moved: boolean };

type Hit = { note: Note; part: "body" | "left" | "right" };

const BLACK = [1, 3, 6, 8, 10];
const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));
const fmtCents = (c: number) => `${c >= 0 ? "+" : "−"}${Math.abs(Math.round(c))}¢`;

/** Piano-roll canvas of the Tune editor: draws notes and turns pointer input into edits. */
export function TuneCanvas(p: TuneCanvasProps) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const { view, analysis: an } = p;
  const tx = (t: number) => KEYBOARD + (t - view.t0) * view.pps;
  const xt = (x: number) => view.t0 + (x - KEYBOARD) / view.pps;
  const my = (m: number) => RULER + (view.top - m) * view.ppst;
  const ym = (y: number) => view.top - (y - RULER) / view.ppst;
  const drag = useRef<Drag | null>(null);
  /** Box-selection rectangle while dragging one. */
  const [band, setBand] = useState<{ x0: number; y0: number; x1: number; y1: number }>();

  useCanvas(
    canvas,
    p.width,
    p.height,
    (ctx, W, H) => {
      ctx.fillStyle = "#141417";
      ctx.fillRect(0, 0, W, H);
      const pcs = scalePitchClasses(p.keySig);
      const mLo = Math.floor(ym(H)) - 1;
      const mHi = Math.ceil(ym(RULER)) + 1;
      // Rows: scale notes lighter, octave lines.
      for (let m = mLo; m <= mHi; m++) {
        const pc = ((m % 12) + 12) % 12;
        const black = BLACK.includes(pc);
        ctx.fillStyle = pcs.includes(pc) ? (black ? "#1a1a1f" : "#1e1e23") : black ? "#121215" : "#16161a";
        ctx.fillRect(KEYBOARD, my(m + 0.5), W - KEYBOARD, view.ppst);
        ctx.fillStyle = pc === 0 ? "#34343b" : "#202026";
        ctx.fillRect(KEYBOARD, my(m - 0.5), W - KEYBOARD, 1);
      }
      // Beat grid from the project tempo.
      for (const [t, bar] of p.grid) {
        const x = Math.round(tx(t)) + 0.5;
        if (x < KEYBOARD || x > W) continue;
        ctx.strokeStyle = bar ? "#3a3a42" : "#26262c";
        ctx.beginPath();
        ctx.moveTo(x, RULER);
        ctx.lineTo(x, H);
        ctx.stroke();
      }
      // Past the end of the audio.
      const xe = tx(p.duration);
      if (xe < W) {
        ctx.fillStyle = "rgba(0,0,0,0.35)";
        ctx.fillRect(Math.max(KEYBOARD, xe), RULER, W - xe, H - RULER);
      }
      const maxRms = an.maxRms || 1;
      for (const n of p.notes) {
        const x0 = tx(n.ns);
        const x1 = tx(n.ne);
        if (x1 < KEYBOARD - 5 || x0 > W + 5) continue;
        const sel = p.selected.has(n.id);
        const cy = my(target(n));
        const curves = curvesFor(an, n);
        // Ghost of where the note was sung.
        if (Math.abs(n.shift) > 0.05 || Math.abs(n.ns - n.os) > 0.003 || Math.abs(n.ne - n.oe) > 0.003) {
          ctx.strokeStyle = "rgba(160,160,170,0.35)";
          ctx.setLineDash([3, 3]);
          const gy = my(n.center);
          ctx.strokeRect(tx(n.os), gy - view.ppst * 0.35, Math.max(2, tx(n.oe) - tx(n.os)), view.ppst * 0.7);
          ctx.setLineDash([]);
        }
        // Blob: the note's loudness envelope around its target pitch.
        const len = n.e - n.s;
        const step = Math.max(1, Math.floor(len / Math.max(8, (x1 - x0) / 2)));
        const top: [number, number][] = [[x0, cy]];
        const bottom: [number, number][] = [[x0, cy]];
        for (let i = 0; i < len; i += step) {
          const f = n.s + i;
          const x = tx(frameOut(an, n, f));
          const a = Math.sqrt(clamp((an.rms[f] ?? 0) / maxRms, 0, 1));
          const th = Math.max(2.5, a * view.ppst * 1.25);
          top.push([x, cy - th / 2]);
          bottom.push([x, cy + th / 2]);
        }
        top.push([x1, cy]);
        bottom.push([x1, cy]);
        ctx.beginPath();
        ctx.moveTo(top[0]![0], top[0]![1]);
        for (const [x, y] of top) ctx.lineTo(x, y);
        for (let i = bottom.length - 1; i >= 0; i--) ctx.lineTo(bottom[i]![0], bottom[i]![1]);
        ctx.closePath();
        ctx.fillStyle = sel ? "#ff9f0a" : p.bypass ? "#5a5a66" : "#bf5af2";
        ctx.globalAlpha = 0.8;
        ctx.fill();
        ctx.globalAlpha = 1;
        // Sung pitch (dim) and target pitch (bright).
        const curve = (values: (number | null)[], color: string, width: number) => {
          ctx.strokeStyle = color;
          ctx.lineWidth = width;
          ctx.beginPath();
          let pen = false;
          for (let i = 0; i < len; i += step) {
            const v = values[i];
            if (v === null || v === undefined || curves.sung[i] === null) {
              pen = false;
              continue;
            }
            const x = tx(frameOut(an, n, n.s + i));
            if (pen) ctx.lineTo(x, my(v));
            else ctx.moveTo(x, my(v));
            pen = true;
          }
          ctx.stroke();
          ctx.lineWidth = 1;
        };
        curve(curves.sung, "rgba(220,220,230,0.35)", 1);
        curve(curves.target, sel ? "#2b1a03" : "#f2e6ff", 1.4);
        if (x1 - x0 > 34 && view.ppst >= 10) {
          const t = target(n);
          const dev = (t - Math.round(t)) * 100;
          ctx.fillStyle = "#b8b8c2";
          ctx.font = "10.5px ui-monospace, Menlo, monospace";
          ctx.fillText(
            noteName(t) + (Math.abs(dev) >= 3 ? ` ${fmtCents(dev)}` : ""),
            x0 + 2,
            cy - view.ppst * 0.75 - 2,
          );
        }
      }
      // Box selection.
      if (band) {
        ctx.fillStyle = "rgba(255,159,10,0.08)";
        ctx.strokeStyle = "rgba(255,159,10,0.6)";
        const rx = Math.min(band.x0, band.x1);
        const ry = Math.min(band.y0, band.y1);
        ctx.fillRect(rx, ry, Math.abs(band.x1 - band.x0), Math.abs(band.y1 - band.y0));
        ctx.strokeRect(rx + 0.5, ry + 0.5, Math.abs(band.x1 - band.x0), Math.abs(band.y1 - band.y0));
      }
      // Keyboard.
      ctx.fillStyle = "#101013";
      ctx.fillRect(0, RULER, KEYBOARD, H - RULER);
      for (let m = mLo; m <= mHi; m++) {
        const pc = ((m % 12) + 12) % 12;
        const black = BLACK.includes(pc);
        const y = my(m + 0.5);
        ctx.fillStyle = black ? "#1d1d22" : pcs.includes(pc) ? "#d6d6dc" : "#a9a9b1";
        ctx.fillRect(0, y, black ? KEYBOARD * 0.6 : KEYBOARD, view.ppst - (black ? 0 : 1));
        if (!black && (pc === 0 || view.ppst >= 14)) {
          ctx.fillStyle = "#2a2a30";
          ctx.font = "9.5px ui-monospace, Menlo, monospace";
          ctx.fillText(noteName(m), KEYBOARD - 26, y + view.ppst / 2 + 3.5);
        }
      }
      // Ruler (seconds within the clip).
      ctx.fillStyle = "#19191d";
      ctx.fillRect(0, 0, W, RULER);
      const tick = [0.1, 0.25, 0.5, 1, 2, 5, 10, 30].find((s) => s * view.pps > 70) ?? 60;
      ctx.font = "10px ui-monospace, Menlo, monospace";
      ctx.fillStyle = "#8e8e98";
      ctx.strokeStyle = "#3a3a42";
      for (let t = Math.floor(xt(KEYBOARD) / tick) * tick; t < xt(W); t += tick) {
        const x = Math.round(tx(t)) + 0.5;
        if (x < KEYBOARD) continue;
        ctx.beginPath();
        ctx.moveTo(x, RULER - 6);
        ctx.lineTo(x, RULER);
        ctx.stroke();
        ctx.fillText(`${t.toFixed(tick < 0.5 ? 2 : tick < 1 ? 1 : 0)}s`, x + 3, 14);
      }
      // Playhead.
      if (p.playhead !== undefined) {
        const x = Math.round(tx(p.playhead)) + 0.5;
        if (x >= KEYBOARD) {
          ctx.strokeStyle = p.bypass ? "#8fb4ff" : "#ff9f0a";
          ctx.lineWidth = 1.5;
          ctx.beginPath();
          ctx.moveTo(x, 0);
          ctx.lineTo(x, H);
          ctx.stroke();
          ctx.lineWidth = 1;
        }
      }
      ctx.fillStyle = "#19191d";
      ctx.fillRect(0, 0, KEYBOARD, RULER);
      ctx.fillStyle = p.bypass ? "#8fb4ff" : "#ff9f0a";
      ctx.font = "600 9.5px system-ui, sans-serif";
      ctx.fillText(p.bypass ? "ORIG" : "TUNE", 8, 15);
    },
    [p.notes, p.selected, view, p.playhead, p.grid, p.keySig, p.bypass, an, p.duration, band],
  );

  // Pointer interaction --------------------------------------------------------------------

  const hit = (x: number, y: number): Hit | undefined => {
    if (y < RULER || x < KEYBOARD) return undefined;
    let best: (Hit & { d: number }) | undefined;
    for (const n of p.notes) {
      const x0 = tx(n.ns);
      const x1 = tx(n.ne);
      const cy = my(target(n));
      if (x < x0 - 4 || x > x1 + 4 || Math.abs(y - cy) > Math.max(7, view.ppst * 0.75)) continue;
      const edge = Math.min(6, (x1 - x0) / 4);
      const part = x - x0 < edge ? "left" : x1 - x < edge ? "right" : "body";
      const d = Math.abs(y - cy);
      if (!best || d < best.d) best = { note: n, part, d };
    }
    return best;
  };

  const local = (e: PointerEvent | WheelEvent | React.MouseEvent) => {
    const r = canvas.current!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  const onPointerDown = (e: PointerEvent<HTMLCanvasElement>) => {
    if (e.button !== 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    const { x, y } = local(e);
    if (y < RULER && x > KEYBOARD) {
      p.onSeek(Math.max(0, xt(x)));
      drag.current = { mode: "seek" };
      return;
    }
    const h = hit(x, y);
    const additive = e.shiftKey || e.metaKey || e.ctrlKey;
    if (h) {
      const sel = new Set(p.selected);
      if (additive) {
        if (sel.has(h.note.id)) sel.delete(h.note.id);
        else sel.add(h.note.id);
      } else if (!sel.has(h.note.id)) {
        sel.clear();
        sel.add(h.note.id);
      }
      p.onSelect(sel);
      if (!additive) {
        drag.current = { mode: h.part, note: h.note, x0: x, y0: y, moved: false };
        p.onDrag("start");
      }
    } else {
      const base = additive ? new Set(p.selected) : new Set<number>();
      p.onSelect(base);
      drag.current = { mode: "band", x0: x, y0: y, base };
    }
  };

  const onPointerMove = (e: PointerEvent<HTMLCanvasElement>) => {
    const { x, y } = local(e);
    const d = drag.current;
    if (!d) {
      const h = hit(x, y);
      e.currentTarget.style.cursor =
        y < RULER ? "pointer" : h ? (h.part === "body" ? "grab" : "ew-resize") : "default";
      return;
    }
    if (d.mode === "seek") {
      p.onSeek(Math.max(0, xt(x)));
      return;
    }
    if (d.mode === "band") {
      setBand({ x0: d.x0, y0: d.y0, x1: x, y1: y });
      const sel = new Set(d.base);
      const t0 = xt(Math.min(d.x0, x));
      const t1 = xt(Math.max(d.x0, x));
      const m0 = ym(Math.max(d.y0, y));
      const m1 = ym(Math.min(d.y0, y));
      for (const n of p.notes) {
        const c = target(n);
        if (n.ne > t0 && n.ns < t1 && c > m0 - 0.5 && c < m1 + 0.5) sel.add(n.id);
      }
      p.onSelect(sel);
      return;
    }
    const dx = x - d.x0;
    const dy = y - d.y0;
    if (!d.moved && Math.hypot(dx, dy) < 4) return;
    d.moved = true;
    e.currentTarget.style.cursor = "grabbing";
    const id = d.note.id;
    const selected = new Set(p.selected);
    const free = e.altKey;
    if (d.mode === "body") d.axis ??= Math.abs(dy) > Math.abs(dx) ? "y" : "x";
    const axis = d.axis;
    const mode = d.mode;
    p.onDrag("move", (notes) => {
      // `notes` is the state before the drag: apply the whole drag from there.
      const sorted = [...notes].sort((a, b) => a.ns - b.ns);
      const n = notes.find((m) => m.id === id);
      if (!n) return;
      const i = sorted.indexOf(n);
      const prev = sorted[i - 1];
      const next = sorted[i + 1];
      const touchPrev = prev !== undefined && Math.abs(prev.ne - n.ns) < 1e-3;
      const touchNext = next !== undefined && Math.abs(n.ne - next.ns) < 1e-3;
      if (mode === "body" && axis === "y") {
        const ds = -dy / view.ppst;
        for (const m of notes) {
          if (!selected.has(m.id)) continue;
          let t = target(m) + ds;
          if (!free) t = Math.round(t);
          m.shift = t - m.center;
        }
      } else if (mode === "body" && selected.size === 1) {
        let dt = dx / view.pps;
        const lo = prev ? (touchPrev ? prev.ns + MIN_DURATION : prev.ne) : 0;
        const hi = next ? (touchNext ? next.ne - MIN_DURATION : next.ns) : Infinity;
        dt = clamp(dt, lo - n.ns, hi - n.ne);
        n.ns += dt;
        n.ne += dt;
        if (touchPrev) prev.ne = n.ns;
        if (touchNext) next.ns = n.ne;
      } else if (mode === "left") {
        const lo = prev ? (touchPrev ? prev.ns + MIN_DURATION : prev.ne) : 0;
        n.ns = clamp(n.ns + dx / view.pps, lo, n.ne - MIN_DURATION);
        if (touchPrev) prev.ne = n.ns;
      } else if (mode === "right") {
        const hi = next ? (touchNext ? next.ne - MIN_DURATION : next.ns) : Infinity;
        n.ne = clamp(n.ne + dx / view.pps, n.ns + MIN_DURATION, hi);
        if (touchNext) next.ns = n.ne;
      }
    });
  };

  const onPointerUp = () => {
    const d = drag.current;
    drag.current = null;
    if (d && "note" in d) p.onDrag(d.moved ? "end" : "cancel");
    if (d?.mode === "band") setBand(undefined);
  };

  // Native wheel listener: zoom and scroll without the page zooming.
  const latest = useRef(p);
  useEffect(() => {
    latest.current = p;
  });
  useEffect(() => {
    const el = canvas.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const { view: v, onView } = latest.current;
      const r = el.getBoundingClientRect();
      const x = e.clientX - r.left;
      const y = e.clientY - r.top;
      if (e.ctrlKey || e.metaKey) {
        const t = v.t0 + (x - KEYBOARD) / v.pps;
        const pps = clamp(v.pps * Math.exp(-e.deltaY * 0.0025), 10, 4000);
        onView({ ...v, pps, t0: Math.max(-0.5, t - (x - KEYBOARD) / pps) });
      } else if (e.altKey) {
        const m = v.top - (y - RULER) / v.ppst;
        const ppst = clamp(v.ppst * Math.exp(-e.deltaY * 0.002), 5, 60);
        onView({ ...v, ppst, top: m + (y - RULER) / ppst });
      } else if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
        onView({ ...v, t0: Math.max(-0.5, v.t0 + (e.shiftKey ? e.deltaY : e.deltaX) / v.pps) });
      } else {
        onView({ ...v, top: v.top + (e.deltaY / v.ppst) * 0.5 });
      }
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  return (
    <canvas
      ref={canvas}
      className="tune-canvas"
      style={{ width: p.width, height: p.height }}
      data-testid="tune-canvas"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onDoubleClick={(e) => {
        const { x, y } = local(e);
        const h = hit(x, y);
        if (h) p.onSplit(h.note.id, xt(x));
      }}
    />
  );
}

/** Curves per note object; immer keeps unchanged notes identical, so this caches well. */
const curveCache = new WeakMap<Note, ReturnType<typeof noteCurves>>();
function curvesFor(an: TuneAnalysis, n: Note) {
  let c = curveCache.get(n);
  if (!c) {
    c = noteCurves(an, n);
    curveCache.set(n, c);
  }
  return c;
}
