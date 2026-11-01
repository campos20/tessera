import { type Device, DEVICES } from "@tessera/schema";
import { paramValue } from "../model/edits";

/** Band filter shapes, in the order of the EQ's "type" parameter. */
export const BAND_TYPES = ["highpass", "lowshelf", "bell", "highshelf", "lowpass", "notch"] as const;
export const EQ_BANDS = 8;

interface Coefs {
  b0: number;
  b1: number;
  b2: number;
  a1: number;
  a2: number;
}

/** RBJ cookbook design; must match `engine_core::devices::dsp::Coefs::design`. */
export function design(type: number, freq: number, q: number, gainDb: number, sampleRate: number): Coefs {
  const f = Math.min(Math.max(freq, 1), sampleRate * 0.49);
  const w0 = (2 * Math.PI * f) / sampleRate;
  const sin = Math.sin(w0);
  const cos = Math.cos(w0);
  const alpha = sin / (2 * Math.max(q, 0.05));
  const a = 10 ** (gainDb / 40);
  let c: [number, number, number, number, number, number];
  switch (BAND_TYPES[type] ?? "bell") {
    case "lowpass":
      c = [(1 - cos) / 2, 1 - cos, (1 - cos) / 2, 1 + alpha, -2 * cos, 1 - alpha];
      break;
    case "highpass":
      c = [(1 + cos) / 2, -(1 + cos), (1 + cos) / 2, 1 + alpha, -2 * cos, 1 - alpha];
      break;
    case "notch":
      c = [1, -2 * cos, 1, 1 + alpha, -2 * cos, 1 - alpha];
      break;
    case "lowshelf": {
      const s = 2 * Math.sqrt(a) * alpha;
      c = [
        a * (a + 1 - (a - 1) * cos + s),
        2 * a * (a - 1 - (a + 1) * cos),
        a * (a + 1 - (a - 1) * cos - s),
        a + 1 + (a - 1) * cos + s,
        -2 * (a - 1 + (a + 1) * cos),
        a + 1 + (a - 1) * cos - s,
      ];
      break;
    }
    case "highshelf": {
      const s = 2 * Math.sqrt(a) * alpha;
      c = [
        a * (a + 1 + (a - 1) * cos + s),
        -2 * a * (a - 1 + (a + 1) * cos),
        a * (a + 1 + (a - 1) * cos - s),
        a + 1 - (a - 1) * cos + s,
        2 * (a - 1 - (a + 1) * cos),
        a + 1 - (a - 1) * cos - s,
      ];
      break;
    }
    default:
      c = [1 + alpha * a, -2 * cos, 1 - alpha * a, 1 + alpha / a, -2 * cos, 1 - alpha / a];
  }
  const [b0, b1, b2, a0, a1, a2] = c;
  return { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: a1 / a0, a2: a2 / a0 };
}

export function magnitudeDb(c: Coefs, freq: number, sampleRate: number): number {
  const w = (2 * Math.PI * freq) / sampleRate;
  const re = (b: number, x: number, y: number) => b + x * Math.cos(w) + y * Math.cos(2 * w);
  const im = (x: number, y: number) => -(x * Math.sin(w) + y * Math.sin(2 * w));
  const nr = re(c.b0, c.b1, c.b2);
  const ni = im(c.b1, c.b2);
  const dr = re(1, c.a1, c.a2);
  const di = im(c.a1, c.a2);
  return 10 * Math.log10(Math.max(1e-30, (nr * nr + ni * ni) / (dr * dr + di * di)));
}

export interface Band {
  index: number;
  on: boolean;
  type: number;
  freq: number;
  gain: number;
  q: number;
}

export function bands(device: Device): Band[] {
  const v = (id: string) => paramValue(device, id);
  return Array.from({ length: EQ_BANDS }, (_, i) => {
    const n = i + 1;
    return {
      index: i,
      on: v(`b${n}On`) >= 0.5,
      type: v(`b${n}Type`),
      freq: v(`b${n}Freq`),
      gain: v(`b${n}Gain`),
      q: v(`b${n}Q`),
    };
  });
}

/** Whether a band type uses its gain (shelves and bells). */
export const hasGain = (type: number) => type === 1 || type === 2 || type === 3;

/** Combined response of the enabled bands plus output gain at `freq`, in dB. */
export function responseDb(device: Device, freq: number, sampleRate = 48_000): number {
  let db = paramValue(device, "output");
  for (const b of bands(device))
    if (b.on) db += magnitudeDb(design(b.type, b.freq, b.q, b.gain, sampleRate), freq, sampleRate);
  return db;
}

export const EQ_PARAMS = DEVICES.eq.params;
