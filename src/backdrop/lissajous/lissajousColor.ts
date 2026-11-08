// The Lissajous backdrop's line color (docs/design/data.md section 8, backdrop.lissajous.color).
// The setting picks a mode; the backdrop host resolves it to what the renderer strokes with.
import { accentRain } from '../matrix/rainColor';

export type LissajousColorMode = 'accent' | 'white' | 'spectrum';

/** Mirrors LISSAJOUS_COLOR_MODES in src-tauri/src/settings/model.rs. */
export const DEFAULT_LISSAJOUS_COLOR_MODE: LissajousColorMode = 'accent';

export const LISSAJOUS_COLOR_MODES: { value: LissajousColorMode; label: string }[] = [
  { value: 'accent', label: 'Accent' },
  { value: 'white', label: 'White' },
  { value: 'spectrum', label: 'Spectrum' },
];

export const LISSAJOUS_WHITE = '#e6e6e6';

const SPECTRUM_SATURATION = 85;
const SPECTRUM_LIGHTNESS = 62;

/** The one #rrggbb the line strokes in, or 'spectrum' for a hue that runs along it. */
export function lissajousLineColor(mode: string, accent: string): string {
  if (mode === 'spectrum') return 'spectrum';
  return mode === 'white' ? LISSAJOUS_WHITE : accentRain(accent);
}

/** The spectrum's color at a share 0..1 along the line, with the whole wheel turned by `shift` degrees. */
export function spectrumColor(along: number, shift: number): string {
  const hue = (((along * 360 + shift) % 360) + 360) % 360;
  return `hsl(${hue.toFixed(1)} ${SPECTRUM_SATURATION}% ${SPECTRUM_LIGHTNESS}%)`;
}

/** A swatch for the Settings tab: the color itself, or the spectrum as a gradient. */
export function lissajousSwatch(mode: string, accent: string): string {
  if (mode !== 'spectrum') return lissajousLineColor(mode, accent);
  const stops = [0, 0.2, 0.4, 0.6, 0.8, 1].map((t) => spectrumColor(t, 0));
  return `linear-gradient(90deg, ${stops.join(', ')})`;
}
