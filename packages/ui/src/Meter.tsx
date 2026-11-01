export interface MeterReading {
  peakL: number;
  peakR: number;
}

export const SILENT: MeterReading = { peakL: 0, peakR: 0 };

/** Stereo peak meter on a dB scale (−60…0 dBFS). `testId` exposes the max peak to tests. */
export function Meter({ reading, testId }: { reading: MeterReading; testId?: string }) {
  const peak = Math.max(reading.peakL, reading.peakR);
  return (
    <div
      className="meter"
      role="meter"
      aria-valuemin={0}
      aria-valuemax={1}
      aria-valuenow={peak}
      data-testid={testId}
    >
      {[reading.peakL, reading.peakR].map((value, i) => (
        <div key={i} className={value >= 1 ? "bar clip" : "bar"} style={{ width: `${toPercent(value)}%` }} />
      ))}
    </div>
  );
}

function toPercent(amplitude: number): number {
  if (amplitude <= 0) return 0;
  const db = 20 * Math.log10(amplitude);
  return Math.max(0, Math.min(100, ((db + 60) / 60) * 100));
}
