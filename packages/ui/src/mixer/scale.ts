import type { ParamInfo } from "@tessera/schema";

/** Fader travel: position 0…1 ↔ gain. 0 is silence, ~0.6 is unity, 1 is +12 dB. */
const TOP_DB = 12;
const RANGE_DB = 72;

export function gainToFader(gain: number): number {
  if (gain <= 0) return 0;
  const db = 20 * Math.log10(gain);
  if (db <= TOP_DB - RANGE_DB) return 0;
  return 1 - Math.sqrt((TOP_DB - Math.min(TOP_DB, db)) / RANGE_DB);
}

export function faderToGain(position: number): number {
  if (position <= 0) return 0;
  const p = Math.min(1, position);
  return 10 ** ((TOP_DB - RANGE_DB * (1 - p) ** 2) / 20);
}

export function formatDb(gain: number): string {
  if (gain <= 0) return "−∞";
  const db = 20 * Math.log10(gain);
  return `${db > 0.05 ? "+" : db < -0.05 ? "−" : ""}${Math.abs(db).toFixed(1)}`;
}

export function formatPan(pan: number): string {
  if (Math.abs(pan) < 0.005) return "C";
  return `${Math.round(Math.abs(pan) * 100)}${pan < 0 ? "L" : "R"}`;
}

/** Parameter value ↔ control position 0…1 (log parameters map logarithmically). */
export function paramToUnit(info: ParamInfo, value: number): number {
  if (info.scale === "log") return Math.log(value / info.min) / Math.log(info.max / info.min);
  return (value - info.min) / (info.max - info.min);
}

export function unitToParam(info: ParamInfo, unit: number): number {
  const u = Math.min(1, Math.max(0, unit));
  if (info.scale === "log") return info.min * (info.max / info.min) ** u;
  const v = info.min + u * (info.max - info.min);
  return info.scale === "choice" || info.scale === "toggle" ? Math.round(v) : v;
}

export function formatParam(info: ParamInfo, value: number): string {
  if (info.scale === "choice") return info.options?.[Math.round(value)] ?? String(value);
  if (info.scale === "toggle") return value >= 0.5 ? "On" : "Off";
  const unit = info.unit;
  if (unit === "Hz")
    return value >= 1000
      ? `${(value / 1000).toFixed(value >= 10_000 ? 1 : 2)} kHz`
      : `${Math.round(value)} Hz`;
  if (unit === "" && info.max <= 1 && info.min >= 0) return `${Math.round(value * 100)}%`;
  if (unit === "" && info.min === -1 && info.max === 1) return formatPan(value);
  const digits = Math.abs(value) >= 100 ? 0 : Math.abs(value) >= 10 ? 1 : 2;
  return `${value.toFixed(digits)}${unit === ":1" ? ":1" : unit ? ` ${unit}` : ""}`;
}
