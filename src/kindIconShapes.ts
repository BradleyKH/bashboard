// Line drawings for the pane kind icons on Linux and macOS (glyphIcon.ts). Pure data, no DOM.
import { PANE_KINDS, type PaneKind } from './paneKinds';

export type IconShape = { path: string } | { circle: [cx: number, cy: number, r: number] };

/**
 * One 16 by 16 drawing per kind, stroked in the rocket's weight (rocketIcon.ts), which draws Ship.
 * There the kinds' text glyphs come from whichever installed fonts carry them (a Nerd Font,
 * DejaVu, Noto Symbols, Noto CJK), each at its own size and weight, so a row of them never
 * matched. Windows keeps the glyphs: Segoe UI Symbol carries all of them.
 */
export const KIND_ICON_SHAPES: Readonly<Record<Exclude<PaneKind, 'ship'>, readonly IconShape[]>> = {
  terminal: [{ path: 'M5.5 3.5 10 8l-4.5 4.5' }],
  containers: [{ path: 'M8 2l5.2 3v6L8 14l-5.2-3V5Z' }],
  files: [{ path: 'M2 4.5c0-.6.4-1 1-1h3.2l1.5 1.5H13c.6 0 1 .4 1 1v6c0 .6-.4 1-1 1H3c-.6 0-1-.4-1-1Z' }],
  git: [
    { circle: [5, 3.5, 1.5] },
    { circle: [5, 12.5, 1.5] },
    { circle: [11, 5.5, 1.5] },
    { path: 'M5 5v6M11 7c0 2.5-6 1.5-6 4' },
  ],
  browser: [{ circle: [8, 8, 6] }, { path: 'M2 8h12M8 2c-2.2 2.2-2.2 9.8 0 12M8 2c2.2 2.2 2.2 9.8 0 12' }],
  ports: [{ path: 'M3 5.5h10M10.5 3 13 5.5 10.5 8M13 10.5H3M5.5 8 3 10.5 5.5 13' }],
  scratch: [{ path: 'M3.5 2.5h9v11h-9ZM5.5 5.5h5M5.5 8h5M5.5 10.5h3' }],
  search: [{ circle: [7, 7, 4.5] }, { path: 'M10.3 10.3 13.5 13.5' }],
};

/** The shapes for a kind's icon glyph, or null for a glyph that is not a pane kind's (or is Ship's). */
export function kindIconShapes(glyph: string): readonly IconShape[] | null {
  const info = PANE_KINDS.find((k) => k.icon === glyph);
  if (!info || info.kind === 'ship') return null;
  return KIND_ICON_SHAPES[info.kind];
}
