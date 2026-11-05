import './dashboardWave.css';
import { DEFAULT_ACCENT } from './accent';
import { systemSample } from './systemApi';
import { formatNetwork, formatPercent, type SystemSample } from './systemModel';
import { WAVE_FPS, cpuLevel, ease, netLevel, phaseSpeed, wavePoints } from './waveModel';

const POLL_MS = 2000;
const FRAME_MS = 1000 / WAVE_FPS;

/**
 * The dashboard's Wave element: a looping line whose weave follows CPU load and whose drift
 * follows network traffic (docs/design.md section 4.6). It samples and draws only while the
 * panel decides it runs, and holds a still figure when motion is off.
 */
export class DashboardWave {
  readonly el: HTMLElement;
  private readonly canvas: HTMLCanvasElement;
  private readonly observer: ResizeObserver;
  private readonly reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  private running = false;
  private animate = true;
  private poll: ReturnType<typeof setInterval> | undefined;
  private frame: number | undefined;
  private lastFrame = 0;
  private cpu = 0;
  private net = 0;
  private targetCpu = 0;
  private targetNet = 0;
  private phase = 0;
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

  /** `backdrop.animate`: false holds a still figure that redraws only on each new reading. */
  setAnimate(animate: boolean): void {
    if (animate === this.animate) return;
    this.animate = animate;
    this.syncFrames();
  }

  private moving(): boolean {
    return this.running && this.animate && !this.reducedMotion.matches;
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
    this.cpu = ease(this.cpu, this.targetCpu, dt);
    this.net = ease(this.net, this.targetNet, dt);
    this.phase = (this.phase + phaseSpeed(this.net) * dt) % (Math.PI * 2);
    this.draw();
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
    this.targetCpu = cpuLevel(s.cpuPercent);
    this.targetNet = netLevel(s.netRxPerSec, s.netTxPerSec);
    this.color = getComputedStyle(this.el).getPropertyValue('--accent').trim() || DEFAULT_ACCENT;
    const label = `CPU ${formatPercent(s.cpuPercent)}, network ${formatNetwork(s.netRxPerSec, s.netTxPerSec)}`;
    this.el.title = `Lissajous! ${label}`;
    this.el.setAttribute('aria-label', `Wave: ${label}`);
    if (!this.moving()) {
      this.cpu = this.targetCpu;
      this.net = this.targetNet;
      this.draw();
    }
  }

  private draw(): void {
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
    ctx.lineJoin = 'round';
    ctx.strokeStyle = this.color;
    // A faint echo a little behind the main line gives the figure some depth.
    this.stroke(ctx, w, h, this.phase - 0.35, 0.22, 1);
    this.stroke(ctx, w, h, this.phase, 0.5 + 0.4 * this.net, 1.4);
  }

  private stroke(ctx: CanvasRenderingContext2D, w: number, h: number, phase: number, alpha: number, width: number): void {
    const rx = w / 2 - 3;
    const ry = h / 2 - 3;
    ctx.globalAlpha = alpha;
    ctx.lineWidth = width;
    ctx.beginPath();
    wavePoints(this.cpu, phase).forEach(([x, y], i) => {
      const px = w / 2 + x * rx;
      const py = h / 2 + y * ry;
      if (i === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    });
    ctx.stroke();
    ctx.globalAlpha = 1;
  }
}
