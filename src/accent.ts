// The UI accent color (docs/design/data.md section 8, accentColor). CSS reads it as --accent;
// xterm.js takes literal colors only, so terminals get the shades computed here.

export const DEFAULT_ACCENT = '#4fb3c8';

/**
 * Mirrors ACCENT_MIN_LUMINANCE in src-tauri/src/settings.rs. The accent is drawn as text and
 * borders on near-black panes and sits behind dark text (#06121a) in find highlights; at 0.2
 * both keep at least 4.5:1 contrast.
 */
export const ACCENT_MIN_LUMINANCE = 0.2;

// Red is left out so the accent never reads as the failed status mark. Green is the done mark's
// color, so a green accent makes a waiting session's dot match a done one in hue; the shapes differ.
export const ACCENT_PRESETS: { value: string; label: string }[] = [
  { value: '#a8b8c8', label: 'Silver' },
  { value: '#f0a050', label: 'Orange' },
  { value: '#e0c050', label: 'Gold' },
  { value: '#6cc487', label: 'Green' },
  { value: DEFAULT_ACCENT, label: 'Teal' },
  { value: '#5b9cf0', label: 'Blue' },
  { value: '#a68bff', label: 'Violet' },
  { value: '#e07ad8', label: 'Pink' },
];

function channels(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1, 7), 16);
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
}

/** WCAG relative luminance of a #rrggbb color. */
export function relativeLuminance(hex: string): number {
  const [r, g, b] = channels(hex).map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** Mixes the color toward black, keeping `fraction` of it; matches color-mix(in srgb, c f%, black). */
export function darken(hex: string, fraction: number): string {
  return `#${channels(hex)
    .map((c) => Math.round(c * fraction).toString(16).padStart(2, '0'))
    .join('')}`;
}

/** The literal colors a terminal draws with the accent. */
export function terminalAccent(hex: string): {
  matchBackground: string;
  activeMatchBackground: string;
  selectionInactiveBackground: string;
} {
  return {
    // Search decorations must be opaque, so the dim match is a darkened shade rather than a tint.
    matchBackground: darken(hex, 0.52),
    activeMatchBackground: hex,
    selectionInactiveBackground: `${hex}80`,
  };
}

export function applyAccent(root: { style: { setProperty(name: string, value: string): void } }, hex: string): void {
  root.style.setProperty('--accent', hex);
}
