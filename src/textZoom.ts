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
