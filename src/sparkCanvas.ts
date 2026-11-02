import { DEFAULT_ACCENT } from './accent';
import { SPARKLINE_CAPACITY } from './systemModel';

/**
 * A sparkline canvas that fills its CSS box. The drawing buffer tracks the box's size times
 * `devicePixelRatio`, so the line stays sharp at any width and redraws itself on resize.
 */
export class SparkCanvas {
  readonly el: HTMLCanvasElement;
  private values: readonly number[] = [];
  private max = 1;
  private readonly observer: ResizeObserver;

  constructor(className: string) {
    this.el = document.createElement('canvas');
    this.el.className = className;
    this.observer = new ResizeObserver(() => this.draw(this.values, this.max));
    this.observer.observe(this.el);
  }

  /** Draws `values` (oldest first) against a 0..`max` scale, newest at the right edge. */
  draw(values: readonly number[], max: number): void {
    this.values = values;
    this.max = max;
    const dpr = window.devicePixelRatio || 1;
    const w = this.el.clientWidth;
    const h = this.el.clientHeight;
    // Zero while the section is collapsed; the observer redraws once it has a size.
    if (w === 0 || h === 0) return;
    const bw = Math.round(w * dpr);
    const bh = Math.round(h * dpr);
    if (this.el.width !== bw || this.el.height !== bh) {
      this.el.width = bw;
      this.el.height = bh;
    }
    const ctx = this.el.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    if (values.length < 2 || max <= 0) return;
    ctx.strokeStyle = getComputedStyle(this.el).getPropertyValue('--system-accent').trim() || DEFAULT_ACCENT;
    ctx.lineWidth = 1.5;
    ctx.lineJoin = 'round';
    ctx.beginPath();
    const step = w / (SPARKLINE_CAPACITY - 1);
    const x0 = w - (values.length - 1) * step;
    values.forEach((v, i) => {
      const x = x0 + i * step;
      const y = h - 1 - (Math.min(max, Math.max(0, v)) / max) * (h - 2);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.stroke();
  }
}
