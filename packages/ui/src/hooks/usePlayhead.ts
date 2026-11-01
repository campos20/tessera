import type { LoopRegion } from "@tessera/schema";
import { useEffect, useRef } from "react";
import { useSession } from "../state/hooks";

/**
 * Calls `onFrame` with the playhead position on every animation frame. Between engine
 * reports (~30 per second) the position is extrapolated from the elapsed time, wrapping at
 * the loop end, so the playhead moves smoothly. Runs outside React rendering.
 */
export function usePlayhead(onFrame: (frame: number) => void) {
  const session = useSession();
  const callback = useRef(onFrame);
  useEffect(() => {
    callback.current = onFrame;
  });
  useEffect(() => {
    let raf = 0;
    const tick = () => {
      const { playing, position, reportedAt } = session.transport.getState();
      const project = session.store.getState().project;
      let frame = position;
      if (playing) {
        // Never extrapolate far: if reports stop (tab hidden, engine stalled) the playhead waits.
        const elapsed = Math.min(0.25, (performance.now() - reportedAt) / 1000);
        frame = wrapLoop(position, position + elapsed * project.sampleRate, project.loop);
      }
      callback.current(frame);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [session]);
}

function wrapLoop(reported: number, frame: number, loop: LoopRegion): number {
  if (!loop.enabled || loop.end <= loop.start || reported >= loop.end || frame < loop.end) return frame;
  return loop.start + ((frame - loop.end) % (loop.end - loop.start));
}
