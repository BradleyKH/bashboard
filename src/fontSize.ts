import { DEFAULT_SETTINGS } from './settings';

/** Matches the settings dialog's range for font.size (settingsModel.ts). */
export const MIN_FONT_SIZE = 6;
export const MAX_FONT_SIZE = 48;
export const DEFAULT_FONT_SIZE = DEFAULT_SETTINGS.font.size;

/** Moves the size by `delta` px, rounded to whole pixels and clamped to the allowed range. */
export function stepFontSize(size: number, delta: number): number {
  const next = Math.round(size + delta);
  return Math.min(MAX_FONT_SIZE, Math.max(MIN_FONT_SIZE, next));
}
