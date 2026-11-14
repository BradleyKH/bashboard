// Draws a terminal's visible rows from its buffer into a 2D canvas (docs/design/workspace.md
// section 4.30), for ghosts and snapshots that cannot read the WebGL renderer's canvas.
import type { IBufferCell, Terminal } from '@xterm/xterm';
import { background, foreground, type CellColor } from './terminalSnapshotModel';

export interface SnapshotCell {
  width: number;
  height: number;
}

function fgOf(cell: IBufferCell): CellColor {
  if (cell.isFgRGB()) return { mode: 'rgb', packed: cell.getFgColor() };
  if (cell.isFgPalette()) return { mode: 'palette', index: cell.getFgColor() };
  return { mode: 'default' };
}

function bgOf(cell: IBufferCell): CellColor {
  if (cell.isBgRGB()) return { mode: 'rgb', packed: cell.getBgColor() };
  if (cell.isBgPalette()) return { mode: 'palette', index: cell.getBgColor() };
  return { mode: 'default' };
}

/** The visible rows at the terminal's size in CSS px; the cursor and selection are left out. */
export function drawTerminal(term: Terminal, cell: SnapshotCell): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  const cssW = term.cols * cell.width;
  const cssH = term.rows * cell.height;
  canvas.style.width = `${cssW}px`;
  canvas.style.height = `${cssH}px`;
  paint(canvas, term, cssW, cssH, window.devicePixelRatio || 1, false);
  return canvas;
}

/**
 * Redraws `canvas` with the visible rows fitted to `cssW` by `cssH`, for the background tab clusters'
 * panes. Rows too short for legible text are drawn as runs of ink instead of glyphs, which reads
 * the same at that size for far fewer draw calls.
 */
export function drawTerminalInto(canvas: HTMLCanvasElement, term: Terminal, cssW: number, cssH: number): void {
  paint(canvas, term, cssW, cssH, Math.min(2, window.devicePixelRatio || 1), true);
}

/** Below this cell height in CSS px, glyphs are drawn as ink runs. */
const GLYPH_MIN_CELL_PX = 7;

function paint(canvas: HTMLCanvasElement, term: Terminal, cssW: number, cssH: number, dpr: number, fitFont: boolean): void {
  canvas.width = Math.max(1, Math.round(cssW * dpr));
  canvas.height = Math.max(1, Math.round(cssH * dpr));
  const ctx = canvas.getContext('2d');
  if (!ctx || term.cols === 0 || term.rows === 0) return;
  ctx.scale(dpr, dpr);
  ctx.textBaseline = 'middle';
  const cw = cssW / term.cols;
  const ch = cssH / term.rows;
  const glyphs = ch >= GLYPH_MIN_CELL_PX;

  const theme = term.options.theme ?? {};
  const defaultFg = theme.foreground ?? '#ffffff';
  const defaultBg = theme.background ?? '#000000';
  const family = term.options.fontFamily ?? 'monospace';
  const nativeSize = term.options.fontSize ?? 14;
  // A fitted canvas scales glyphs with the cell: a native cell is about 1.2 font sizes tall.
  const size = fitFont ? Math.min(nativeSize, ch / 1.2) : nativeSize;
  const buffer = term.buffer.active;
  const scratch = buffer.getNullCell();

  for (let row = 0; row < term.rows; row++) {
    const line = buffer.getLine(buffer.viewportY + row);
    if (!line) continue;
    const y = row * ch;
    // An ink run: consecutive visible cells of one color, drawn as one bar.
    let runStart = -1;
    let runColor = '';
    const endRun = (col: number): void => {
      if (runStart < 0) return;
      ctx.globalAlpha = 0.75;
      ctx.fillStyle = runColor;
      ctx.fillRect(runStart * cw, y + ch * 0.25, (col - runStart) * cw, ch * 0.5);
      runStart = -1;
    };
    for (let col = 0; col < term.cols; col++) {
      const c = line.getCell(col, scratch);
      if (!c) continue;
      const width = c.getWidth();
      if (width === 0) continue;
      const bold = c.isBold() !== 0;
      let fg = foreground(fgOf(c), bold, theme);
      let bg = background(bgOf(c), theme);
      if (c.isInverse()) [fg, bg] = [bg ?? defaultBg, fg ?? defaultFg];
      const x = col * cw;
      if (bg) {
        ctx.globalAlpha = 1;
        ctx.fillStyle = bg;
        ctx.fillRect(x, y, cw * width, ch);
      }
      const chars = c.getChars();
      const blank = chars === '' || chars === ' ' || c.isInvisible();
      const color = fg ?? defaultFg;
      if (!glyphs) {
        if (blank || color !== runColor) endRun(col);
        if (!blank && runStart < 0) {
          runStart = col;
          runColor = color;
        }
        continue;
      }
      if (blank) continue;
      ctx.font = `${c.isItalic() ? 'italic ' : ''}${bold ? 'bold ' : ''}${size}px ${family}`;
      ctx.globalAlpha = c.isDim() ? 0.5 : 1;
      ctx.fillStyle = color;
      ctx.fillText(chars, x, y + ch / 2);
    }
    endRun(term.cols);
  }
}
