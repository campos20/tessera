import type { AudioPlatform } from "@tessera/platform";
import { useMemo, useState } from "react";
import { Arrange } from "../arrange/Arrange";
import { framesPerBar, type View, zoomAround } from "../arrange/timeScale";
import { type MeterReading } from "../Meter";
import { demoProject } from "../model/demoProject";
import { StatusBar } from "./StatusBar";
import { TransportBar } from "./TransportBar";
import "../theme.css";
import "./App.css";

/**
 * The DAW shell. M2 step 1 (visual checkpoint): renders a demo session; editing, the store,
 * engine sync and persistence are wired in the following steps.
 */
export function App({ platform }: { platform: AudioPlatform }) {
  const [initial] = useState(demoProject);
  const [project, setProject] = useState(initial.project);
  const [view, setView] = useState<View>({ framesPerPx: 1200, scrollFrames: 0 });
  const [selectedTrack, setSelectedTrack] = useState<number>();
  const bar = framesPerBar({
    sampleRate: project.sampleRate,
    tempo: project.tempo,
    timeSignature: project.timeSignature,
  });
  const [position, setPosition] = useState(Math.round(10.5 * bar));
  const meters = useMemo(() => new Map<number, MeterReading>(), []);
  const selectedClips = useMemo(() => new Set([project.tracks[3]?.clips[0]?.id ?? -1]), [project.tracks]);

  return (
    <div className="app">
      <TransportBar
        projectName={project.name}
        playing={false}
        position={position}
        meter={{ sampleRate: project.sampleRate, tempo: project.tempo, timeSignature: project.timeSignature }}
        loop={project.loop.enabled}
        metronome={project.metronome}
        snap
        onPlay={() => {}}
        onStop={() => {}}
        onRewind={() => setPosition(0)}
        onToggleLoop={() => setProject((p) => ({ ...p, loop: { ...p.loop, enabled: !p.loop.enabled } }))}
        onToggleMetronome={() => setProject((p) => ({ ...p, metronome: !p.metronome }))}
        onToggleSnap={() => {}}
        onTempo={(tempo) => tempo > 0 && setProject((p) => ({ ...p, tempo }))}
        onZoom={(factor) => setView((v) => zoomAround(v, factor, 0))}
      />
      <Arrange
        project={project}
        peaks={initial.peaks}
        view={view}
        onView={setView}
        position={position}
        meters={meters}
        selectedTrack={selectedTrack}
        selectedClips={selectedClips}
        onSeek={setPosition}
        onTrackChange={(id, patch) =>
          setProject((p) => ({ ...p, tracks: p.tracks.map((t) => (t.id === id ? { ...t, ...patch } : t)) }))
        }
        onSelectTrack={setSelectedTrack}
        onAddTrack={() => {}}
      />
      <StatusBar
        items={[
          platform.edition === "web" ? "Web edition" : "Desktop edition",
          `${project.tracks.length} tracks`,
          `${project.sampleRate / 1000} kHz project`,
          "Demo session (preview)",
        ]}
      />
    </div>
  );
}
