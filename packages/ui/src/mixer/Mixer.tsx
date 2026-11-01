import { DEVICES, type Device, type DeviceKind, type Project, type Track } from "@tessera/schema";
import { type PointerEvent as ReactPointerEvent, useState } from "react";
import { SILENT } from "../Meter";
import {
  addDevice,
  addSend,
  addTrack,
  removeSend,
  routableBuses,
  setOutput,
  updateTrack,
  wouldLoop,
} from "../model/edits";
import type { Recipe } from "../state/store";
import { useProject, useSession, useTransport } from "../state/hooks";
import { DeviceEditor } from "./DeviceEditor";
import { useGesture } from "./gesture";
import { faderToGain, formatDb, formatPan, gainToFader } from "./scale";
import "./Mixer.css";

const KINDS = Object.entries(DEVICES) as [DeviceKind, (typeof DEVICES)[DeviceKind]][];

/** Bottom pane with a channel strip per track, then the master. */
export function Mixer({ onClose }: { onClose: () => void }) {
  const session = useSession();
  const project = useProject((s) => s.project);
  const [height, setHeight] = useState(360);
  const [editing, setEditing] = useState<number | undefined>();
  const edit = (label: string, recipe: Recipe) => session.store.getState().edit(label, recipe);

  const onResize = (e: ReactPointerEvent<HTMLDivElement>) => {
    const startY = e.clientY;
    const start = height;
    const move = (ev: PointerEvent) =>
      setHeight(Math.round(Math.min(window.innerHeight * 0.8, Math.max(220, start + startY - ev.clientY))));
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  return (
    <section className="mixer-pane" style={{ height }} aria-label="Mixer" data-testid="mixer">
      <div className="pane-resizer" onPointerDown={onResize} />
      <header className="mixer-header">
        <strong>Mixer</strong>
        <button onClick={() => edit("Add bus", (p) => void addTrack(p, undefined, undefined, "bus"))}>
          + Bus
        </button>
        <span className="spacer" />
        <button className="pane-close" aria-label="Close mixer" onClick={onClose}>
          ✕
        </button>
      </header>
      <div className="mixer-strips">
        {project.tracks.map((track) => (
          <ChannelStrip key={track.id} track={track} project={project} onOpenDevice={setEditing} />
        ))}
        <span className="mixer-gap" />
        <MasterStrip project={project} onOpenDevice={setEditing} />
      </div>
      {editing !== undefined && <DeviceEditor deviceId={editing} onClose={() => setEditing(undefined)} />}
    </section>
  );
}

interface StripProps {
  track: Track;
  project: Project;
  onOpenDevice: (id: number) => void;
}

function ChannelStrip({ track, project, onOpenDevice }: StripProps) {
  const session = useSession();
  const meter = useTransport((s) => s.tracks.get(track.id)) ?? SILENT;
  const gesture = useGesture();
  const edit = (label: string, recipe: Recipe) => session.store.getState().edit(label, recipe);
  const fader = gesture(`${track.name}: volume`);
  const pan = gesture(`${track.name}: pan`);
  const buses = routableBuses(project, track.id);
  const sendTargets = buses.filter((b) => !track.sends.some((s) => s.target === b.id));
  const nameOf = (id: number) => project.tracks.find((t) => t.id === id)?.name ?? "?";

  return (
    <div
      className={`strip ${track.kind === "bus" ? "bus" : ""}`}
      style={{ ["--track-color" as string]: track.color }}
      data-testid={`strip-${track.id}`}
    >
      <div className="strip-name" title={track.name}>
        {track.kind === "bus" && <span className="tag">BUS</span>}
        {track.name}
      </div>
      <Inserts chain={track.inserts} trackId={track.id} label={track.name} onOpen={onOpenDevice} />
      <div className="strip-section sends">
        {track.sends.map((send) => {
          const g = gesture(`${track.name}: send level`);
          return (
            <div className="send" key={send.id}>
              <span className="send-name" title={`Send to ${nameOf(send.target)}`}>
                {nameOf(send.target)}
              </span>
              <input
                type="range"
                min={0}
                max={1000}
                aria-label={`Send to ${nameOf(send.target)}`}
                value={Math.round(gainToFader(send.gain) * 1000)}
                onPointerDown={g.onPointerDown}
                onPointerUp={g.onPointerUp}
                onChange={(e) => {
                  const gain = faderToGain(Number(e.target.value) / 1000);
                  g.apply((p) => {
                    const s = p.tracks.find((t) => t.id === track.id)?.sends.find((x) => x.id === send.id);
                    if (s) s.gain = gain;
                  });
                }}
                title={formatDb(send.gain)}
              />
              <button
                className={send.pre ? "mini on" : "mini"}
                title="Pre-fader"
                aria-pressed={send.pre}
                onClick={() =>
                  edit("Send pre/post", (p) => {
                    const s = p.tracks.find((t) => t.id === track.id)?.sends.find((x) => x.id === send.id);
                    if (s) s.pre = !s.pre;
                  })
                }
              >
                P
              </button>
              <button
                className="mini"
                aria-label={`Remove send to ${nameOf(send.target)}`}
                onClick={() => edit("Remove send", (p) => removeSend(p, track.id, send.id))}
              >
                ✕
              </button>
            </div>
          );
        })}
        {sendTargets.length > 0 && track.sends.length < 8 && (
          <select
            className="add"
            aria-label={`Add send on ${track.name}`}
            value=""
            onChange={(e) => {
              const target = Number(e.target.value);
              edit("Add send", (p) => void addSend(p, track.id, target));
            }}
          >
            <option value="">+ Send</option>
            {sendTargets.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </select>
        )}
      </div>
      <select
        className="strip-output"
        aria-label={`${track.name} output`}
        value={track.output ?? ""}
        onChange={(e) => {
          const value = e.target.value === "" ? null : Number(e.target.value);
          edit("Change output", (p) => setOutput(p, track.id, value));
        }}
      >
        <option value="">Master</option>
        {project.tracks
          .filter((t) => t.kind === "bus" && t.id !== track.id)
          .map((b) => (
            <option key={b.id} value={b.id} disabled={wouldLoop(project, track.id, b.id)}>
              {b.name}
            </option>
          ))}
      </select>
      <label className="strip-pan" title={formatPan(track.pan)}>
        <input
          type="range"
          min={-100}
          max={100}
          aria-label={`${track.name} pan`}
          value={Math.round(track.pan * 100)}
          onPointerDown={pan.onPointerDown}
          onPointerUp={pan.onPointerUp}
          onDoubleClick={() => edit("Center pan", (p) => updateTrack(p, track.id, { pan: 0 }))}
          onChange={(e) => {
            const value = Number(e.target.value) / 100;
            pan.apply((p) => updateTrack(p, track.id, { pan: value }));
          }}
        />
        <span>{formatPan(track.pan)}</span>
      </label>
      <div className="strip-fader">
        <input
          type="range"
          className="fader"
          min={0}
          max={1000}
          aria-label={`${track.name} volume`}
          value={Math.round(gainToFader(track.gain) * 1000)}
          onPointerDown={fader.onPointerDown}
          onPointerUp={fader.onPointerUp}
          onDoubleClick={() => edit("Reset volume", (p) => updateTrack(p, track.id, { gain: 1 }))}
          onChange={(e) => {
            const gain = faderToGain(Number(e.target.value) / 1000);
            fader.apply((p) => updateTrack(p, track.id, { gain }));
          }}
        />
        <VerticalMeter peakL={meter.peakL} peakR={meter.peakR} />
      </div>
      <div className="strip-db">{formatDb(track.gain)}</div>
      <div className="strip-buttons">
        <button
          className={track.mute ? "on mute" : ""}
          aria-pressed={track.mute}
          aria-label={`Mute ${track.name}`}
          onClick={() => edit("Mute", (p) => updateTrack(p, track.id, { mute: !track.mute }))}
        >
          M
        </button>
        <button
          className={track.solo ? "on solo" : ""}
          aria-pressed={track.solo}
          aria-label={`Solo ${track.name}`}
          onClick={() => edit("Solo", (p) => updateTrack(p, track.id, { solo: !track.solo }))}
        >
          S
        </button>
      </div>
    </div>
  );
}

function MasterStrip({ project, onOpenDevice }: { project: Project; onOpenDevice: (id: number) => void }) {
  const session = useSession();
  const meter = useTransport((s) => s.master);
  const gesture = useGesture();
  const fader = gesture("Master volume");
  return (
    <div className="strip master" data-testid="strip-master">
      <div className="strip-name">Master</div>
      <Inserts chain={project.masterInserts} trackId={null} label="Master" onOpen={onOpenDevice} />
      <span className="strip-flex" />
      <div className="strip-fader">
        <input
          type="range"
          className="fader"
          min={0}
          max={1000}
          aria-label="Master volume"
          value={Math.round(gainToFader(project.masterGain) * 1000)}
          onPointerDown={fader.onPointerDown}
          onPointerUp={fader.onPointerUp}
          onDoubleClick={() => session.store.getState().edit("Reset master", (p) => void (p.masterGain = 1))}
          onChange={(e) => {
            const gain = faderToGain(Number(e.target.value) / 1000);
            fader.apply((p) => void (p.masterGain = gain));
          }}
        />
        <VerticalMeter peakL={meter.peakL} peakR={meter.peakR} />
      </div>
      <div className="strip-db">{formatDb(project.masterGain)}</div>
      <div className="strip-buttons" />
    </div>
  );
}

function Inserts({
  chain,
  trackId,
  label,
  onOpen,
}: {
  chain: Device[];
  trackId: number | null;
  label: string;
  onOpen: (id: number) => void;
}) {
  const session = useSession();
  const reduction = useTransport((s) => s.reduction);
  const edit = (name: string, recipe: Recipe) => session.store.getState().edit(name, recipe);
  return (
    <div className="strip-section inserts">
      {chain.map((device) => {
        const info = DEVICES[device.kind as DeviceKind] as (typeof DEVICES)[DeviceKind] | undefined;
        const gr = reduction.get(device.id) ?? 0;
        return (
          <div className={device.bypass || !info ? "insert off" : "insert"} key={device.id}>
            <button
              className="power"
              aria-label={`${device.bypass ? "Enable" : "Bypass"} ${info?.name ?? device.kind}`}
              aria-pressed={!device.bypass}
              onClick={() =>
                edit(device.bypass ? "Enable device" : "Bypass device", (p) => {
                  const d = [...p.masterInserts, ...p.tracks.flatMap((t) => t.inserts)].find(
                    (x) => x.id === device.id,
                  );
                  if (d) d.bypass = !d.bypass;
                })
              }
            />
            <button
              className="insert-name"
              onClick={() => onOpen(device.id)}
              title={info ? undefined : "Unknown device"}
            >
              {info?.name ?? `${device.kind}?`}
            </button>
            {gr > 0.1 && <span className="gr" style={{ width: `${Math.min(100, gr * 5)}%` }} />}
          </div>
        );
      })}
      {chain.length < 16 && (
        <select
          className="add"
          aria-label={`Add effect on ${label}`}
          value=""
          onChange={(e) => {
            const kind = e.target.value as DeviceKind;
            let id: number | undefined;
            edit(`Add ${DEVICES[kind].name}`, (p) => void (id = addDevice(p, trackId, kind)));
            if (id !== undefined) onOpen(id);
          }}
        >
          <option value="">+ Effect</option>
          {KINDS.map(([kind, info]) => (
            <option key={kind} value={kind}>
              {info.name}
            </option>
          ))}
        </select>
      )}
    </div>
  );
}

function VerticalMeter({ peakL, peakR }: { peakL: number; peakR: number }) {
  const h = (a: number) => (a <= 0 ? 0 : Math.max(0, Math.min(100, ((20 * Math.log10(a) + 60) / 66) * 100)));
  return (
    <div
      className="vmeter"
      role="meter"
      aria-valuenow={Math.max(peakL, peakR)}
      aria-valuemin={0}
      aria-valuemax={1}
    >
      {[peakL, peakR].map((v, i) => (
        <div key={i} className={v >= 1 ? "bar clip" : "bar"} style={{ height: `${h(v)}%` }} />
      ))}
    </div>
  );
}
