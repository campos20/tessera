import type { Track } from "@tessera/schema";
import { Meter, type MeterReading } from "../Meter";

export interface TrackHeaderProps {
  track: Track;
  height: number;
  meter: MeterReading;
  selected: boolean;
  onChange: (patch: Partial<Pick<Track, "gain" | "pan" | "mute" | "solo" | "name">>) => void;
  onSelect: () => void;
}

const MIN_DB = -60;
const gainToDb = (gain: number) => (gain <= 0 ? MIN_DB : Math.max(MIN_DB, 20 * Math.log10(gain)));
const dbToGain = (db: number) => (db <= MIN_DB ? 0 : 10 ** (db / 20));

export function TrackHeader({ track, height, meter, selected, onChange, onSelect }: TrackHeaderProps) {
  const db = gainToDb(track.gain);
  return (
    <div
      className={selected ? "track-header selected" : "track-header"}
      style={{ height, ["--track-color" as string]: track.color }}
      onPointerDown={onSelect}
      data-testid={`track-header-${track.id}`}
    >
      <div className="color-strip" />
      <div className="header-body">
        <div className="header-row">
          <span className="track-name" title={track.name}>
            {track.name}
          </span>
          <button
            className={track.mute ? "ms mute on" : "ms mute"}
            aria-pressed={track.mute}
            aria-label="Mute"
            onClick={() => onChange({ mute: !track.mute })}
          >
            M
          </button>
          <button
            className={track.solo ? "ms solo on" : "ms solo"}
            aria-pressed={track.solo}
            aria-label="Solo"
            onClick={() => onChange({ solo: !track.solo })}
          >
            S
          </button>
        </div>
        <div className="header-row controls">
          <input
            className="volume"
            type="range"
            min={MIN_DB}
            max={6}
            step={0.5}
            value={db}
            onChange={(e) => onChange({ gain: dbToGain(Number(e.target.value)) })}
            aria-label="Volume"
            title={db <= MIN_DB ? "−∞ dB" : `${db.toFixed(1)} dB`}
          />
          <input
            className="pan"
            type="range"
            min={-1}
            max={1}
            step={0.05}
            value={track.pan}
            onChange={(e) => onChange({ pan: Number(e.target.value) })}
            onDoubleClick={() => onChange({ pan: 0 })}
            aria-label="Pan"
            title={
              track.pan === 0
                ? "C"
                : track.pan < 0
                  ? `L${Math.round(-track.pan * 100)}`
                  : `R${Math.round(track.pan * 100)}`
            }
          />
        </div>
        <Meter reading={meter} testId={`track-meter-${track.id}`} />
      </div>
    </div>
  );
}
