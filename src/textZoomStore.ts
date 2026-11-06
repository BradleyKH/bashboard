import { ZOOM_LEVELS } from './textZoom';

/** The zoom a new pane of each kind starts at (docs/design/files.md sections 4.12 to 4.16). */
export interface TextZoom {
  filesList: number;
  filePreview: number;
  gitDiff: number;
  searchPreview: number;
  scratch: number;
  containerLogs: number;
}
export type TextZoomKey = keyof TextZoom;

export const DEFAULT_TEXT_ZOOM: TextZoom = {
  filesList: 1,
  filePreview: 1,
  gitDiff: 1,
  searchPreview: 1,
  scratch: 1,
  containerLogs: 1,
};

function parseLevel(v: unknown): number {
  const ok = typeof v === 'number' && v >= ZOOM_LEVELS[0] && v <= ZOOM_LEVELS[ZOOM_LEVELS.length - 1];
  return ok ? v : 1;
}

/** workspace.json's `textZoom`; each missing or out-of-range field falls back to 1. */
export function parseTextZoom(raw: unknown): TextZoom {
  const r = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};
  const out = { ...DEFAULT_TEXT_ZOOM };
  for (const key of Object.keys(out) as TextZoomKey[]) out[key] = parseLevel(r[key]);
  return out;
}

let current: TextZoom = { ...DEFAULT_TEXT_ZOOM };
let listener: (() => void) | null = null;

export function textZoom(key: TextZoomKey): number {
  return current[key];
}

export function textZoomSnapshot(): TextZoom {
  return { ...current };
}

/** Restores the levels from workspace.json, before any pane is built. */
export function loadTextZoom(zoom: TextZoom): void {
  current = { ...zoom };
}

/** A zoom button stepped; the next pane of that kind starts at `zoom`. */
export function setTextZoom(key: TextZoomKey, zoom: number): void {
  current = { ...current, [key]: zoom };
  listener?.();
}

/** One listener, the workspace saver. */
export function onTextZoomChange(fn: () => void): void {
  listener = fn;
}
