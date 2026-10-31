import './dashboardClock.css';
import { clockBits, clockLabel, clockText } from './clockModel';

const COLUMNS = ['hours', 'minutes', 'seconds'] as const;

export class DashboardClock {
  readonly el: HTMLElement;
  private readonly time: HTMLSpanElement;
  private readonly dots: HTMLSpanElement[][] = [];
  private timer: ReturnType<typeof setTimeout> | undefined;
  private running = false;
  private lastText = '';

  constructor() {
    this.el = document.createElement('div');
    this.el.className = 'dashboard-clock';
    this.el.dataset.element = 'clock';
    this.el.setAttribute('role', 'img');

    const line = document.createElement('div');
    line.className = 'clock-line';
    line.setAttribute('aria-hidden', 'true');

    const grid = document.createElement('div');
    grid.className = 'clock-grid';
    grid.setAttribute('aria-hidden', 'true');
    for (const _ of COLUMNS) {
      const column: HTMLSpanElement[] = [];
      for (let row = 0; row < 6; row++) {
        const dot = document.createElement('span');
        dot.className = 'clock-dot';
        grid.append(dot);
        column.push(dot);
      }
      this.dots.push(column);
    }

    this.time = document.createElement('span');
    this.time.className = 'clock-time';
    this.time.setAttribute('aria-hidden', 'true');

    line.append(grid, this.time);
    this.el.append(line);
    this.render();
  }

  /**
   * Runs only while the clock is enabled, the panel is on screen, and the window is shown; the
   * panel decides. Turning it on renders at once so the clock catches up on show.
   */
  setRunning(running: boolean): void {
    if (running === this.running) return;
    this.running = running;
    if (running) {
      this.render();
      this.schedule();
    } else if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }

  private schedule(): void {
    this.timer = setTimeout(() => {
      this.render();
      this.schedule();
    }, 1000 - (Date.now() % 1000));
  }

  private render(): void {
    const now = new Date();
    const bits = clockBits(now);
    COLUMNS.forEach((name, c) => {
      bits[name].forEach((lit, r) => this.dots[c][r].classList.toggle('lit', lit));
    });
    const text = clockText(now);
    if (text !== this.lastText) {
      this.lastText = text;
      this.time.textContent = text;
      this.el.setAttribute('aria-label', clockLabel(now));
    }
  }
}
