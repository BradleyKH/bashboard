import './fonts.css';

export const BUNDLED_FONT_FAMILY = 'JetBrainsMono Nerd Font Mono';
const TIMEOUT_MS = 2000;

/**
 * Resolves once both terminal font weights are loaded (or after a 2 second cap).
 * xterm.js measures glyph cell size when a terminal opens, so panes must not be
 * built before this resolves or they size against the fallback font.
 */
export function fontsReady(): Promise<void> {
  const load = Promise.all([
    document.fonts.load(`400 14px "${BUNDLED_FONT_FAMILY}"`),
    document.fonts.load(`700 14px "${BUNDLED_FONT_FAMILY}"`),
  ])
    .then(() => undefined)
    .catch((err) => {
      console.warn('terminal font failed to load', err);
    });
  const cap = new Promise<void>((resolve) => setTimeout(resolve, TIMEOUT_MS));
  return Promise.race([load, cap]);
}
