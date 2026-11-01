import { type RefObject, useLayoutEffect } from "react";

/**
 * Sizes a canvas for the device pixel ratio and redraws it with `draw` (in CSS pixels)
 * whenever `deps` change.
 */
export function useCanvas(
  ref: RefObject<HTMLCanvasElement | null>,
  width: number,
  height: number,
  draw: (ctx: CanvasRenderingContext2D, width: number, height: number) => void,
  deps: readonly unknown[],
) {
  useLayoutEffect(() => {
    const canvas = ref.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx || width <= 0 || height <= 0) return;
    const dpr = globalThis.devicePixelRatio || 1;
    const w = Math.round(width * dpr);
    const h = Math.round(height * dpr);
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);
    draw(ctx, width, height);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- callers list what `draw` reads.
  }, [ref, width, height, ...deps]);
}
