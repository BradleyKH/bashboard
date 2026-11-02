/** Browser-style zoom levels for the Files pane's list and preview. */
export const ZOOM_LEVELS = [0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3];

/** The next level up (`dir` 1) or down (-1) from `zoom`, staying put at either end. */
export function stepZoom(zoom: number, dir: 1 | -1): number {
  if (dir > 0) return ZOOM_LEVELS.find((z) => z > zoom + 1e-9) ?? ZOOM_LEVELS[ZOOM_LEVELS.length - 1];
  for (let i = ZOOM_LEVELS.length - 1; i >= 0; i--) if (ZOOM_LEVELS[i] < zoom - 1e-9) return ZOOM_LEVELS[i];
  return ZOOM_LEVELS[0];
}

export function zoomPercent(zoom: number): string {
  return `${Math.round(zoom * 100)}%`;
}

/**
 * Ctrl+wheel distance, in pixels, per zoom step. A mouse notch (about 100) steps once; a touchpad
 * pinch arrives as a stream of small deltas, so it adds up over several events instead of
 * running to either end of the range.
 */
export const WHEEL_STEP_DELTA = 50;

/**
 * Adds a Ctrl+wheel `deltaY` to the running total `acc`. Returns the zoom direction once the total
 * crosses a step (wheel up zooms in) and the total to carry into the next event. A reversed
 * direction drops what had built up, so a pinch that turns around responds at once.
 */
export function accumulateWheel(acc: number, deltaY: number): { dir: 1 | -1 | 0; acc: number } {
  const total = Math.sign(acc) === -Math.sign(deltaY) ? deltaY : acc + deltaY;
  if (Math.abs(total) < WHEEL_STEP_DELTA) return { dir: 0, acc: total };
  return { dir: total < 0 ? 1 : -1, acc: 0 };
}
