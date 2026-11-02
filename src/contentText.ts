// The text color of scratch, file preview, and search panes (docs/design.md section 8,
// contentTextColor). CSS reads it as --content-fg; terminals keep their own foreground.

export const DEFAULT_CONTENT_TEXT = '#e6e6e6';

/**
 * Mirrors CONTENT_TEXT_MIN_LUMINANCE in src-tauri/src/settings.rs. Well above the accent's floor,
 * since this is body text and the accent must stay the brighter color for links and highlights.
 */
export const CONTENT_TEXT_MIN_LUMINANCE = 0.5;

// Pale tints of the ACCENT_PRESETS hues (about 35% of the accent mixed into near-white), labeled
// to pair with them, so any pick keeps the accent more saturated than the text around it.
export const CONTENT_TEXT_PRESETS: { value: string; label: string }[] = [
  { value: DEFAULT_CONTENT_TEXT, label: 'White' },
  { value: '#d4dadf', label: 'Silver' },
  { value: '#edd1b5', label: 'Orange' },
  { value: '#e8ddb5', label: 'Gold' },
  { value: '#bfdec9', label: 'Green' },
  { value: '#b5d8df', label: 'Teal' },
  { value: '#b9d0ed', label: 'Blue' },
  { value: '#d4caf3', label: 'Violet' },
  { value: '#e8c4e5', label: 'Pink' },
];

export function applyContentText(
  root: { style: { setProperty(name: string, value: string): void } },
  hex: string,
): void {
  root.style.setProperty('--content-fg', hex);
}
