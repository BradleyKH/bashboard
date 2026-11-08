import './dashboardWave.css';
import { DEFAULT_ACCENT } from './accent';
import { systemSample } from './systemApi';
import { formatBytes, formatNetwork, formatPercent, type SystemSample } from './systemModel';
import { drawWave } from './waveDraw';
import {
  WAVE_ECHO_LAG,
  WAVE_FPS,
  figureLines,
  restingWave,
  settleWave,
  stepWave,
  waveExtent,
  waveFit,
  waveFigures,
  waveReading,
  type WaveReading,
} from './waveModel';

const POLL_MS = 2000;
const FRAME_MS = 1000 / WAVE_FPS;

/**
 * The dashboard's Wave element: a looping line turning in 3D, whose weave follows CPU load, whose
 * spin follows network traffic, and whose detune sweep follows memory use (docs/design/dashboard.md
 * section 4.6). It samples and draws only while
 * the panel decides it runs, and holds a still figure when the OS asks for reduced motion.
 */
export class DashboardWave {
  readonly el: HTMLElement;
  private readonly canvas: HTMLCanvasElement;
  private readonly observer: ResizeObserver;
  private readonly reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  private running = false;
  private poll: ReturnType<typeof setInterval> | undefined;
  private frame: number | undefined;
  private lastFrame = 0;
  private readonly motion = restingWave();
  private target: WaveReading = { cpu: 0, net: 0, mem: 0 };
  private fit: number | undefined;
  private color = DEFAULT_ACCENT;

  constructor() {
    this.el = document.createElement('div');
    this.el.className = 'dashboard-wave';
    this.el.setAttribute('role', 'img');
    this.el.setAttribute('aria-label', 'Wave');
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'wave-canvas';
    this.canvas.setAttribute('aria-hidden', 'true');
    this.el.append(this.canvas);
    this.observer = new ResizeObserver(() => this.draw());
    this.observer.observe(this.canvas);
    this.reducedMotion.addEventListener('change', () => this.syncFrames());
  }

  /** Runs only while the element is enabled, the panel is on screen, and the window is shown. */
  setRunning(running: boolean): void {
    if (running === this.running) return;
    this.running = running;
    if (running) {
      void this.sample();
      this.poll = setInterval(() => void this.sample(), POLL_MS);
    } else if (this.poll !== undefined) {
      clearInterval(this.poll);
      this.poll = undefined;
    }
    this.syncFrames();
  }

  /** Reduced motion holds a still figure that redraws only on each new reading. */
  private moving(): boolean {
    return this.running && !this.reducedMotion.matches;
  }

  private syncFrames(): void {
    if (this.moving()) {
      if (this.frame === undefined) {
        this.lastFrame = performance.now();
        this.frame = requestAnimationFrame((t) => this.tick(t));
      }
    } else if (this.frame !== undefined) {
      cancelAnimationFrame(this.frame);
      this.frame = undefined;
    }
  }

  private tick(now: number): void {
    this.frame = requestAnimationFrame((t) => this.tick(t));
    const elapsed = now - this.lastFrame;
    if (elapsed < FRAME_MS) return;
    // A long gap (the tab was throttled) would otherwise jump the figure in one step.
    const dt = Math.min(elapsed, 250) / 1000;
    this.lastFrame = now;
    stepWave(this.motion, this.target, dt);
    this.draw(dt);
  }

  private async sample(): Promise<void> {
    let s: SystemSample;
    try {
      s = await systemSample(false);
    } catch {
      // Without the core (a browser-only run) the figure idles at rest.
      return;
    }
    if (!this.running) return;
    this.target = waveReading(s);
    this.color = getComputedStyle(this.el).getPropertyValue('--accent').trim() || DEFAULT_ACCENT;
    const memory = `${formatBytes(s.memoryUsedBytes)} of ${formatBytes(s.memoryTotalBytes)}`;
    const label = `CPU ${formatPercent(s.cpuPercent)}, memory ${memory}, network ${formatNetwork(s.netRxPerSec, s.netTxPerSec)}`;
    this.el.title = `Lissajous! ${label}`;
    this.el.setAttribute('aria-label', `Wave: ${label}`);
    if (!this.moving()) {
      settleWave(this.motion, this.target);
      this.draw();
    }
  }

  /** `dt` is the time since the last frame, which lets the fit regrow; other redraws pass none. */
  private draw(dt = 0): void {
    const dpr = window.devicePixelRatio || 1;
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    if (w === 0 || h === 0) return;
    const bw = Math.round(w * dpr);
    const bh = Math.round(h * dpr);
    if (this.canvas.width !== bw || this.canvas.height !== bh) {
      this.canvas.width = bw;
      this.canvas.height = bh;
    }
    const ctx = this.canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    // A faint copy a little earlier in the spin gives the figure some depth.
    const figures = waveFigures(this.motion, 1, WAVE_ECHO_LAG);
    this.fit = waveFit(this.fit, waveExtent(figureLines(figures)), dt);
    drawWave(ctx, { w, h, scale: this.fit, inset: 2 }, figures, {
      lineWidth: 1.9,
      echoWidth: 1,
      echoAlpha: 0.14,
      color: this.color,
    });
  }
}
