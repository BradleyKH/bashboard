// Lissajous backdrop style: the dashboard's Wave drawn across the whole window with Canvas 2D
// (docs/design/backdrop.md section 6.7).
import type { StyleBackdrop } from '../backdropHandle';
import { FramePacer } from '../framePacer';
import { systemSample } from '../../systemApi';
import { drawWave } from '../../waveDraw';
import {
  figureLines,
  restingWave,
  settleWave,
  stepWave,
  waveExtent,
  waveFigures,
  waveFit,
  waveReading,
  type WaveReading,
} from '../../waveModel';
import { spectrumColor } from './lissajousColor';

export interface LissajousOptions {
  /** A #rrggbb, or 'spectrum' (see `lissajousLineColor`). */
  color: string;
  /** Share of the window the figure's widest point fills. */
  size: number;
  /** Scales the spin, tilt, and detune sweep. */
  speed: number;
  /** The main line's width in CSS pixels on its nearest side. */
  lineWidth: number;
  /** Faint copies trailing the line in its spin. */
  echoes: number;
  /** `backdrop.maxFps`; 0 is uncapped. */
  maxFps: number;
}

export interface LissajousBackdrop extends StyleBackdrop {
  setOptions(options: LissajousOptions): void;
}

const POLL_MS = 2000;
/** Enough points that the densest figure stays smooth across a large window. */
const POINTS = 1200;
/** Radians of spin between one echo and the next. */
const ECHO_LAG = 0.12;
const ECHO_ALPHA = 0.22;
/** Degrees per second the spectrum turns along the line at speed 1: a full turn every 30 s. */
const SPECTRUM_TURN = 12;

export function mountLissajous(canvas: HTMLCanvasElement, options: LissajousOptions): LissajousBackdrop {
  const wave = new LissajousLoop(canvas, options);
  wave.setVisible(true);
  return wave;
}

class LissajousLoop implements LissajousBackdrop {
  private ctx: CanvasRenderingContext2D | null;
  private readonly pacer = new FramePacer();
  private readonly reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
  private readonly handleResize = (): void => this.resize();
  private readonly handleMotionChange = (): void => this.sync();

  private options: LissajousOptions;
  private readonly motion = restingWave();
  private target: WaveReading = { cpu: 0, net: 0, mem: 0 };
  private sampled = false;
  private hueShift = 0;
  private fit: number | undefined;
  private visible = false;
  private animated = true;
  private disposed = false;
  private poll: ReturnType<typeof setInterval> | undefined;
  private frameId: number | null = null;
  private lastTime: number | null = null;

  constructor(private readonly canvas: HTMLCanvasElement, options: LissajousOptions) {
    this.ctx = canvas.getContext('2d');
    this.options = options;
    this.pacer.setMaxFps(options.maxFps);
    this.resize();
    window.addEventListener('resize', this.handleResize);
    this.reducedMotion.addEventListener('change', this.handleMotionChange);
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

  setOptions(options: LissajousOptions): void {
    if (this.disposed) return;
    if (options.maxFps !== this.options.maxFps) this.pacer.setMaxFps(options.maxFps);
    this.options = options;
    // A new size or line width changes the fit at once rather than regrowing into it.
    this.fit = undefined;
    if (!this.running()) this.draw();
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

  /**
   * Polls while shown and animated, and moves while also not asked for reduced motion, which
   * holds a still figure redrawn on each reading. Frozen, it samples once so the still shows the
   * current load.
   */
  private sync(): void {
    if (this.disposed) return;
    const polling = this.visible && this.animated;
    if (polling && this.poll === undefined) {
      void this.sample();
      this.poll = setInterval(() => void this.sample(), POLL_MS);
    } else if (!polling && this.poll !== undefined) {
      clearInterval(this.poll);
      this.poll = undefined;
    }
    const run = polling && !this.reducedMotion.matches;
    if (run && this.frameId === null) {
      this.lastTime = null;
      this.pacer.reset();
      this.frameId = requestAnimationFrame(this.frame);
    } else if (!run && this.frameId !== null) {
      cancelAnimationFrame(this.frameId);
      this.frameId = null;
    }
    if (this.visible && !run) {
      if (!polling && !this.sampled) void this.sample();
      this.draw();
    }
  }

  private async sample(): Promise<void> {
    let reading: WaveReading;
    try {
      reading = waveReading(await systemSample(false));
    } catch {
      // Without the core (a browser-only run) the figure idles at rest.
      return;
    }
    if (this.disposed) return;
    this.target = reading;
    this.sampled = true;
    if (!this.running()) {
      settleWave(this.motion, reading);
      if (this.visible) this.draw();
    }
  }

  private readonly frame = (timestamp: number): void => {
    this.frameId = requestAnimationFrame(this.frame);
    if (!this.pacer.shouldRender(timestamp)) return;
    // A long gap (the window was throttled) would otherwise jump the figure in one step.
    const dt = this.lastTime === null ? 0 : Math.min(Math.max(0, timestamp - this.lastTime), 250) / 1000;
    this.lastTime = timestamp;
    stepWave(this.motion, this.target, dt, this.options.speed);
    this.hueShift = (this.hueShift + SPECTRUM_TURN * this.options.speed * dt) % 360;
    this.draw(dt);
  };

  /** `dt` is the time since the last frame, which lets the fit regrow; other redraws pass none. */
  private draw(dt = 0): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const dpr = window.devicePixelRatio || 1;
    const w = this.canvas.width / dpr;
    const h = this.canvas.height / dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const { color, size, lineWidth, echoes } = this.options;
    const figures = waveFigures(this.motion, echoes, ECHO_LAG, POINTS);
    this.fit = waveFit(this.fit, waveExtent(figureLines(figures)), dt);
    const shift = this.hueShift;
    drawWave(ctx, { w, h, scale: this.fit * size, inset: lineWidth }, figures, {
      lineWidth,
      echoWidth: Math.max(1, lineWidth / 2),
      echoAlpha: ECHO_ALPHA,
      color: color === 'spectrum' ? (along) => spectrumColor(along, shift) : color,
    });
  }

  private resize(): void {
    const dpr = window.devicePixelRatio || 1;
    this.canvas.width = Math.max(1, Math.round(window.innerWidth * dpr));
    this.canvas.height = Math.max(1, Math.round(window.innerHeight * dpr));
    // Resizing clears the canvas, and a still figure has no loop to redraw it.
    if (this.visible && !this.running()) this.draw();
  }
}
