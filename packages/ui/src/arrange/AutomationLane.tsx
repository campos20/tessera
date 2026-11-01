import {
  DEVICES,
  type DeviceKind,
  type Lane,
  type ParamInfo,
  type Project,
  type Track,
} from "@tessera/schema";
import { type PointerEvent, useRef } from "react";
import { useCanvas } from "../hooks/useCanvas";
import { useGesture } from "../mixer/gesture";
import {
  faderToGain,
  formatDb,
  formatPan,
  formatParam,
  gainToFader,
  paramToUnit,
  unitToParam,
} from "../mixer/scale";
import { addPoint, findLane, movePoint, removeLane, removePoint } from "../model/edits";
import { useSession } from "../state/hooks";
import { frameToX, type GridLine, type View, xToFrame } from "./timeScale";

export const LANE_HEIGHT = 56;
const POINT_RADIUS = 4;
const HIT_PX = 7;

/** How a lane's values map to its height (0…1) and how to print them. */
export interface LaneScale {
  name: string;
  toUnit: (value: number) => number;
  fromUnit: (unit: number) => number;
  format: (value: number) => string;
}

export function laneScale(track: Track, lane: Lane, project: Project): LaneScale | undefined {
  const t = lane.target;
  const gain = { toUnit: gainToFader, fromUnit: faderToGain, format: (g: number) => `${formatDb(g)} dB` };
  switch (t.kind) {
    case "volume":
      return { name: "Volume", ...gain };
    case "pan":
      return { name: "Pan", toUnit: (p) => (p + 1) / 2, fromUnit: (u) => u * 2 - 1, format: formatPan };
    case "send": {
      const send = track.sends.find((s) => s.id === t.send);
      const bus = project.tracks.find((x) => x.id === send?.target);
      return send && { name: `Send → ${bus?.name ?? "?"}`, ...gain };
    }
    case "param": {
      const device = track.inserts.find((d) => d.id === t.device);
      const info = device && (DEVICES[device.kind as DeviceKind] as (typeof DEVICES)[DeviceKind] | undefined);
      const param: ParamInfo | undefined = info?.params.find((p) => p.id === t.param);
      if (!info || !param) return undefined;
      return {
        name: `${info.name}: ${param.name}`,
        toUnit: (v) => paramToUnit(param, v),
        fromUnit: (u) => unitToParam(param, u),
        format: (v) => formatParam(param, v),
      };
    }
  }
}

export interface AutomationLaneProps {
  track: Track;
  lane: Lane;
  scale: LaneScale;
  width: number;
  view: View;
  grid: GridLine[];
  snapFrame: (frame: number, bypass: boolean) => number;
}

/** Header and envelope editor for one automation lane, shown under its track. */
export function AutomationLane({ track, lane, scale, width, view, grid, snapFrame }: AutomationLaneProps) {
  const session = useSession();
  const canvas = useRef<HTMLCanvasElement>(null);
  const gesture = useGesture();
  /** `added`: the point was created by this drag (so each update re-adds it from the start). */
  const drag = useRef<{ index: number; added: boolean; g: ReturnType<typeof gesture> } | null>(null);
  const h = LANE_HEIGHT;
  const vy = (unit: number) => 4 + (1 - Math.min(1, Math.max(0, unit))) * (h - 8);
  const yu = (y: number) => 1 - (y - 4) / (h - 8);
  const edit = (label: string, recipe: Parameters<ReturnType<typeof gesture>["apply"]>[0]) =>
    session.store.getState().edit(label, recipe);

  useCanvas(
    canvas,
    width,
    h,
    (ctx, w) => {
      ctx.fillStyle = "#18181b";
      ctx.fillRect(0, 0, w, h);
      for (const line of grid) {
        if (line.kind === "sub") continue;
        const x = Math.round(frameToX(line.frame, view)) + 0.5;
        ctx.fillStyle = line.kind === "bar" ? "rgba(255,255,255,0.07)" : "rgba(255,255,255,0.03)";
        ctx.fillRect(x, 0, 1, h);
      }
      const pts = lane.points;
      ctx.strokeStyle = track.color;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      if (pts.length === 0) {
        ctx.setLineDash([4, 4]);
        ctx.moveTo(0, h / 2);
        ctx.lineTo(w, h / 2);
      } else {
        ctx.moveTo(0, vy(scale.toUnit(pts[0]!.value)));
        for (const p of pts) ctx.lineTo(frameToX(p.frame, view), vy(scale.toUnit(p.value)));
        ctx.lineTo(w, vy(scale.toUnit(pts[pts.length - 1]!.value)));
      }
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.lineWidth = 1;
      // Area under the envelope.
      if (pts.length) {
        ctx.lineTo(w, h);
        ctx.lineTo(0, h);
        ctx.closePath();
        ctx.globalAlpha = 0.12;
        ctx.fillStyle = track.color;
        ctx.fill();
        ctx.globalAlpha = 1;
      }
      for (const p of pts) {
        const x = frameToX(p.frame, view);
        if (x < -POINT_RADIUS || x > w + POINT_RADIUS) continue;
        ctx.beginPath();
        ctx.arc(x, vy(scale.toUnit(p.value)), POINT_RADIUS, 0, Math.PI * 2);
        ctx.fillStyle = "#f2f2f5";
        ctx.fill();
        ctx.strokeStyle = track.color;
        ctx.stroke();
      }
      ctx.fillStyle = "#2a2a2e";
      ctx.fillRect(0, h - 1, w, 1);
    },
    [lane, view, grid, track.color, scale],
  );

  const local = (e: { currentTarget: HTMLCanvasElement; clientX: number; clientY: number }) => {
    const r = e.currentTarget.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };
  const hit = (x: number, y: number) =>
    lane.points.findIndex(
      (p) => Math.hypot(frameToX(p.frame, view) - x, vy(scale.toUnit(p.value)) - y) <= HIT_PX,
    );

  const onPointerDown = (e: PointerEvent<HTMLCanvasElement>) => {
    if (e.button !== 0) return;
    const { x, y } = local(e);
    const index = hit(x, y);
    if (index >= 0 && e.altKey) {
      edit("Remove automation point", (p) => removePoint(p, lane.id, index));
      return;
    }
    e.currentTarget.setPointerCapture(e.pointerId);
    const g = gesture(index >= 0 ? "Move automation point" : "Add automation point");
    g.onPointerDown();
    if (index >= 0) {
      drag.current = { index, added: false, g };
      return;
    }
    const frame = snapFrame(xToFrame(Math.max(0, x), view), e.metaKey || e.ctrlKey);
    const value = scale.fromUnit(yu(y));
    g.apply((p) => void addPoint(p, lane.id, frame, value));
    drag.current = { index: -1, added: true, g };
  };

  const onPointerMove = (e: PointerEvent<HTMLCanvasElement>) => {
    const { x, y } = local(e);
    const d = drag.current;
    if (!d) {
      e.currentTarget.style.cursor = hit(x, y) >= 0 ? "grab" : "crosshair";
      return;
    }
    const frame = snapFrame(xToFrame(Math.max(0, x), view), e.metaKey || e.ctrlKey);
    const value = scale.fromUnit(yu(y));
    // Updates replay from the gesture's start, so a point this drag created is added again.
    d.g.apply((p) =>
      d.added ? void addPoint(p, lane.id, frame, value) : movePoint(p, lane.id, d.index, frame, value),
    );
  };

  const onPointerUp = () => {
    drag.current?.g.onPointerUp();
    drag.current = null;
  };

  return (
    <canvas
      ref={canvas}
      className="automation-lane"
      style={{ width, height: h }}
      data-testid={`lane-automation-${lane.id}`}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onDoubleClick={(e) => {
        const { x, y } = local(e);
        const index = hit(x, y);
        if (index >= 0) edit("Remove automation point", (p) => removePoint(p, lane.id, index));
      }}
    />
  );
}

export function LaneHeader({ lane, scale, width }: { lane: Lane; scale: LaneScale; width: number }) {
  const session = useSession();
  const edit = (label: string, recipe: Parameters<ReturnType<ReturnType<typeof useGesture>>["apply"]>[0]) =>
    session.store.getState().edit(label, recipe);
  return (
    <div className="lane-header" style={{ width, height: LANE_HEIGHT }}>
      <span className="lane-name" title={scale.name}>
        {scale.name}
      </span>
      <span className="lane-value">
        {lane.points.length
          ? `${lane.points.length} point${lane.points.length === 1 ? "" : "s"}`
          : "Click to add points"}
      </span>
      <div className="lane-buttons">
        <button
          aria-label={`Hide ${scale.name} automation`}
          title="Hide (keeps the automation)"
          onClick={() =>
            edit("Hide lane", (p) => {
              const l = findLane(p, lane.id)?.lane;
              if (l) l.visible = false;
            })
          }
        >
          Hide
        </button>
        <button
          aria-label={`Delete ${scale.name} automation`}
          title="Delete the lane and its points"
          onClick={() => edit("Delete automation", (p) => removeLane(p, lane.id))}
        >
          ✕
        </button>
      </div>
    </div>
  );
}
