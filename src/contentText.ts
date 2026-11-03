// The text color of non-terminal pane content and the dashboard (docs/design.md section 8,
// contentTextColor). The setting picks a mode; the color is derived from the accent here, so the
// two always pair. CSS reads it as --content-fg; terminals take it only for pure white text.

import { relativeLuminance } from './accent';

export type ContentTextMode = 'accent' | 'white';

/** Mirrors CONTENT_TEXT_MODES in src-tauri/src/settings.rs. */
export const DEFAULT_CONTENT_TEXT_MODE: ContentTextMode = 'accent';

export const CONTENT_TEXT_MODES: { value: ContentTextMode; label: string }[] = [
  { value: 'accent', label: 'Accent tint' },
  { value: 'white', label: 'White' },
];

export const WHITE_TEXT = '#e6e6e6';

/**
 * Body text is read in long stretches, so it must stay well brighter than the dark panes, and
 * well above the accent's floor so the accent stays the brighter color for links and highlights.
 */
export const CONTENT_TEXT_MIN_LUMINANCE = 0.5;

// 35% of the accent into near-white keeps the tint pale enough that the accent stays the most
// saturated color on screen.
const TINT_BASE: [number, number, number] = [0xec, 0xec, 0xec];
const TINT_FRACTION = 0.35;

function mix(accent: string, fraction: number): string {
  const n = parseInt(accent.slice(1, 7), 16);
  const rgb = [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
  return `#${rgb
    .map((c, i) => Math.round(c * fraction + TINT_BASE[i] * (1 - fraction)).toString(16).padStart(2, '0'))
    .join('')}`;
}

/**
 * The pale tint of an accent used as text. A dim accent (one near its own luminance floor) can
 * mix below the text floor, so the accent's share shrinks until the tint is bright enough.
 */
export function accentTint(accent: string): string {
  for (let fraction = TINT_FRACTION; fraction > 0; fraction -= 0.05) {
    const tint = mix(accent, fraction);
    if (relativeLuminance(tint) >= CONTENT_TEXT_MIN_LUMINANCE) return tint;
  }
  return mix(accent, 0);
}

/** The #rrggbb content text color for a mode and accent. */
export function contentTextColor(mode: string, accent: string): string {
  return mode === 'white' ? WHITE_TEXT : accentTint(accent);
}

export function applyContentText(
  root: { style: { setProperty(name: string, value: string): void } },
  hex: string,
): void {
  root.style.setProperty('--content-fg', hex);
}

/** Index of pure white (#ffffff) in the 256-color cube, as an offset into xterm's extendedAnsi. */
const CUBE_WHITE = 231 - 16;

/**
 * The terminal theme entries that put the content text color on pure white: the default
 * foreground, bright white (SGR 97, index 15), and the cube's #ffffff (index 231). Plain white
 * (SGR 37, #e5e5e5) is left alone, since programs use it as a deliberately dimmer shade, and every
 * other color a program picks is kept. Truecolor white (38;2;255;255;255) bypasses the theme.
 */
export function terminalWhites(hex: string): { foreground: string; brightWhite: string; extendedAnsi: string[] } {
  // Unset slots fall back to xterm's own palette.
  const extendedAnsi: string[] = [];
  extendedAnsi[CUBE_WHITE] = hex;
  return { foreground: hex, brightWhite: hex, extendedAnsi };
}
