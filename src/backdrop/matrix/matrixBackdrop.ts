// Matrix backdrop style: Canvas 2D digital rain driven by MatrixRain (docs/design.md section 6.2).
import type { StyleBackdrop } from '../backdropHandle';
import { GLYPHS, MATRIX_FONT_FAMILY, MatrixRain, type Glyph } from './matrixModel';

export interface MatrixOptions {
  color: string;
  /** Multiplies BASE_CELL_PX. */
  zoom: number;
  /** Model steps per second. */
  speed: number;
  /** Scales how often a column starts a new drop. */
  density: number;
}

export interface MatrixBackdrop extends StyleBackdrop {
  setOptions(options: MatrixOptions): void;
}

const BASE_CELL_PX = 20;
/** Steps run in one frame at most, so a stall never snowballs into a burst. */
const MAX_STEPS_PER_FRAME = 4;
const FADE_ALPHA = 0.08;
// An alpha fade alone stalls once 8-bit rounding stops lowering a channel (any value under
// about 0.5 / FADE_ALPHA), leaving a permanent dim residue. A color-burn fill with a near-white
// source subtracts a few levels and clamps at zero, so every few steps the residue goes to black.
const BURN_EVERY = 4;
const BURN_SOURCE = 'rgb(250, 250, 250)';
const HEAD_WHITENESS = 0.9;

export function mountMatrix(canvas: HTMLCanvasElement, options: MatrixOptions): MatrixBackdrop {
  const matrix = new MatrixLoop(canvas, options);
  matrix.setVisible(true);
  return matrix;
}

class MatrixLoop implements MatrixBackdrop {
  private ctx: CanvasRenderingContext2D | null;
  private readonly rain = new MatrixRain();
  private readonly reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
  private readonly handleResize = (): void => this.resize();
  private readonly handleMotionChange = (): void => this.sync();

  private options: MatrixOptions;
  private headColor = '#ffffff';
  private cellPx = BASE_CELL_PX;
  private visible = false;
  private animated = true;
  private disposed = false;
  private fontReady = false;
  private frameId: number | null = null;
  private lastTime: number | null = null;
  private stepDebt = 0;
  /** Steps drawn since the canvas was last cleared; a still frame tops this up to fill the screen. */
  private stepsSinceClear = 0;
  private totalSteps = 0;

  constructor(private readonly canvas: HTMLCanvasElement, options: MatrixOptions) {
    this.ctx = canvas.getContext('2d', { alpha: false });
    this.options = options;
    this.rain.setDensity(options.density);
    // The film's glyphs are mirrored. Flipping the canvas in CSS costs nothing (the compositor
    // does it), and since drops are column-symmetric only the glyph shapes change. It is set on
    // this canvas alone; the host gives each style its own canvas, so lights never inherit it.
    canvas.style.transform = 'scaleX(-1)';
    this.applyColor();
    this.resize();
    window.addEventListener('resize', this.handleResize);
    this.reducedMotion.addEventListener('change', this.handleMotionChange);
    void this.loadFont();
  }

  setVisible(visible: boolean): void {
    if (this.disposed || visible === this.visible) return;
    this.visible = visible;
    this.sync();
  }

  setAnimated(animated: boolean): void {
    if (this.disposed || animated === this.animated) return;
    this.animated = animated;
    this.sync();
  }

  setOptions(options: MatrixOptions): void {
    if (this.disposed) return;
    const prev = this.options;
    this.options = options;
    if (options.color !== prev.color) this.applyColor();
    if (options.density !== prev.density) this.rain.setDensity(options.density);
    if (options.zoom !== prev.zoom) {
      this.resize();
    } else if ((options.color !== prev.color || options.density !== prev.density) && !this.running()) {
      // A still frame has no loop to fade the old color out or thin the rain, so rebuild it.
      this.clear();
      this.sync();
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.visible = false;
    this.sync();
    this.disposed = true;
    window.removeEventListener('resize', this.handleResize);
    this.reducedMotion.removeEventListener('change', this.handleMotionChange);
    this.ctx = null;
  }

  private running(): boolean {
    return this.frameId !== null;
  }

  private async loadFont(): Promise<void> {
    // The system font may load lazily; drawing before it is ready would cache fallback glyphs
    // for the first frames. A failed load still draws, with whatever font the browser picks.
    try {
      await document.fonts?.load(`${Math.round(this.cellPx)}px ${MATRIX_FONT_FAMILY}`, GLYPHS);
    } catch {
      // Draw anyway.
    }
    if (this.disposed) return;
    this.fontReady = true;
    this.sync();
  }

  private sync(): void {
    if (this.disposed) return;
    const canDraw = this.visible && this.fontReady;
    const run = canDraw && this.animated && !this.reducedMotion.matches;
    if (run && this.frameId === null) {
      this.lastTime = null;
      this.stepDebt = 0;
      this.frameId = requestAnimationFrame(this.frame);
    } else if (!run && this.frameId !== null) {
      cancelAnimationFrame(this.frameId);
      this.frameId = null;
    }
    if (canDraw && !run) this.fillStill();
  }

  private readonly frame = (timestamp: number): void => {
    this.frameId = requestAnimationFrame(this.frame);
    const elapsed = this.lastTime === null ? 0 : Math.max(0, timestamp - this.lastTime) / 1000;
    this.lastTime = timestamp;
    this.stepDebt += elapsed * this.options.speed;
    let steps = Math.floor(this.stepDebt);
    if (steps > MAX_STEPS_PER_FRAME) {
      steps = MAX_STEPS_PER_FRAME;
      this.stepDebt = 0;
    } else {
      this.stepDebt -= steps;
    }
    for (let i = 0; i < steps; i++) this.drawStep();
  };

  /** Steps enough rain onto a cleared canvas that a frozen frame looks like a running one. */
  private fillStill(): void {
    // Every column starts idle, so give each a couple of mean gaps to start a drop, then a
    // screen for that drop to fall.
    const target = Math.min(Math.ceil(this.rain.rows + this.rain.meanGap * 2), 400);
    while (this.stepsSinceClear < target) this.drawStep();
  }

  private drawStep(): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const { width, height } = this.canvas;
    ctx.globalAlpha = FADE_ALPHA;
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, width, height);
    ctx.globalAlpha = 1;
    if (++this.totalSteps % BURN_EVERY === 0) {
      ctx.globalCompositeOperation = 'color-burn';
      ctx.fillStyle = BURN_SOURCE;
      ctx.fillRect(0, 0, width, height);
      ctx.globalCompositeOperation = 'source-over';
    }

    const glyphs = this.rain.step();
    // Trail cells first: each covers last step's white head, which is blacked out before the
    // redraw so its anti-aliased edges do not linger as a white fringe.
    for (const g of glyphs) {
      if (g.head) continue;
      ctx.fillStyle = '#000';
      ctx.fillRect(g.col * this.cellPx, g.row * this.cellPx, this.cellPx, this.cellPx);
      this.drawGlyph(ctx, g, this.options.color);
    }
    for (const g of glyphs) if (g.head) this.drawGlyph(ctx, g, this.headColor);
    this.stepsSinceClear++;
  }

  private drawGlyph(ctx: CanvasRenderingContext2D, g: Glyph, color: string): void {
    ctx.fillStyle = color;
    ctx.fillText(g.char, (g.col + 0.5) * this.cellPx, (g.row + 0.5) * this.cellPx);
  }

  private resize(): void {
    const dpr = window.devicePixelRatio || 1;
    this.canvas.width = Math.max(1, Math.round(window.innerWidth * dpr));
    this.canvas.height = Math.max(1, Math.round(window.innerHeight * dpr));
    this.cellPx = BASE_CELL_PX * this.options.zoom * dpr;
    this.rain.resize(this.canvas.width, this.canvas.height, this.cellPx);
    this.clear();
    // Resizing resets the context, so the font and alignment go with it.
    if (this.ctx) {
      this.ctx.font = `${Math.round(this.cellPx * 0.9)}px ${MATRIX_FONT_FAMILY}`;
      this.ctx.textAlign = 'center';
      this.ctx.textBaseline = 'middle';
    }
    if (!this.running()) this.sync();
  }

  private clear(): void {
    if (this.ctx) {
      this.ctx.fillStyle = '#000';
      this.ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    }
    this.stepsSinceClear = 0;
  }

  private applyColor(): void {
    const m = /^#([0-9a-f]{6})$/i.exec(normalizeColor(this.options.color));
    if (!m) {
      this.headColor = '#ffffff';
      return;
    }
    const n = parseInt(m[1], 16);
    const mix = (c: number): number => Math.round(c + (255 - c) * HEAD_WHITENESS);
    this.headColor = `rgb(${mix(n >> 16)}, ${mix((n >> 8) & 255)}, ${mix(n & 255)})`;
  }
}

/** Expands #rgb to #rrggbb; other forms pass through. */
function normalizeColor(color: string): string {
  const short = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/i.exec(color.trim());
  return short ? `#${short[1]}${short[1]}${short[2]}${short[2]}${short[3]}${short[3]}` : color.trim();
}
