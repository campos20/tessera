import type { AudioSettings as Settings, Diagnostics } from "@tessera/platform";
import type { AudioDeviceList } from "@tessera/schema";
import { type ReactNode, useEffect, useState } from "react";
import { useRecording, useSession, useSessionUi } from "../state/hooks";

const SAMPLE_RATES = [44_100, 48_000, 88_200, 96_000];
const BUFFER_SIZES = [32, 64, 128, 256, 512, 1024];

/** Device selection, latency compensation and calibration. */
export function AudioSettings({ onClose }: { onClose: () => void }) {
  const session = useSession();
  const support = session.platform.capabilities.settings;
  const saved = useRecording((s) => s.settings);
  const engine = useRecording((s) => s.engine);
  const latency = useRecording((s) => s.latency);
  const xruns = useRecording((s) => s.xruns);
  const busy = useSessionUi((s) => s.busy);
  const [draft, setDraft] = useState<Settings>(saved);
  const [devices, setDevices] = useState<AudioDeviceList>();
  const [diagnostics, setDiagnostics] = useState<Diagnostics>({});
  const [calibrationInput, setCalibrationInput] = useState(0);
  const [message, setMessage] = useState<string>();

  const refresh = () => {
    session.platform.listDevices().then(setDevices, () => {});
    session.platform.diagnostics().then(setDiagnostics, () => {});
  };
  useEffect(refresh, [session]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const hosts = devices?.hosts ?? [];
  const host = hosts.find((h) => h.name === draft.host) ?? hosts.find((h) => h.isDefault) ?? hosts[0];
  const outputs = host?.devices.filter((d) => d.maxOutputChannels > 0) ?? [];
  const inputs = host?.devices.filter((d) => d.maxInputChannels > 0) ?? [];
  const rate = engine?.sampleRate ?? 48_000;
  const ms = (frames: number) => ((frames / rate) * 1000).toFixed(1);
  const set = (patch: Partial<Settings>) => setDraft((d) => ({ ...d, ...patch }));

  const apply = async () => {
    setMessage(undefined);
    try {
      await session.applyAudioSettings(draft);
      setMessage("Applied.");
      refresh();
    } catch (e) {
      setMessage(e instanceof Error ? e.message : String(e));
    }
  };

  const calibrate = async () => {
    setMessage(undefined);
    const frames = await session.calibrate(calibrationInput);
    setMessage(
      frames === undefined ? undefined : `Measured round-trip latency: ${ms(frames)} ms (${frames} frames).`,
    );
  };

  return (
    <div className="dialog-backdrop" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dialog" role="dialog" aria-label="Audio settings">
        <header>
          <h2>Audio settings</h2>
          <button className="close" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </header>

        <section>
          <h3>Devices</h3>
          {support.host && (
            <Field label="Driver">
              <select
                value={draft.host ?? ""}
                onChange={(e) =>
                  set({ host: e.target.value || undefined, outputDevice: undefined, inputDevice: undefined })
                }
              >
                <option value="">Default</option>
                {hosts.map((h) => (
                  <option key={h.name} value={h.name}>
                    {h.name}
                  </option>
                ))}
              </select>
            </Field>
          )}
          {support.outputDevice && (
            <Field label="Output">
              <select
                value={draft.outputDevice ?? ""}
                onChange={(e) => set({ outputDevice: e.target.value || undefined })}
              >
                <option value="">Default</option>
                {outputs.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.name}
                  </option>
                ))}
              </select>
            </Field>
          )}
          {support.inputDevice && (
            <Field label="Input">
              <select
                value={draft.inputDevice ?? ""}
                onChange={(e) => set({ inputDevice: e.target.value || undefined })}
                aria-label="Input device"
              >
                <option value="">None</option>
                <option value="default">Default</option>
                {inputs.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.name}
                    {d.maxInputChannels > 2 ? ` (${d.maxInputChannels} ch)` : ""}
                  </option>
                ))}
              </select>
            </Field>
          )}
          {support.sampleRate && (
            <Field label="Sample rate">
              <select
                value={draft.sampleRate ?? ""}
                onChange={(e) => set({ sampleRate: Number(e.target.value) || undefined })}
              >
                <option value="">Device default</option>
                {SAMPLE_RATES.map((r) => (
                  <option key={r} value={r}>
                    {(r / 1000).toFixed(1)} kHz
                  </option>
                ))}
              </select>
            </Field>
          )}
          {support.bufferSize && (
            <Field label="Buffer size">
              <select
                value={draft.bufferSize ?? ""}
                onChange={(e) => set({ bufferSize: Number(e.target.value) || undefined })}
              >
                <option value="">Device default</option>
                {BUFFER_SIZES.map((b) => (
                  <option key={b} value={b}>
                    {b} samples ({((b / rate) * 1000).toFixed(1)} ms)
                  </option>
                ))}
              </select>
            </Field>
          )}
          {!support.host && (
            <p className="note">
              Browsers expose at most two input channels of an interface and add their own latency. For
              multichannel recording or low-latency drivers (ASIO), use the desktop app.
            </p>
          )}
          <div className="actions">
            <button className="primary" onClick={() => void apply()} disabled={!!busy}>
              Apply
            </button>
          </div>
        </section>

        <section>
          <h3>Latency compensation</h3>
          <p data-testid="latency">
            {ms(latency.frames)} ms ({latency.frames} frames) —{" "}
            {latency.calibrated ? "calibrated" : "estimated; calibrate for accurate placement"}
          </p>
          <p className="note">
            Calibration plays the metronome and records it back. Connect a cable from an output to an input of
            your interface, turn speakers down, then start.
          </p>
          <div className="actions">
            <label>
              Loopback input
              <select value={calibrationInput} onChange={(e) => setCalibrationInput(Number(e.target.value))}>
                {Array.from({ length: Math.max(1, engine?.inputChannels ?? 1) }, (_, c) => (
                  <option key={c} value={c}>
                    In {c + 1}
                  </option>
                ))}
              </select>
            </label>
            <button onClick={() => void calibrate()} disabled={!!busy}>
              {busy?.startsWith("Calibrating") ? "Calibrating…" : "Calibrate"}
            </button>
          </div>
        </section>

        <section>
          <h3>Status</h3>
          <dl>
            {Object.entries(diagnostics).map(([k, v]) => (
              <div key={k}>
                <dt>{k}</dt>
                <dd>{String(v)}</dd>
              </div>
            ))}
            {engine && (
              <div>
                <dt>inputChannels</dt>
                <dd>{engine.inputChannels}</dd>
              </div>
            )}
            {support.bufferSize && (
              <div>
                <dt>dropouts</dt>
                <dd data-testid="xruns">{xruns}</dd>
              </div>
            )}
          </dl>
        </section>
        {message && <p className="message">{message}</p>}
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="field-row">
      <span>{label}</span>
      {children}
    </label>
  );
}
