// Model for the Matrix backdrop style: one falling drop per column on a cell grid.
// DOM-free and deterministic for an injected `random`; the renderer owns pixels, fading,
// colors, and the step clock.
//
// Contract: each step() advances every drop one row and returns the glyphs to draw. A drop
// contributes its new head cell (head: true) and, when the previous head cell is on screen,
// that cell again (head: false) with the same char, so the renderer can overdraw the bright
// head in the normal trail color instead of leaving a white streak. Rows outside the grid
// are never emitted.

/** Half-width katakana, digits, and a few symbols. No font is bundled; see MATRIX_FONT_FAMILY. */
export const GLYPHS =
  Array.from({ length: 0xff9d - 0xff66 + 1 }, (_, i) => String.fromCharCode(0xff66 + i)).join('') +
  '0123456789' +
  ':.=*+-<>|';

// MS Gothic and Yu Gothic both ship with every Windows 10 and 11 install and cover the
// half-width katakana; the matching bundled-font option (Matrix Code NFI) is not redistributable.
export const MATRIX_FONT_FAMILY = '"MS Gothic", "Yu Gothic", monospace';

// Glyphs are drawn unmirrored here: the renderer flips the whole canvas with CSS scaleX(-1),
// which mirrors them (the film look) without a per-glyph transform.

export interface Glyph {
  col: number;
  row: number;
  char: string;
  head: boolean;
}

interface Drop {
  /** Row of the head; -1 while the column is idle between drops. */
  row: number;
  /** Char currently at the head, redrawn as trail on the next step. */
  char: string;
}

/**
 * Chance per step that an idle column starts a drop, at density 1. A drop's head is followed
 * by a mean gap of 1 / chance steps, about 33, which leaves a 1080p window's columns idle for
 * roughly a third of the time.
 */
export const BASE_START_CHANCE = 0.03;

export class MatrixRain {
  private drops: Drop[] = [];
  private _cols = 0;
  private _rows = 0;
  private startChance = BASE_START_CHANCE;

  constructor(private readonly random: () => number = Math.random) {}

  get cols(): number {
    return this._cols;
  }

  get rows(): number {
    return this._rows;
  }

  /** Mean steps an idle column waits before its next drop. */
  get meanGap(): number {
    return 1 / this.startChance;
  }

  /** Scales how often new drops start; 1 is the default rate. */
  setDensity(density: number): void {
    this.startChance = Math.min(1, Math.max(0, BASE_START_CHANCE * density));
  }

  /** Rebuilds the grid for a canvas size. Drops in columns that still exist keep their place. */
  resize(widthPx: number, heightPx: number, cellPx: number): void {
    const cell = Math.max(1, cellPx);
    const cols = Math.max(0, Math.ceil(widthPx / cell));
    const rows = Math.max(0, Math.ceil(heightPx / cell));
    this._rows = rows;
    this._cols = cols;
    this.drops.length = Math.min(this.drops.length, cols);
    while (this.drops.length < cols) this.drops.push({ row: -1, char: GLYPHS[0] });
  }

  step(): Glyph[] {
    const out: Glyph[] = [];
    for (let col = 0; col < this.drops.length; col++) {
      const d = this.drops[col];
      if (d.row < 0) {
        // Idle columns start independently, which keeps them out of lockstep.
        if (this.random() >= this.startChance) continue;
        d.row = -1;
      } else if (d.row < this._rows) {
        out.push({ col, row: d.row, char: d.char, head: false });
      }
      d.row++;
      if (d.row >= this._rows) {
        d.row = -1;
        continue;
      }
      d.char = this.randomChar();
      out.push({ col, row: d.row, char: d.char, head: true });
    }
    return out;
  }

  private randomChar(): string {
    return GLYPHS[Math.floor(this.random() * GLYPHS.length) % GLYPHS.length];
  }
}
