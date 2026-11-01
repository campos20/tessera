import type { Clip, Track } from "@tessera/schema";
import { frameToX, type View } from "./timeScale";

export type ClipPart = "body" | "trim-start" | "trim-end" | "fade-in" | "fade-out";

export interface ClipHit {
  clip: Clip;
  part: ClipPart;
}

/** Height of the clip's name strip, where the fade handles live. */
export const CLIP_HEADER = 15;
const EDGE_PX = 6;
const FADE_HANDLE_PX = 7;

/** What is under `(x, y)` in a lane, in lane-local CSS pixels. Later clips win overlaps. */
export function hitTestClip(track: Track, view: View, x: number, y: number): ClipHit | undefined {
  for (let i = track.clips.length - 1; i >= 0; i--) {
    const clip = track.clips[i]!;
    const x0 = frameToX(clip.start, view);
    const x1 = frameToX(clip.start + clip.length, view);
    if (x < x0 || x > x1) continue;
    const width = x1 - x0;
    if (y <= CLIP_HEADER + 2 && width > 4 * FADE_HANDLE_PX) {
      const fadeInX = x0 + clip.fadeIn / view.framesPerPx;
      const fadeOutX = x1 - clip.fadeOut / view.framesPerPx;
      if (Math.abs(x - fadeInX) <= FADE_HANDLE_PX) return { clip, part: "fade-in" };
      if (Math.abs(x - fadeOutX) <= FADE_HANDLE_PX) return { clip, part: "fade-out" };
    }
    if (width > 3 * EDGE_PX) {
      if (x - x0 <= EDGE_PX) return { clip, part: "trim-start" };
      if (x1 - x <= EDGE_PX) return { clip, part: "trim-end" };
    }
    return { clip, part: "body" };
  }
  return undefined;
}

export const CURSORS: Record<ClipPart, string> = {
  body: "grab",
  "trim-start": "w-resize",
  "trim-end": "e-resize",
  "fade-in": "col-resize",
  "fade-out": "col-resize",
};
