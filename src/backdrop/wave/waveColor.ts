// The Wave backdrop's line color (docs/design/data.md section 8, backdrop.wave.color).
// The setting picks a mode; the backdrop host resolves it to what the renderer strokes with.
import { accentRain } from '../matrix/rainColor';

export type WaveColorMode = 'accent' | 'white' | 'spectrum';

/** Mirrors WAVE_COLOR_MODES in src-tauri/src/settings/model.rs. */
export const DEFAULT_WAVE_COLOR_MODE: WaveColorMode = 'accent';

export const WAVE_COLOR_MODES: { value: WaveColorMode; label: string }[] = [
  { value: 'accent', label: 'Accent' },
  { value: 'white', label: 'White' },
  { value: 'spectrum', label: 'Spectrum' },
];

export const WAVE_WHITE = '#e6e6e6';

const SPECTRUM_SATURATION = 85;
const SPECTRUM_LIGHTNESS = 62;

/** The one #rrggbb the line strokes in, or 'spectrum' for a hue that runs along it. */
export function waveLineColor(mode: string, accent: string): string {
  if (mode === 'spectrum') return 'spectrum';
  return mode === 'white' ? WAVE_WHITE : accentRain(accent);
}

/** The spectrum's color at a share 0..1 along the line, with the whole wheel turned by `shift` degrees. */
export function spectrumColor(along: number, shift: number): string {
  const hue = (((along * 360 + shift) % 360) + 360) % 360;
  return `hsl(${hue.toFixed(1)} ${SPECTRUM_SATURATION}% ${SPECTRUM_LIGHTNESS}%)`;
}

/** A swatch for the Settings tab: the color itself, or the spectrum as a gradient. */
export function waveSwatch(mode: string, accent: string): string {
  if (mode !== 'spectrum') return waveLineColor(mode, accent);
  const stops = [0, 0.2, 0.4, 0.6, 0.8, 1].map((t) => spectrumColor(t, 0));
  return `linear-gradient(90deg, ${stops.join(', ')})`;
}
