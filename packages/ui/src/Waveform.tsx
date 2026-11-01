import type { Peaks } from "@tessera/schema";
import { useEffect, useRef } from "react";

/** Min/max overview of a source, drawn once per resize. */
export function Waveform({
  peaks,
  width = 220,
  height = 40,
}: {
  peaks: Peaks;
  width?: number;
  height?: number;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const el = canvas.current;
    const ctx = el?.getContext("2d");
    if (!el || !ctx) return;
    const dpr = globalThis.devicePixelRatio || 1;
    el.width = width * dpr;
    el.height = height * dpr;
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = "#0a84ff";
    const lanes = peaks.data.slice(0, 2);
    const laneHeight = height / Math.max(1, lanes.length);
    lanes.forEach((data, lane) => {
      const buckets = data.length / 2;
      const mid = laneHeight * lane + laneHeight / 2;
      for (let x = 0; x < width; x++) {
        const from = Math.floor((x / width) * buckets);
        const to = Math.max(from + 1, Math.floor(((x + 1) / width) * buckets));
        let min = 0;
        let max = 0;
        for (let b = from; b < to; b++) {
          min = Math.min(min, data[2 * b] ?? 0);
          max = Math.max(max, data[2 * b + 1] ?? 0);
        }
        const top = mid - (max * laneHeight) / 2;
        ctx.fillRect(x, top, 1, Math.max(1, ((max - min) * laneHeight) / 2));
      }
    });
  }, [peaks, width, height]);

  return <canvas ref={canvas} style={{ width, height }} aria-hidden />;
}
