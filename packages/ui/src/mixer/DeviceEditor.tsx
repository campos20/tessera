import { DEVICES, type Device, type DeviceKind, type ParamInfo } from "@tessera/schema";
import { type PointerEvent, useRef } from "react";
import { useCanvas } from "../hooks/useCanvas";
import {
  addPoint,
  ensureLane,
  findDevice,
  findLane,
  moveDevice,
  paramValue,
  removeDevice,
  setParam,
} from "../model/edits";
import { useProject, useSession, useTransport } from "../state/hooks";
import type { Recipe } from "../state/store";
import { BAND_TYPES, bands, EQ_BANDS, hasGain, responseDb } from "./eqCurve";
import { useGesture } from "./gesture";
import { formatParam, paramToUnit, unitToParam } from "./scale";

const DYNAMICS = new Set(["compressor", "gate", "limiter"]);

/** Floating editor for one device: its parameters, bypass, order and automation. */
export function DeviceEditor({ deviceId, onClose }: { deviceId: number; onClose: () => void }) {
  const session = useSession();
  const project = useProject((s) => s.project);
  const found = findDevice(project, deviceId);
  const gr = useTransport((s) => s.reduction.get(deviceId) ?? 0);
  if (!found) return null;
  const { device, chain, track } = found;
  const info = DEVICES[device.kind as DeviceKind] as (typeof DEVICES)[DeviceKind] | undefined;
  const index = chain.indexOf(device);
  const edit = (label: string, recipe: Recipe) => session.store.getState().edit(label, recipe);
  const automate = (param: ParamInfo) =>
    track &&
    edit(`Automate ${param.name}`, (p) => {
      const lane = ensureLane(p, track.id, { kind: "param", device: device.id, param: param.id });
      const l = lane === undefined ? undefined : findLane(p, lane)?.lane;
      if (l && l.points.length === 0) addPoint(p, l.id, 0, paramValue(device, param.id));
    });

  return (
    <div className="device-editor" role="dialog" aria-label={`${info?.name ?? device.kind} settings`}>
      <header>
        <strong>
          {track?.name ?? "Master"} › {info?.name ?? device.kind}
        </strong>
        {DYNAMICS.has(device.kind) && (
          <span className="gr-readout" title="Gain reduction" data-testid="gain-reduction">
            <span className="gr-bar" style={{ width: `${Math.min(100, gr * 4)}%` }} />
            GR {gr.toFixed(1)} dB
          </span>
        )}
        <span className="spacer" />
        <button
          className={device.bypass ? "" : "on"}
          aria-pressed={!device.bypass}
          onClick={() =>
            edit("Bypass device", (p) => {
              const d = findDevice(p, deviceId)?.device;
              if (d) d.bypass = !d.bypass;
            })
          }
        >
          {device.bypass ? "Bypassed" : "On"}
        </button>
        <button
          disabled={index <= 0}
          aria-label="Move earlier"
          onClick={() => edit("Move device", (p) => moveDevice(p, deviceId, index - 1))}
        >
          ◀
        </button>
        <button
          disabled={index >= chain.length - 1}
          aria-label="Move later"
          onClick={() => edit("Move device", (p) => moveDevice(p, deviceId, index + 1))}
        >
          ▶
        </button>
        <button
          aria-label="Remove device"
          onClick={() => {
            edit("Remove device", (p) => removeDevice(p, deviceId));
            onClose();
          }}
        >
          Remove
        </button>
        <button className="pane-close" aria-label="Close device" onClick={onClose}>
          ✕
        </button>
      </header>
      {!info ? (
        <p className="device-note">This device comes from a newer version of Tessera and is bypassed.</p>
      ) : device.kind === "eq" ? (
        <EqEditor device={device} onAutomate={track ? automate : undefined} />
      ) : (
        <div className="param-grid">
          {info.params.map((param) => (
            <ParamControl
              key={param.id}
              device={device}
              param={param}
              onAutomate={track ? () => automate(param) : undefined}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function ParamControl({
  device,
  param,
  onAutomate,
  compact,
}: {
  device: Device;
  param: ParamInfo;
  onAutomate?: () => void;
  compact?: boolean;
}) {
  const session = useSession();
  const gesture = useGesture()(`${param.name}`);
  const value = paramValue(device, param.id);
  const set = (v: number) => gesture.apply((p) => setParam(p, device.id, param.id, v));
  const reset = () =>
    session.store
      .getState()
      .edit(`Reset ${param.name}`, (p) => setParam(p, device.id, param.id, param.default));
  let control;
  if (param.scale === "choice") {
    control = (
      <select aria-label={param.name} value={Math.round(value)} onChange={(e) => set(Number(e.target.value))}>
        {param.options?.map((o, i) => (
          <option key={o} value={i}>
            {o}
          </option>
        ))}
      </select>
    );
  } else if (param.scale === "toggle") {
    control = (
      <input
        type="checkbox"
        aria-label={param.name}
        checked={value >= 0.5}
        onChange={(e) => set(e.target.checked ? 1 : 0)}
      />
    );
  } else {
    control = (
      <input
        type="range"
        min={0}
        max={1000}
        aria-label={param.name}
        value={Math.round(paramToUnit(param, value) * 1000)}
        onPointerDown={gesture.onPointerDown}
        onPointerUp={gesture.onPointerUp}
        onDoubleClick={reset}
        onChange={(e) => set(unitToParam(param, Number(e.target.value) / 1000))}
      />
    );
  }
  return (
    <label className={compact ? "param compact" : "param"}>
      {!compact && <span className="param-name">{param.name}</span>}
      {control}
      {/* Selects and checkboxes show their own state; compact rows skip the readout. */}
      {!(compact && (param.scale === "choice" || param.scale === "toggle")) && (
        <output>{formatParam(param, value)}</output>
      )}
      {onAutomate && (
        <button
          type="button"
          className="mini"
          title={`Automate ${param.name}`}
          aria-label={`Automate ${param.name}`}
          onClick={onAutomate}
        >
          A
        </button>
      )}
    </label>
  );
}

const EQ_W = 560;
const EQ_H = 170;
const F_MIN = 20;
const F_MAX = 20_000;
const DB_RANGE = 24;
const BAND_COLORS = ["#ff9f0a", "#ffd60a", "#30d158", "#64d2ff", "#0a84ff", "#bf5af2", "#ff375f", "#ac8e68"];

function EqEditor({ device, onAutomate }: { device: Device; onAutomate?: (p: ParamInfo) => void }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const gesture = useGesture();
  const drag = useRef<{ band: number; g: ReturnType<typeof gesture> } | null>(null);
  const list = bands(device);
  const params = DEVICES.eq.params;
  const fx = (f: number) => (Math.log(f / F_MIN) / Math.log(F_MAX / F_MIN)) * EQ_W;
  const xf = (x: number) => F_MIN * (F_MAX / F_MIN) ** Math.min(1, Math.max(0, x / EQ_W));
  const dy = (db: number) => EQ_H / 2 - (db / DB_RANGE) * (EQ_H / 2 - 8);
  const yd = (y: number) => ((EQ_H / 2 - y) / (EQ_H / 2 - 8)) * DB_RANGE;

  useCanvas(
    canvas,
    EQ_W,
    EQ_H,
    (ctx, w, h) => {
      ctx.fillStyle = "#141417";
      ctx.fillRect(0, 0, w, h);
      ctx.strokeStyle = "#26262c";
      ctx.fillStyle = "#6b6b73";
      ctx.font = "9.5px ui-monospace, Menlo, monospace";
      for (const f of [50, 100, 200, 500, 1000, 2000, 5000, 10000]) {
        const x = Math.round(fx(f)) + 0.5;
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, h);
        ctx.stroke();
        ctx.fillText(f >= 1000 ? `${f / 1000}k` : `${f}`, x + 2, h - 3);
      }
      for (const db of [-18, -12, -6, 0, 6, 12, 18]) {
        const y = Math.round(dy(db)) + 0.5;
        ctx.strokeStyle = db === 0 ? "#3a3a42" : "#202026";
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(w, y);
        ctx.stroke();
      }
      ctx.strokeStyle = device.bypass ? "#6b6b73" : "#ff9f0a";
      ctx.lineWidth = 2;
      ctx.beginPath();
      for (let x = 0; x <= w; x += 2) {
        const y = dy(responseDb(device, xf(x)));
        if (x === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
      ctx.lineWidth = 1;
      for (const b of list) {
        const x = fx(b.freq);
        const y = dy(hasGain(b.type) ? b.gain : 0);
        ctx.beginPath();
        ctx.arc(x, y, 6, 0, Math.PI * 2);
        ctx.fillStyle = b.on ? BAND_COLORS[b.index]! : "#2a2a2e";
        ctx.fill();
        ctx.strokeStyle = "#101013";
        ctx.stroke();
        ctx.fillStyle = b.on ? "#101013" : "#8e8e98";
        ctx.fillText(String(b.index + 1), x - 3, y + 3.5);
      }
    },
    [device],
  );

  const at = (e: PointerEvent<HTMLCanvasElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };
  const onDown = (e: PointerEvent<HTMLCanvasElement>) => {
    const { x, y } = at(e);
    let best = -1;
    let dist = 14;
    for (const b of list) {
      const d = Math.hypot(fx(b.freq) - x, dy(hasGain(b.type) ? b.gain : 0) - y);
      if (d < dist) {
        dist = d;
        best = b.index;
      }
    }
    if (best < 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    const g = gesture(`EQ band ${best + 1}`);
    g.onPointerDown();
    drag.current = { band: best, g };
  };
  const onMove = (e: PointerEvent<HTMLCanvasElement>) => {
    const d = drag.current;
    if (!d) return;
    const { x, y } = at(e);
    const n = d.band + 1;
    const type = list[d.band]!.type;
    const freq = xf(x);
    const gain = Math.max(-DB_RANGE, Math.min(DB_RANGE, yd(y)));
    d.g.apply((p) => {
      setParam(p, device.id, `b${n}On`, 1);
      setParam(p, device.id, `b${n}Freq`, freq);
      if (hasGain(type)) setParam(p, device.id, `b${n}Gain`, Math.round(gain * 10) / 10);
    });
  };
  const onUp = () => {
    drag.current?.g.onPointerUp();
    drag.current = null;
  };

  return (
    <div className="eq-editor">
      <canvas
        ref={canvas}
        className="eq-canvas"
        style={{ width: EQ_W, height: EQ_H }}
        data-testid="eq-curve"
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={onUp}
      />
      <div className="eq-bands">
        <div className="eq-band head">
          <span />
          <span>Type</span>
          <span>Frequency</span>
          <span>Gain</span>
          <span>Q</span>
        </div>
        {Array.from({ length: EQ_BANDS }, (_, i) => {
          const p = (k: number) => params[i * 5 + k]!;
          return (
            <div className="eq-band" key={i} style={{ ["--band" as string]: BAND_COLORS[i] }}>
              <ParamControl device={device} param={p(0)} compact />
              <ParamControl device={device} param={p(1)} compact />
              <ParamControl
                device={device}
                param={p(2)}
                compact
                onAutomate={onAutomate && (() => onAutomate(p(2)))}
              />
              {hasGain(list[i]!.type) ? (
                <ParamControl
                  device={device}
                  param={p(3)}
                  compact
                  onAutomate={onAutomate && (() => onAutomate(p(3)))}
                />
              ) : (
                <span className="param compact muted">{BAND_TYPES[list[i]!.type]}</span>
              )}
              <ParamControl device={device} param={p(4)} compact />
            </div>
          );
        })}
        <div className="eq-band">
          <span className="param-name">Output</span>
          <ParamControl device={device} param={params[EQ_BANDS * 5]!} compact />
        </div>
      </div>
    </div>
  );
}
