import { invoke } from '@tauri-apps/api/core';
import { BUNDLED_FONT_FAMILY } from './fontsReady';

/** An installed font family the core listed (docs/design.md section 3.17). */
export interface FontFamily {
  family: string;
  monospace: boolean;
}

export function listFonts(): Promise<FontFamily[]> {
  return invoke<FontFamily[]>('fonts');
}

/**
 * The bundled font leads, then the installed families in the core's order. The page loads the
 * bundled font itself, so DirectWrite never lists it.
 */
export function fontSuggestions(found: FontFamily[]): string[] {
  const bundled = BUNDLED_FONT_FAMILY.toLowerCase();
  return [BUNDLED_FONT_FAMILY, ...found.map((f) => f.family).filter((name) => name.toLowerCase() !== bundled)];
}

/**
 * Chromium reports a datalist pick as `insertReplacementText` (or no type at all), while typing
 * gives `insertText` and the like, so a full name typed by hand is not mistaken for a pick.
 */
export function isSuggestionPick(inputType: string | undefined, value: string, options: readonly string[]): boolean {
  return (inputType === undefined || inputType === 'insertReplacementText') && options.includes(value);
}
