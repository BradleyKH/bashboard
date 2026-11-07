import './dashboardWave.css';
import { DEFAULT_ACCENT } from './accent';
import { systemSample } from './systemApi';
import { formatBytes, formatNetwork, formatPercent, type SystemSample } from './systemModel';
import {
  WAVE_ECHO_LAG,
  WAVE_FPS,
  WAVE_TILT_SPEED,
  cpuLevel,
  detuneAt,
  detuneSpeed,
  ease,
  memLevel,
  netLevel,
  spinSpeed,
  waveExtent,
  waveFit,
  waveLayers,
  wavePoints,
  type WavePoint,
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
  private cpu = 0;
  private net = 0;
  private targetCpu = 0;
  private targetNet = 0;
  private mem = 0;
  private targetMem = 0;
  private spin = 0;
  private tilt = 0.4;
  private detunePhase = 0;
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
    this.cpu = ease(this.cpu, this.targetCpu, dt);
    this.net = ease(this.net, this.targetNet, dt);
    this.mem = ease(this.mem, this.targetMem, dt);
    const turn = Math.PI * 2;
    this.spin = (this.spin + spinSpeed(this.net) * dt) % turn;
    this.tilt = (this.tilt + WAVE_TILT_SPEED * dt) % turn;
    this.detunePhase = (this.detunePhase + detuneSpeed(this.mem) * dt) % turn;
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
    this.targetCpu = cpuLevel(s.cpuPercent);
    this.targetNet = netLevel(s.netRxPerSec, s.netTxPerSec);
    this.targetMem = memLevel(s.memoryUsedBytes, s.memoryTotalBytes);
    this.color = getComputedStyle(this.el).getPropertyValue('--accent').trim() || DEFAULT_ACCENT;
    const memory = `${formatBytes(s.memoryUsedBytes)} of ${formatBytes(s.memoryTotalBytes)}`;
    const label = `CPU ${formatPercent(s.cpuPercent)}, memory ${memory}, network ${formatNetwork(s.netRxPerSec, s.netTxPerSec)}`;
    this.el.title = `Lissajous! ${label}`;
    this.el.setAttribute('aria-label', `Wave: ${label}`);
    if (!this.moving()) {
      this.cpu = this.targetCpu;
      this.net = this.targetNet;
      this.mem = this.targetMem;
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
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.strokeStyle = this.color;

    const detune = detuneAt(this.detunePhase);
    const figures = waveLayers(this.cpu).map(({ ratio, weight }) => ({
      weight,
      main: wavePoints(ratio, { detune, spin: this.spin, tilt: this.tilt }),
      // A faint copy a little earlier in the spin gives the figure some depth.
      echo: wavePoints(ratio, { detune, spin: this.spin - WAVE_ECHO_LAG, tilt: this.tilt }),
    }));
    this.fit = waveFit(this.fit, waveExtent(figures.flatMap((f) => [f.main, f.echo])), dt);
    const box = { w, h, scale: this.fit };
    for (const f of figures) {
      this.strokeEcho(ctx, box, f.echo, 0.14 * f.weight);
      this.strokeDepth(ctx, box, f.main, f.weight);
    }
    ctx.globalAlpha = 1;
  }

  private strokeEcho(ctx: CanvasRenderingContext2D, box: Box, pts: WavePoint[], alpha: number): void {
    ctx.globalAlpha = alpha;
    ctx.lineWidth = 1;
    ctx.beginPath();
    pts.forEach((pt, i) => {
      const [px, py] = place(box, pt);
      if (i === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    });
    ctx.stroke();
  }

  /** The main line, stroked a segment at a time so its near side draws brighter and thicker. */
  private strokeDepth(ctx: CanvasRenderingContext2D, box: Box, pts: WavePoint[], weight: number): void {
    let [x0, y0] = place(box, pts[0]);
    for (let i = 1; i < pts.length; i++) {
      const [x1, y1] = place(box, pts[i]);
      const near = (1 - (pts[i - 1][2] + pts[i][2]) / 2) / 2;
      ctx.globalAlpha = weight * (0.15 + 0.8 * near);
      ctx.lineWidth = 0.6 + 1.3 * near;
      ctx.beginPath();
      ctx.moveTo(x0, y0);
      ctx.lineTo(x1, y1);
      ctx.stroke();
      x0 = x1;
      y0 = y1;
    }
  }
}

/** The canvas in CSS pixels and the fit scale the figure draws at. */
interface Box {
  w: number;
  h: number;
  scale: number;
}

/** A figure point in canvas pixels, inset so the line's width stays inside the edge. */
function place(box: Box, [x, y]: WavePoint): [number, number] {
  const rx = box.w / 2 - 2;
  const ry = box.h / 2 - 2;
  return [box.w / 2 + x * box.scale * rx, box.h / 2 + y * box.scale * ry];
}
