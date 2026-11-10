import { FramePacer } from './backdrop/framePacer';
import {
  cometCount,
  litPanes,
  loopRect,
  mostCrowded,
  PANE_LIGHTS as L,
  perimeter,
  pointAt,
  tailAlpha,
  tailPoints,
  widestGapMidpoint,
} from './paneLightsModel';
import type { Settings } from './settings';
import { bindWindowVisibility } from './windowVisibility';

/** What the lights read of the workspace each frame. */
export interface PaneLightTargets {
  /** Window rects of the active tab's panes on screen. */
  rects: Map<string, DOMRect>;
  attention: ReadonlySet<string>;
}

interface Comet {
  dist: number;
  alpha: number;
  /** Fading out because the pane shrank; dropped once invisible. */
  leaving: boolean;
}

/**
 * Agent glow and border lights (docs/design/sessions.md section 4.23). The border lights draw on
 * a full-window canvas between the backdrop and the panes, so the comets run in the gutters
 * behind the panes' edges. The glow is CSS (`.agent-working` under `body.agent-glow`); this class
 * only switches it on and feeds it the timing from PANE_LIGHTS. Reduced motion turns both off.
 */
export class PaneLights {
  private readonly canvas = document.createElement('canvas');
  private readonly ctx: CanvasRenderingContext2D | null;
  private readonly pacer = new FramePacer();
  private readonly comets = new Map<string, Comet[]>();
  private readonly reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  private glow = false;
  private lights = false;
  private visible = true;
  private accent = '#ffffff';
  private speed = 60;
  private pxPerComet: number = L.pxPerDensityUnit;
  private frame = 0;
  private last = 0;

  constructor(private readonly targets: () => PaneLightTargets) {
    this.canvas.id = 'pane-lights';
    this.canvas.hidden = true;
    const backdrop = document.getElementById('backdrop');
    if (backdrop) backdrop.after(this.canvas);
    else document.body.prepend(this.canvas);
    this.ctx = this.canvas.getContext('2d');
    this.pacer.setMaxFps(L.maxFps);
    const root = document.documentElement.style;
    root.setProperty('--agent-glow-period', `${L.breathSeconds}s`);
    root.setProperty('--agent-glow-low', String(L.glowLow));
    root.setProperty('--agent-glow-high', String(L.glowHigh));
    window.addEventListener('resize', () => this.fitCanvas());
    this.reducedMotion.addEventListener('change', () => this.sync());
    bindWindowVisibility((visible) => {
      this.visible = visible;
      this.sync();
    });
  }

  apply(settings: Pick<Settings, 'agentGlow' | 'borderLights' | 'borderLightsSpeed' | 'borderLightsDensity' | 'accentColor'>): void {
    this.glow = settings.agentGlow;
    this.lights = settings.borderLights;
    this.speed = settings.borderLightsSpeed;
    this.pxPerComet = L.pxPerDensityUnit / settings.borderLightsDensity;
    this.accent = settings.accentColor;
    this.sync();
  }

  private sync(): void {
    const still = this.reducedMotion.matches;
    document.body.classList.toggle('agent-glow', this.glow && !still);
    const on = this.lights && !still;
    this.canvas.hidden = !on;
    if (on && this.visible) {
      if (!this.frame) {
        this.fitCanvas();
        this.pacer.reset();
        this.last = performance.now();
        this.frame = requestAnimationFrame((t) => this.tick(t));
      }
      return;
    }
    if (this.frame) cancelAnimationFrame(this.frame);
    this.frame = 0;
    if (!on) {
      this.comets.clear();
      this.ctx?.clearRect(0, 0, this.canvas.width, this.canvas.height);
    }
  }

  private fitCanvas(): void {
    const dpr = window.devicePixelRatio || 1;
    this.canvas.width = Math.round(window.innerWidth * dpr);
    this.canvas.height = Math.round(window.innerHeight * dpr);
  }

  private tick(now: number): void {
    this.frame = requestAnimationFrame((t) => this.tick(t));
    if (!this.pacer.shouldRender(now)) return;
    // Clamped so a stall (a long layout, a debugger pause) doesn't teleport the comets.
    const dt = Math.min(0.1, (now - this.last) / 1000);
    this.last = now;
    this.draw(dt);
  }

  private draw(dt: number): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const { rects, attention } = this.targets();
    const lit = litPanes(rects.keys(), attention);
    for (const id of this.comets.keys()) if (!rects.has(id)) this.comets.delete(id);

    const dpr = window.devicePixelRatio || 1;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, window.innerWidth, window.innerHeight);
    ctx.globalCompositeOperation = 'lighter';
    ctx.lineCap = 'round';
    ctx.lineWidth = L.lineWidthPx;

    const step = L.fadePerSec * dt;
    for (const [id, rect] of rects) {
      const loop = loopRect(rect, L.gutterOffsetPx);
      const p = perimeter(loop);
      let list = this.comets.get(id);
      if (!list) {
        list = [];
        this.comets.set(id, list);
      }
      this.fitCount(list, p);
      const on = lit.has(id);
      for (const comet of list) {
        const target = on && !comet.leaving ? 1 : 0;
        comet.alpha = target > comet.alpha ? Math.min(target, comet.alpha + step) : Math.max(target, comet.alpha - step);
        comet.dist += this.speed * dt;
        if (p > 0) comet.dist %= p;
        if (comet.alpha <= 0.01 || p === 0) continue;
        this.drawComet(ctx, loop, comet);
      }
      const kept = list.filter((c) => !(c.leaving && c.alpha <= 0));
      if (kept.length !== list.length) this.comets.set(id, kept);
    }
    ctx.globalCompositeOperation = 'source-over';
  }

  /**
   * Larger panes run more comets (`borderLightsDensity`), so a resize adds or retires them. A new
   * one fades in at the middle of the widest gap; a retired one is the most crowded, and fades out.
   */
  private fitCount(list: Comet[], p: number): void {
    const active = list.filter((c) => !c.leaving);
    const want = cometCount(p, this.pxPerComet, active.length, L.countHysteresis);
    while (active.length < want) {
      // The first starts at a random point, so neighboring panes never run in step.
      const dist = active.length ? widestGapMidpoint(active.map((c) => c.dist), p) : Math.random() * p;
      const comet = { dist, alpha: 0, leaving: false };
      list.push(comet);
      active.push(comet);
    }
    while (active.length > want) {
      const [gone] = active.splice(mostCrowded(active.map((c) => c.dist), p), 1);
      gone.leaving = true;
    }
  }

  private drawComet(ctx: CanvasRenderingContext2D, loop: ReturnType<typeof loopRect>, comet: Comet): void {
    const pts = tailPoints(loop, comet.dist, L.tailPx, L.tailStepPx);
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1];
      const b = pts[i];
      // Each segment takes the brightness of its end nearer the head, so the trail peaks there.
      ctx.strokeStyle = rgba(this.accent, tailAlpha(Math.min(a.off, b.off), L.tailPx, L.intensity) * comet.alpha);
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
    }
    const head = pointAt(loop, comet.dist);
    const g = ctx.createRadialGradient(head.x, head.y, 0, head.x, head.y, L.headRadiusPx);
    g.addColorStop(0, rgba('#ffffff', 0.7 * L.intensity * comet.alpha));
    g.addColorStop(0.25, rgba(this.accent, 0.6 * (0.35 + L.intensity) * comet.alpha));
    g.addColorStop(1, rgba(this.accent, 0));
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(head.x, head.y, L.headRadiusPx, 0, Math.PI * 2);
    ctx.fill();
  }
}

function rgba(hex: string, a: number): string {
  const n = parseInt(hex.slice(1, 7), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${Math.max(0, Math.min(1, a)).toFixed(3)})`;
}
