import type { Peaks, Project, Track } from "@tessera/schema";
import { useEffect, useLayoutEffect, useMemo, useRef } from "react";
import { useElementSize } from "../hooks/useElementSize";
import { type MeterReading, SILENT } from "../Meter";
import { Ruler } from "./Ruler";
import { frameToX, gridLines, type Meter, type View, xToFrame, zoomAround } from "./timeScale";
import { TrackHeader } from "./TrackHeader";
import { TrackLane } from "./TrackLane";
import "./Arrange.css";

export const HEADER_WIDTH = 236;
export const RULER_HEIGHT = 30;
export const TRACK_HEIGHT = 84;

export interface ArrangeProps {
  project: Project;
  peaks: ReadonlyMap<number, Peaks>;
  view: View;
  onView: (view: View) => void;
  position: number;
  meters: ReadonlyMap<number, MeterReading>;
  selectedTrack: number | undefined;
  selectedClips: ReadonlySet<number>;
  onSeek: (frame: number) => void;
  onTrackChange: (id: number, patch: Partial<Track>) => void;
  onSelectTrack: (id: number) => void;
  onAddTrack: () => void;
}

/** The arrange view: ruler, track headers, clip lanes and playhead. */
export function Arrange(p: ArrangeProps) {
  const root = useRef<HTMLDivElement>(null);
  const { width } = useElementSize(root);
  const laneWidth = Math.max(0, width - HEADER_WIDTH);
  const meter: Meter = {
    sampleRate: p.project.sampleRate,
    tempo: p.project.tempo,
    timeSignature: p.project.timeSignature,
  };
  const grid = useMemo(
    () => gridLines(p.view, laneWidth, meter),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `meter` is derived from these.
    [p.view, laneWidth, p.project.sampleRate, p.project.tempo, p.project.timeSignature],
  );
  const loop = p.project.loop;
  const playheadX = frameToX(p.position, p.view);

  // Native, non-passive listener: React's wheel handlers are passive, so they can't stop
  // ctrl/⌘-wheel (and trackpad pinch) from zooming the whole page.
  const viewRef = useRef({ view: p.view, onView: p.onView });
  useLayoutEffect(() => {
    viewRef.current = { view: p.view, onView: p.onView };
  });
  useEffect(() => {
    const el = root.current;
    if (!el) return;
    const onWheel = (e: globalThis.WheelEvent) => {
      const { view, onView } = viewRef.current;
      const x = e.clientX - el.getBoundingClientRect().left - HEADER_WIDTH;
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        onView(zoomAround(view, Math.exp(e.deltaY * 0.01), Math.max(0, x)));
      } else if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
        e.preventDefault();
        const delta = e.shiftKey && e.deltaX === 0 ? e.deltaY : e.deltaX;
        onView({ ...view, scrollFrames: Math.max(0, view.scrollFrames + delta * view.framesPerPx) });
      }
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  return (
    <div className="arrange" ref={root}>
      <div className="arrange-top">
        <div className="corner" style={{ width: HEADER_WIDTH }}>
          <button className="add-track" onClick={p.onAddTrack} title="Add track">
            + Track
          </button>
        </div>
        <Ruler
          width={laneWidth}
          height={RULER_HEIGHT}
          view={p.view}
          grid={grid}
          loop={loop}
          onSeek={(x) => p.onSeek(xToFrame(x, p.view))}
        />
      </div>
      <div className="arrange-body">
        <div className="tracks-scroll">
          {p.project.tracks.map((track, i) => (
            <div className="track-row" key={track.id}>
              <TrackHeader
                track={track}
                height={TRACK_HEIGHT}
                meter={p.meters.get(track.id) ?? SILENT}
                selected={p.selectedTrack === track.id}
                onChange={(patch) => p.onTrackChange(track.id, patch)}
                onSelect={() => p.onSelectTrack(track.id)}
              />
              <TrackLane
                track={track}
                width={laneWidth}
                height={TRACK_HEIGHT}
                view={p.view}
                grid={grid}
                peaks={p.peaks}
                selected={p.selectedClips}
                loop={loop}
                alternate={i % 2 === 1}
              />
            </div>
          ))}
          {p.project.tracks.length === 0 && (
            <div className="empty-hint" style={{ marginLeft: HEADER_WIDTH }}>
              Drop audio files here or use <strong>Import</strong> to create tracks.
            </div>
          )}
        </div>
        {playheadX >= 0 && playheadX <= laneWidth && (
          <div className="playhead" style={{ transform: `translateX(${HEADER_WIDTH + playheadX}px)` }} />
        )}
      </div>
    </div>
  );
}
