// The Matrix rain's color (docs/design/data.md section 8, backdrop.matrix.color). The setting picks
// a mode; the backdrop host resolves it to the #rrggbb the renderer draws with.

export type MatrixColorMode = 'green' | 'accent';

/** Mirrors MATRIX_COLOR_MODES in src-tauri/src/settings/model.rs. */
export const DEFAULT_MATRIX_COLOR_MODE: MatrixColorMode = 'green';

export const MATRIX_COLOR_MODES: { value: MatrixColorMode; label: string }[] = [
  { value: 'green', label: 'Green' },
  { value: 'accent', label: 'Accent' },
];

export const MATRIX_GREEN = '#00ff41';

// The accent presets are muted for UI chrome, and rain drawn in them looks washed out against
// the classic green. Raising saturation by half keeps a gray accent like Silver gray.
const SATURATION_BOOST = 1.5;

/** The accent at full brightness with its saturation raised, keeping its hue. */
export function accentRain(accent: string): string {
  const n = parseInt(accent.slice(1, 7), 16);
  const rgb = [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
  const max = Math.max(...rgb);
  const min = Math.min(...rgb);
  const saturation = max === 0 ? 0 : (max - min) / max;
  const floor = 255 * (1 - Math.min(1, saturation * SATURATION_BOOST));
  return `#${rgb
    .map((c) => {
      const t = max === min ? 1 : (c - min) / (max - min);
      return Math.round(floor + t * (255 - floor)).toString(16).padStart(2, '0');
    })
    .join('')}`;
}

/** The #rrggbb rain color for a mode and accent. */
export function matrixRainColor(mode: string, accent: string): string {
  return mode === 'accent' ? accentRain(accent) : MATRIX_GREEN;
}
