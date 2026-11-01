import { type Peaks, type Project, PROJECT_SAMPLE_RATE, SCHEMA_VERSION } from "@tessera/schema";
import { trackColor } from "./colors";

/**
 * A synthetic demo session (no audio, only waveform overviews) used to preview the arrange
 * view before any real audio is imported.
 */
export function demoProject(): { project: Project; peaks: Map<number, Peaks> } {
  const sr = PROJECT_SAMPLE_RATE;
  const tempo = 112;
  const bar = ((sr * 60) / tempo) * 4;
  const peaks = new Map<number, Peaks>();
  let nextId = 1;

  const layout: { name: string; parts: [startBar: number, bars: number][]; shape: Shape }[] = [
    {
      name: "Drums",
      parts: [
        [0, 16],
        [16, 16],
      ],
      shape: "drums",
    },
    {
      name: "Bass",
      parts: [
        [4, 12],
        [16, 16],
      ],
      shape: "bass",
    },
    {
      name: "Keys",
      parts: [
        [0, 8],
        [8, 8],
        [24, 8],
      ],
      shape: "pad",
    },
    {
      name: "Lead Vocal",
      parts: [
        [8, 8],
        [20, 10],
      ],
      shape: "vocal",
    },
    { name: "Harmony", parts: [[20, 10]], shape: "vocal" },
    {
      name: "Guitar",
      parts: [
        [12, 4],
        [16, 16],
      ],
      shape: "guitar",
    },
  ];

  const sources: Project["sources"] = [];
  const tracks: Project["tracks"] = layout.map((t, index) => {
    const trackId = nextId++;
    const clips = t.parts.map(([startBar, bars], part) => {
      const sourceId = nextId++;
      const frames = Math.round(bars * bar);
      sources.push({
        id: sourceId,
        name: `${t.name} ${part + 1}.wav`,
        file: `audio/${sourceId}.wav`,
        frames,
        channels: 2,
        originalSampleRate: 44_100,
      });
      peaks.set(sourceId, synthPeaks(t.shape, frames, bar, sourceId));
      return {
        id: nextId++,
        sourceId,
        name: `${t.name} ${part + 1}`,
        start: Math.round(startBar * bar),
        offset: 0,
        length: frames,
        gain: 1,
        fadeIn: t.shape === "pad" ? Math.round(bar / 2) : 0,
        fadeOut: t.shape === "pad" || t.shape === "vocal" ? Math.round(bar / 4) : 0,
      };
    });
    return {
      id: trackId,
      name: t.name,
      color: trackColor(index),
      gain: 1,
      pan: [0, 0, -0.3, 0, 0.4, 0.25][index] ?? 0,
      mute: false,
      solo: false,
      clips,
    };
  });

  const now = new Date().toISOString();
  const project: Project = {
    schemaVersion: SCHEMA_VERSION,
    id: "demo",
    name: "Demo Session",
    sampleRate: sr,
    tempo,
    timeSignature: { numerator: 4, denominator: 4 },
    masterGain: 1,
    metronome: false,
    loop: { enabled: true, start: Math.round(8 * bar), end: Math.round(16 * bar) },
    tracks,
    sources,
    nextId,
    createdAt: now,
    modifiedAt: now,
  };
  return { project, peaks };
}

type Shape = "drums" | "bass" | "pad" | "vocal" | "guitar";

const FRAMES_PER_PEAK = 256;

function synthPeaks(shape: Shape, frames: number, bar: number, seed: number): Peaks {
  const buckets = Math.ceil(frames / FRAMES_PER_PEAK);
  const beat = bar / 4;
  let state = seed * 7919;
  const rand = () => {
    state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
    return state / 2_147_483_648;
  };
  const channel = (spread: number) => {
    const data: number[] = [];
    for (let b = 0; b < buckets; b++) {
      const t = b * FRAMES_PER_PEAK;
      const inBeat = (t % beat) / beat;
      const inBar = (t % bar) / bar;
      let env: number;
      switch (shape) {
        case "drums":
          env = 0.15 + 0.8 * Math.exp(-inBeat * 9) + (Math.abs(inBeat - 0.5) < 0.04 ? 0.4 : 0);
          break;
        case "bass":
          env = 0.35 + 0.35 * Math.exp(-((t % (beat / 2)) / (beat / 2)) * 4);
          break;
        case "pad":
          env = 0.3 + 0.15 * Math.sin(inBar * Math.PI * 2);
          break;
        case "vocal": {
          const phrase = (t % (bar * 2)) / (bar * 2);
          env =
            phrase < 0.8 ? 0.25 + 0.45 * Math.abs(Math.sin(phrase * 23)) * Math.sin(phrase * Math.PI) : 0.02;
          break;
        }
        case "guitar":
          env = 0.2 + 0.5 * Math.exp(-((t % (beat * 2)) / (beat * 2)) * 3);
          break;
      }
      const amp = Math.min(0.98, env * (0.75 + 0.25 * rand()) * spread);
      data.push(-amp * (0.85 + 0.15 * rand()), amp);
    }
    return data;
  };
  return { framesPerPeak: FRAMES_PER_PEAK, data: [channel(1), channel(0.92)] };
}
