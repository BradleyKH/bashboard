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
  const dpr = window.devicePixelRatio || 1;
  const canvas = document.createElement('canvas');
  const cssW = term.cols * cell.width;
  const cssH = term.rows * cell.height;
  canvas.width = Math.round(cssW * dpr);
  canvas.height = Math.round(cssH * dpr);
  canvas.style.width = `${cssW}px`;
  canvas.style.height = `${cssH}px`;
  const ctx = canvas.getContext('2d');
  if (!ctx) return canvas;
  ctx.scale(dpr, dpr);
  ctx.textBaseline = 'middle';

  const theme = term.options.theme ?? {};
  const defaultFg = theme.foreground ?? '#ffffff';
  const defaultBg = theme.background ?? '#000000';
  const family = term.options.fontFamily ?? 'monospace';
  const size = term.options.fontSize ?? 14;
  const buffer = term.buffer.active;
  const scratch = buffer.getNullCell();

  for (let row = 0; row < term.rows; row++) {
    const line = buffer.getLine(buffer.viewportY + row);
    if (!line) continue;
    const y = row * cell.height;
    for (let col = 0; col < term.cols; col++) {
      const c = line.getCell(col, scratch);
      if (!c) continue;
      const width = c.getWidth();
      if (width === 0) continue;
      const bold = c.isBold() !== 0;
      let fg = foreground(fgOf(c), bold, theme);
      let bg = background(bgOf(c), theme);
      if (c.isInverse()) [fg, bg] = [bg ?? defaultBg, fg ?? defaultFg];
      const x = col * cell.width;
      if (bg) {
        ctx.fillStyle = bg;
        ctx.fillRect(x, y, cell.width * width, cell.height);
      }
      const chars = c.getChars();
      if (chars === '' || chars === ' ' || c.isInvisible()) continue;
      ctx.font = `${c.isItalic() ? 'italic ' : ''}${bold ? 'bold ' : ''}${size}px ${family}`;
      ctx.globalAlpha = c.isDim() ? 0.5 : 1;
      ctx.fillStyle = fg ?? defaultFg;
      ctx.fillText(chars, x, y + cell.height / 2);
    }
  }
  return canvas;
}
