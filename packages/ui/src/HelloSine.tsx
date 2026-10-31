import type { AudioPlatform, Diagnostics } from "@tessera/platform";
import type { AudioDeviceList } from "@tessera/schema";
import { useCallback, useEffect, useState } from "react";
import "./HelloSine.css";

type Status = "idle" | "starting" | "playing" | "stopped" | "error";

/** M0 smoke screen: plays the engine-core sine through whichever platform it is given. */
export function HelloSine({ platform }: { platform: AudioPlatform }) {
  const [status, setStatus] = useState<Status>("idle");
  const [error, setError] = useState<string>();
  const [frequency, setFrequency] = useState(440);
  const [peak, setPeak] = useState(0);
  const [diagnostics, setDiagnostics] = useState<Diagnostics>({});
  const [devices, setDevices] = useState<AudioDeviceList>();

  const refreshDiagnostics = useCallback(() => {
    platform.diagnostics().then(setDiagnostics, (e: unknown) => setError(String(e)));
  }, [platform]);

  useEffect(refreshDiagnostics, [refreshDiagnostics]);

  useEffect(
    () =>
      platform.onEvent((event) => {
        if (event.type === "Peak") setPeak(event.value);
      }),
    [platform],
  );

  const play = async () => {
    setStatus("starting");
    setError(undefined);
    try {
      await platform.start();
      platform.send({ type: "SetFrequency", hz: frequency });
      platform.send({ type: "Play" });
      setStatus("playing");
      refreshDiagnostics();
    } catch (e) {
      setStatus("error");
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const stop = () => {
    platform.send({ type: "Stop" });
    setStatus("stopped");
  };

  const changeFrequency = (hz: number) => {
    setFrequency(hz);
    if (status === "playing") platform.send({ type: "SetFrequency", hz });
  };

  const listDevices = () => {
    platform.listDevices().then(setDevices, (e: unknown) => setError(String(e)));
  };

  return (
    <main className="hello-sine">
      <h1>Tessera</h1>
      <p className="edition">{platform.edition === "web" ? "Web" : "Desktop"} edition · hello sine</p>

      <div className="controls">
        <button onClick={play} disabled={status === "starting" || status === "playing"}>
          Play
        </button>
        <button onClick={stop} disabled={status !== "playing"}>
          Stop
        </button>
        <label>
          <input
            type="range"
            min={110}
            max={1760}
            step={1}
            value={frequency}
            onChange={(e) => changeFrequency(Number(e.target.value))}
            aria-label="Frequency"
          />
          <span>{frequency} Hz</span>
        </label>
      </div>

      <div
        className="meter"
        role="meter"
        aria-label="Output peak"
        aria-valuemin={0}
        aria-valuemax={1}
        aria-valuenow={peak}
        data-testid="peak"
      >
        <div style={{ width: `${Math.min(1, peak) * 100}%` }} />
      </div>

      <p data-testid="status">
        Status: {status}
        {error && <span className="error"> · {error}</span>}
      </p>

      <h2>Diagnostics</h2>
      <dl>
        {Object.entries(diagnostics).map(([key, value]) => (
          <div key={key} style={{ display: "contents" }}>
            <dt>{key}</dt>
            <dd data-testid={`diag-${key}`}>{String(value)}</dd>
          </div>
        ))}
      </dl>

      <h2>Audio devices</h2>
      <button onClick={listDevices}>List devices</button>
      {devices?.hosts.map((host) => (
        <div key={host.name}>
          <h3>
            {host.name}
            {host.isDefault && " (default)"}
          </h3>
          {host.error && <p className="error">{host.error}</p>}
          <ul>
            {host.devices.map((d) => (
              <li key={d.id}>
                {d.name} — in {d.maxInputChannels}, out {d.maxOutputChannels}
                {d.isDefaultOutput && " · default output"}
                {d.isDefaultInput && " · default input"}
              </li>
            ))}
          </ul>
        </div>
      ))}
    </main>
  );
}
