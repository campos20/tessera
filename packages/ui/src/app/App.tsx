import type { AudioPlatform } from "@tessera/platform";
import { useEffect, useState } from "react";
import { Arrange, HEADER_WIDTH } from "../arrange/Arrange";
import { type View, zoomAround } from "../arrange/timeScale";
import { deleteClips, duplicateClips, removeTrack, splitClips } from "../model/edits";
import {
  SessionContext,
  useProject,
  useRecording,
  useSession,
  useSessionUi,
  useTransport,
} from "../state/hooks";
import { Session } from "../state/session";
import { Meter } from "../Meter";
import { AudioSettings } from "./AudioSettings";
import { StatusBar } from "./StatusBar";
import { TransportBar } from "./TransportBar";
import { TuneEditor } from "../tune/TuneEditor";
import "../theme.css";
import "./App.css";

/** The Tessera DAW. Creates the session for `platform` and opens the last project. */
export function App({ platform }: { platform: AudioPlatform }) {
  const [session] = useState(() => new Session(platform));
  useEffect(() => {
    void session.init();
    // Save pending edits when the tab is hidden or closed.
    const flush = () => document.visibilityState === "hidden" && void session.flushSave();
    document.addEventListener("visibilitychange", flush);
    return () => document.removeEventListener("visibilitychange", flush);
  }, [session]);

  return (
    <SessionContext.Provider value={session}>
      <Workspace />
    </SessionContext.Provider>
  );
}

function Workspace() {
  const session = useSession();
  const [view, setView] = useState<View>({ framesPerPx: 1200, scrollFrames: 0 });
  const [snap, setSnap] = useState(true);
  const [settingsOpen, setSettingsOpen] = useState(false);
  useShortcuts(setView, () => setSnap((s) => !s));

  return (
    <div className="app">
      <TransportBar
        onOpenSettings={() => setSettingsOpen(true)}
        snap={snap}
        onToggleSnap={() => setSnap((s) => !s)}
        onZoom={(f) => setView((v) => zoomAround(v, f, 0))}
      />
      <Arrange view={view} onView={setView} snap={snap} />
      <TuneEditor />
      <Footer onError={() => session.reportError(undefined)} />
      {settingsOpen && <AudioSettings onClose={() => setSettingsOpen(false)} />}
    </div>
  );
}

function Footer({ onError }: { onError: () => void }) {
  const ui = useSessionUi((s) => s);
  const tracks = useProject((s) => s.project.tracks.length);
  const xruns = useRecording((s) => s.xruns);
  const master = useTransport((s) => s.master);
  const platform = useSession().platform;
  const save = {
    saved: "All changes saved",
    saving: "Saving…",
    unsaved: "Unsaved changes",
    error: "Save failed",
  }[ui.saveState];
  return (
    <StatusBar
      items={[
        <span key="save" data-testid="save-state" className={`save ${ui.saveState}`}>
          {save}
        </span>,
        ui.busy && (
          <span key="busy" className="busy" data-testid="busy">
            {ui.busy}
          </span>
        ),
        ui.error && (
          <button key="error" className="error" data-testid="error" onClick={onError} title="Dismiss">
            {ui.error} ✕
          </button>
        ),
        <span key="spacer" className="spacer" />,
        xruns > 0 && (
          <span key="xruns" className="error" title="Audio dropouts since the device was opened">
            {xruns} dropout{xruns === 1 ? "" : "s"}
          </span>
        ),
        `${tracks} track${tracks === 1 ? "" : "s"}`,
        ui.engineRate ? `${(ui.engineRate / 1000).toFixed(1)} kHz` : "Audio off",
        platform.edition === "web" ? "Web" : "Desktop",
        <span key="master" className="master-meter" title="Master output">
          <Meter reading={master} testId="master-meter" />
        </span>,
      ]}
    />
  );
}

/** Keyboard shortcuts (ignored while typing in a field). */
function useShortcuts(setView: (update: (v: View) => View) => void, toggleSnap: () => void) {
  const session = useSession();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (target.closest("input, textarea, select, [contenteditable]")) return;
      const s = session.store.getState();
      const mod = e.metaKey || e.ctrlKey;
      const selected = [...s.selection.clips];
      const key = e.key.toLowerCase();

      const handled = (() => {
        if (key === " ") {
          if (session.recording.getState().active) void session.stopRecording();
          else session.togglePlay();
        } else if (!mod && key === "r") {
          if (session.recording.getState().active) void session.stopRecording();
          else void session.record();
        } else if (key === "home" || key === "enter") session.seek(0);
        else if (key === "end") session.seek(session.end());
        else if (mod && key === "z" && !e.shiftKey) s.undo();
        else if ((mod && key === "z" && e.shiftKey) || (mod && key === "y")) s.redo();
        else if (mod && key === "a")
          s.select({ clips: new Set(s.project.tracks.flatMap((t) => t.clips.map((c) => c.id))) });
        else if (mod && key === "d" && selected.length) {
          let created: number[] = [];
          s.edit("Duplicate", (p) => void (created = duplicateClips(p, selected)));
          s.select({ clips: new Set(created) });
        } else if (!mod && key === "s") {
          // Split the selected clips, or every clip under the playhead on the selected track.
          const frame = session.transport.getState().position;
          const track = s.project.tracks.find((t) => t.id === s.selection.track);
          const ids = selected.length ? selected : (track?.clips.map((c) => c.id) ?? []);
          if (ids.length) s.edit("Split", (p) => void splitClips(p, ids, frame));
        } else if (key === "delete" || key === "backspace") {
          if (selected.length) s.edit("Delete clips", (p) => deleteClips(p, selected));
          else if (s.selection.track !== undefined) {
            const id = s.selection.track;
            s.edit("Delete track", (p) => removeTrack(p, id));
          } else return false;
        } else if (key === "escape") s.select({ clips: new Set() });
        else if (!mod && key === "l") s.edit("Loop", (p) => void (p.loop.enabled = !p.loop.enabled));
        else if (!mod && key === "c") s.edit("Metronome", (p) => void (p.metronome = !p.metronome));
        else if (!mod && key === "n") toggleSnap();
        else if (key === "=" || key === "+") setView((v) => zoomAround(v, 1 / 1.5, playheadX(v)));
        else if (key === "-") setView((v) => zoomAround(v, 1.5, playheadX(v)));
        else return false;
        return true;
      })();
      if (handled) e.preventDefault();
    };
    const playheadX = (v: View) =>
      Math.max(0, (session.transport.getState().position - v.scrollFrames) / v.framesPerPx);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [session, setView, toggleSnap]);
}

export { HEADER_WIDTH };
