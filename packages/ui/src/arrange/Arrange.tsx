import type { Clip, Project } from "@tessera/schema";
import {
  type DragEvent,
  type PointerEvent,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useElementSize } from "../hooks/useElementSize";
import { usePlayhead } from "../hooks/usePlayhead";
import { SILENT } from "../Meter";
import {
  addTrack,
  moveClips,
  removeTrack,
  moveTrack,
  setClipGain,
  setFade,
  trimClipEnd,
  trimClipStart,
  updateTrack,
} from "../model/edits";
import { useProject, useRecording, useSession, useTransport } from "../state/hooks";
import { CURSORS, type ClipPart, hitTestClip } from "./hitTest";
import { Ruler } from "./Ruler";
import {
  frameToX,
  gridLines,
  gridStep,
  type Meter,
  snapToGrid,
  type View,
  xToFrame,
  zoomAround,
} from "./timeScale";
import { type ChangePhase, TrackHeader, type TrackPatch } from "./TrackHeader";
import { TrackLane } from "./TrackLane";
import "./Arrange.css";

export const HEADER_WIDTH = 236;
export const RULER_HEIGHT = 30;
export const TRACK_HEIGHT = 84;

const DRAG_THRESHOLD_PX = 3;
/** Alt-drag on a clip changes its gain by 1 dB per 3 px. */
const GAIN_PX_PER_DB = 3;

export interface ArrangeProps {
  view: View;
  onView: (view: View) => void;
  snap: boolean;
}

interface ClipDrag {
  kind: ClipPart | "gain";
  clip: Clip;
  ids: number[];
  startX: number;
  startY: number;
  startFrame: number;
  moved: boolean;
}

/** The arrange view: ruler, track headers, clip lanes, playhead, and all clip editing gestures. */
export function Arrange({ view, onView, snap }: ArrangeProps) {
  const session = useSession();
  const store = session.store;
  const project = useProject((s) => s.project);
  const peaks = useProject((s) => s.peaks);
  const selection = useProject((s) => s.selection);
  const meters = useTransport((s) => s.tracks);
  const inputMeters = useTransport((s) => s.inputs);
  const armed = useRecording((s) => s.armed);
  const monitored = useRecording((s) => s.monitored);
  const live = useRecording((s) => s.live);
  const inputChannels = useRecording((s) => s.engine?.inputChannels ?? 0);

  const root = useRef<HTMLDivElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const playhead = useRef<HTMLDivElement>(null);
  const drag = useRef<ClipDrag | null>(null);
  const [dropTarget, setDropTarget] = useState(false);
  const { width } = useElementSize(root);
  const laneWidth = Math.max(0, width - HEADER_WIDTH);

  const meter: Meter = useMemo(
    () => ({ sampleRate: project.sampleRate, tempo: project.tempo, timeSignature: project.timeSignature }),
    [project.sampleRate, project.tempo, project.timeSignature],
  );
  const grid = useMemo(() => gridLines(view, laneWidth, meter), [view, laneWidth, meter]);
  const snapFrame = (frame: number, bypass: boolean) =>
    snap && !bypass ? snapToGrid(frame, gridStep(view, meter)) : frame;

  // Latest view for the native wheel handler and the playhead follower.
  const latest = useRef({ view, onView, laneWidth });
  useLayoutEffect(() => {
    latest.current = { view, onView, laneWidth };
  });

  // Native, non-passive wheel listener: React's are passive, so they can't stop ctrl/⌘-wheel
  // (and trackpad pinch) from zooming the whole page.
  useEffect(() => {
    const el = root.current;
    if (!el) return;
    const onWheel = (e: globalThis.WheelEvent) => {
      const { view: v, onView: set } = latest.current;
      const x = e.clientX - el.getBoundingClientRect().left - HEADER_WIDTH;
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        set(zoomAround(v, Math.exp(e.deltaY * 0.01), Math.max(0, x)));
      } else if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
        e.preventDefault();
        const delta = e.shiftKey && e.deltaX === 0 ? e.deltaY : e.deltaX;
        set({ ...v, scrollFrames: Math.max(0, v.scrollFrames + delta * v.framesPerPx) });
      }
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  // Playhead: moved directly on every animation frame; pages the view while playing.
  usePlayhead((frame) => {
    const { view: v, onView: set, laneWidth: w } = latest.current;
    const el = playhead.current;
    if (!el) return;
    const x = frameToX(frame, v);
    el.style.display = x >= 0 && x <= w ? "block" : "none";
    el.style.transform = `translateX(${HEADER_WIDTH + x}px)`;
    if (session.transport.getState().playing && !drag.current && w > 0 && (x > w * 0.95 || x < 0)) {
      set({ ...v, scrollFrames: Math.max(0, frame - w * 0.05 * v.framesPerPx) });
    }
  });

  // Track header edits; sliders become one undo step per drag.
  const changeTrack = (id: number, patch: TrackPatch, phase: ChangePhase, label: string) => {
    const s = store.getState();
    if (phase === "start") s.beginGesture(label);
    else if (phase === "end") s.commitGesture();
    else if (phase === "change" && s.gesture) s.updateGesture((p) => updateTrack(p, id, patch));
    else s.edit(label, (p) => updateTrack(p, id, patch));
  };

  const reorderTrack = (id: number, startIndex: number, rows: number, phase: "start" | "move" | "end") => {
    const s = store.getState();
    if (phase === "start") s.beginGesture("Reorder tracks");
    else if (phase === "move") s.updateGesture((p) => moveTrack(p, id, startIndex + rows));
    else s.commitGesture();
  };

  // Clip gestures ----------------------------------------------------------------------------

  const onLanePointerDown = (e: PointerEvent<HTMLCanvasElement>, trackId: number) => {
    if (e.button !== 0) return;
    const track = project.tracks.find((t) => t.id === trackId);
    if (!track) return;
    const x = e.nativeEvent.offsetX;
    const hit = hitTestClip(track, view, x, e.nativeEvent.offsetY);
    const s = store.getState();
    if (!hit) {
      s.select({ clips: new Set(), track: trackId });
      session.seek(xToFrame(x, view));
      return;
    }
    let clips = new Set(selection.clips);
    if (e.shiftKey) {
      if (clips.has(hit.clip.id)) clips.delete(hit.clip.id);
      else clips.add(hit.clip.id);
      s.select({ clips, track: trackId });
      return;
    }
    if (!clips.has(hit.clip.id)) clips = new Set([hit.clip.id]);
    s.select({ clips, track: trackId });

    const kind = e.altKey && hit.part === "body" ? "gain" : hit.part;
    e.currentTarget.setPointerCapture(e.pointerId);
    s.beginGesture(GESTURE_LABELS[kind]);
    drag.current = {
      kind,
      clip: hit.clip,
      ids: kind === "body" || kind === "gain" ? [...clips] : [hit.clip.id],
      startX: e.clientX,
      startY: e.clientY,
      startFrame: xToFrame(x, view),
      moved: false,
    };
  };

  const onLanePointerMove = (e: PointerEvent<HTMLCanvasElement>, trackId: number) => {
    const d = drag.current;
    if (!d) {
      const track = project.tracks.find((t) => t.id === trackId);
      const hit = track && hitTestClip(track, view, e.nativeEvent.offsetX, e.nativeEvent.offsetY);
      e.currentTarget.style.cursor = hit
        ? e.altKey && hit.part === "body"
          ? "ns-resize"
          : CURSORS[hit.part]
        : "text";
      return;
    }
    const dx = e.clientX - d.startX;
    const dy = e.clientY - d.startY;
    if (!d.moved && Math.abs(dx) < DRAG_THRESHOLD_PX && Math.abs(dy) < DRAG_THRESHOLD_PX) return;
    d.moved = true;
    const bypassSnap = e.metaKey || e.ctrlKey;
    const frame = Math.max(0, d.startFrame + dx * view.framesPerPx);
    const { clip, ids } = d;
    const s = store.getState();
    switch (d.kind) {
      case "body": {
        const start = snapFrame(clip.start + dx * view.framesPerPx, bypassSnap);
        s.updateGesture((p) => moveClips(p, ids, start - clip.start, Math.round(dy / TRACK_HEIGHT)));
        break;
      }
      case "trim-start":
        s.updateGesture((p) => trimClipStart(p, clip.id, snapFrame(frame, bypassSnap)));
        break;
      case "trim-end":
        s.updateGesture((p) => trimClipEnd(p, clip.id, snapFrame(frame, bypassSnap)));
        break;
      case "fade-in":
        s.updateGesture((p) => setFade(p, clip.id, "in", frame - clip.start));
        break;
      case "fade-out":
        s.updateGesture((p) => setFade(p, clip.id, "out", clip.start + clip.length - frame));
        break;
      case "gain": {
        const gain = clip.gain * 10 ** (-dy / GAIN_PX_PER_DB / 20);
        s.updateGesture((p) => setClipGain(p, ids, gain));
        break;
      }
    }
  };

  const onLanePointerUp = () => {
    const d = drag.current;
    drag.current = null;
    if (!d) return;
    if (d.moved) store.getState().commitGesture();
    else store.getState().cancelGesture();
  };

  // Escape cancels a drag in progress.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && drag.current) {
        drag.current = null;
        store.getState().cancelGesture();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [store]);

  // Drag and drop import -------------------------------------------------------------------

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDropTarget(false);
    const files = [...e.dataTransfer.files];
    if (files.length === 0 || !scroller.current) return;
    const rect = scroller.current.getBoundingClientRect();
    const row = Math.floor((e.clientY - rect.top + scroller.current.scrollTop) / TRACK_HEIGHT);
    const x = e.clientX - rect.left - HEADER_WIDTH;
    const start = x > 0 ? snapFrame(xToFrame(x, view), false) : 0;
    void session.importFiles(files, { trackId: project.tracks[row]?.id, start });
  };

  return (
    <div className="arrange" ref={root}>
      <div className="arrange-top">
        <div className="corner" style={{ width: HEADER_WIDTH }}>
          <button
            className="add-track"
            onClick={() => store.getState().edit("Add track", (p) => void addTrackAfter(p, selection.track))}
            title="Add track"
          >
            + Track
          </button>
          <label className="add-track import" title="Import audio files">
            Import…
            <input
              type="file"
              accept="audio/*,.wav,.flac,.mp3,.ogg,.m4a,.aac"
              multiple
              data-testid="import"
              onChange={(e) => {
                // Copy first: the FileList is live and clearing the input empties it.
                const files = Array.from(e.target.files ?? []);
                e.target.value = "";
                if (files.length) void session.importFiles(files, { start: 0 });
              }}
            />
          </label>
        </div>
        <Ruler
          width={laneWidth}
          height={RULER_HEIGHT}
          view={view}
          grid={grid}
          loop={project.loop}
          onSeek={(x) => session.seek(xToFrame(x, view))}
        />
      </div>
      <div className="arrange-body">
        <div
          className={dropTarget ? "tracks-scroll drop-target" : "tracks-scroll"}
          ref={scroller}
          onDragOver={(e) => {
            if (!e.dataTransfer.types.includes("Files")) return;
            e.preventDefault();
            setDropTarget(true);
          }}
          onDragLeave={() => setDropTarget(false)}
          onDrop={onDrop}
          onPointerDown={(e) => {
            if (e.target === e.currentTarget) store.getState().select({ clips: new Set(), track: undefined });
          }}
        >
          {project.tracks.map((track, i) => (
            <div className="track-row" key={track.id}>
              <TrackHeader
                track={track}
                height={TRACK_HEIGHT}
                meter={meters.get(track.id) ?? SILENT}
                selected={selection.track === track.id}
                onChange={(patch, phase, label) => changeTrack(track.id, patch, phase, label)}
                onSelect={() => store.getState().select({ track: track.id })}
                onReorder={(rows, phase) => reorderTrack(track.id, i, rows, phase)}
                armed={armed.has(track.id)}
                monitored={monitored.has(track.id)}
                inputMeter={inputMeters.get(track.id) ?? SILENT}
                inputChannels={inputChannels}
                onArm={() => void session.toggleArm(track.id)}
                onMonitor={() => void session.toggleMonitor(track.id)}
                onInput={(channel, stereo) => session.setTrackInput(track.id, channel, stereo)}
                onDelete={() => store.getState().edit("Delete track", (p) => removeTrack(p, track.id))}
              />
              <TrackLane
                track={track}
                width={laneWidth}
                height={TRACK_HEIGHT}
                view={view}
                grid={grid}
                peaks={peaks}
                selected={selection.clips}
                loop={project.loop}
                alternate={i % 2 === 1}
                live={live.get(track.id)}
                onPointerDown={(e) => onLanePointerDown(e, track.id)}
                onPointerMove={(e) => onLanePointerMove(e, track.id)}
                onPointerUp={onLanePointerUp}
                onDoubleClick={(e) => {
                  const hit = hitTestClip(track, view, e.nativeEvent.offsetX, e.nativeEvent.offsetY);
                  if (hit?.part === "body") void session.openTune(hit.clip.id);
                }}
              />
            </div>
          ))}
          {project.tracks.length === 0 && (
            <div className="empty-hint">
              <strong>Drop audio files here</strong> or use <em>Import…</em> to create tracks.
              <span>WAV, FLAC, MP3, OGG and M4A are supported.</span>
            </div>
          )}
        </div>
        <div className="playhead" ref={playhead} />
      </div>
    </div>
  );
}

const GESTURE_LABELS: Record<ClipPart | "gain", string> = {
  body: "Move clips",
  "trim-start": "Trim clip start",
  "trim-end": "Trim clip end",
  "fade-in": "Change fade-in",
  "fade-out": "Change fade-out",
  gain: "Change clip gain",
};

/** Adds a track below the selected one (or at the end). */
function addTrackAfter(p: Project, selectedTrack: number | undefined) {
  const index = p.tracks.findIndex((t) => t.id === selectedTrack);
  return addTrack(p, undefined, index >= 0 ? index + 1 : p.tracks.length);
}
