// Color resolution for drawing a terminal's buffer outside xterm.js (docs/design/workspace.md
// section 4.30). No DOM, so it is unit-tested.
import type { ITheme } from '@xterm/xterm';

/** xterm.js's built-in ANSI colors, used for any slot the theme leaves unset. */
const XTERM_ANSI = [
  '#2e3436', '#cc0000', '#4e9a06', '#c4a000', '#3465a4', '#75507b', '#06989a', '#d3d7cf',
  '#555753', '#ef2929', '#8ae234', '#fce94f', '#729fcf', '#ad7fa8', '#34e2e2', '#eeeeec',
];

const ANSI_KEYS = [
  'black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white',
  'brightBlack', 'brightRed', 'brightGreen', 'brightYellow', 'brightBlue', 'brightMagenta', 'brightCyan', 'brightWhite',
] as const;

const CUBE_LEVELS = [0, 95, 135, 175, 215, 255];

const hex2 = (n: number): string => n.toString(16).padStart(2, '0');
const rgbHex = (r: number, g: number, b: number): string => `#${hex2(r)}${hex2(g)}${hex2(b)}`;

/** A 256-color palette index as #rrggbb, through the theme's ANSI and extended slots first. */
export function paletteColor(index: number, theme: ITheme): string {
  if (index < 16) return theme[ANSI_KEYS[index]] ?? XTERM_ANSI[index];
  const extended = theme.extendedAnsi?.[index - 16];
  if (extended) return extended;
  if (index < 232) {
    const i = index - 16;
    return rgbHex(CUBE_LEVELS[Math.floor(i / 36)], CUBE_LEVELS[Math.floor(i / 6) % 6], CUBE_LEVELS[i % 6]);
  }
  const gray = 8 + (index - 232) * 10;
  return rgbHex(gray, gray, gray);
}

/** A packed 0xRRGGBB truecolor value as #rrggbb. */
export function rgbColor(packed: number): string {
  return rgbHex((packed >> 16) & 0xff, (packed >> 8) & 0xff, packed & 0xff);
}

/** One side of a cell's color as xterm.js reports it. */
export type CellColor = { mode: 'default' } | { mode: 'palette'; index: number } | { mode: 'rgb'; packed: number };

/**
 * The foreground to draw, or null for the theme default. Bold lifts the first eight colors to
 * their bright pair, as xterm.js does with `drawBoldTextInBrightColors` on.
 */
export function foreground(color: CellColor, bold: boolean, theme: ITheme): string | null {
  if (color.mode === 'rgb') return rgbColor(color.packed);
  if (color.mode === 'palette') return paletteColor(bold && color.index < 8 ? color.index + 8 : color.index, theme);
  return null;
}

/** The background to fill, or null when the cell leaves the transparent default. */
export function background(color: CellColor, theme: ITheme): string | null {
  if (color.mode === 'rgb') return rgbColor(color.packed);
  if (color.mode === 'palette') return paletteColor(color.index, theme);
  return null;
}
