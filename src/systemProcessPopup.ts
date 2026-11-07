import { systemTopProcesses } from './systemApi';
import { TOP_PROCESS_LIMIT, processLines, type ProcessMetric } from './systemModel';

const SHOW_DELAY_MS = 300;
const REFRESH_MS = 2000;
const GAP_PX = 4;

const TITLES: Record<ProcessMetric, string> = { cpu: 'Top CPU', memory: 'Top memory' };

/**
 * The System section's hover popup for the CPU and Memory rows (docs/design/dashboard.md section
 * 4.6): the busiest programs by that metric, read from the core only while it is open. Never takes
 * pointer events, so it cannot hold itself open or cover what the pointer moves to.
 */
export class SystemProcessPopup {
  private readonly el: HTMLElement;
  private readonly title: HTMLElement;
  private readonly list: HTMLElement;
  private anchor: HTMLElement | null = null;
  private metric: ProcessMetric = 'cpu';
  private showTimer: ReturnType<typeof setTimeout> | undefined;
  private refreshTimer: ReturnType<typeof setInterval> | undefined;
  /** Bumped on every open and close, so a reply that lands after either is dropped. */
  private generation = 0;

  constructor() {
    this.el = document.createElement('div');
    this.el.className = 'system-popup';
    this.el.hidden = true;
    this.el.setAttribute('role', 'tooltip');
    this.title = document.createElement('div');
    this.title.className = 'system-popup-title';
    this.list = document.createElement('div');
    this.list.className = 'system-popup-list';
    this.el.append(this.title, this.list);
    document.body.append(this.el);
  }

  /** Opens on `row` after a short hover and closes when the pointer leaves it. */
  attach(row: HTMLElement, metric: ProcessMetric): void {
    row.addEventListener('mouseenter', () => {
      clearTimeout(this.showTimer);
      this.showTimer = setTimeout(() => this.open(row, metric), SHOW_DELAY_MS);
    });
    row.addEventListener('mouseleave', () => this.hide());
  }

  hide(): void {
    clearTimeout(this.showTimer);
    clearInterval(this.refreshTimer);
    this.showTimer = undefined;
    this.refreshTimer = undefined;
    this.generation += 1;
    this.anchor = null;
    this.el.hidden = true;
  }

  private open(row: HTMLElement, metric: ProcessMetric): void {
    this.hide();
    this.anchor = row;
    this.metric = metric;
    this.title.textContent = TITLES[metric];
    this.setMessage('Reading processes...');
    this.el.hidden = false;
    this.place();
    void this.refresh();
    this.refreshTimer = setInterval(() => void this.refresh(), REFRESH_MS);
  }

  private async refresh(): Promise<void> {
    const gen = this.generation;
    try {
      const top = await systemTopProcesses(TOP_PROCESS_LIMIT);
      if (gen !== this.generation) return;
      const lines = processLines(top, this.metric);
      if (lines.length === 0) {
        this.setMessage('Nothing busy');
      } else {
        this.list.replaceChildren(
          ...lines.map((l) => {
            const name = document.createElement('span');
            name.className = 'system-popup-name';
            name.textContent = l.name;
            name.title = l.name;
            const count = document.createElement('span');
            count.className = 'system-popup-count';
            count.textContent = l.count;
            const value = document.createElement('span');
            value.className = 'system-popup-value';
            value.textContent = l.value;
            return [name, count, value];
          }).flat(),
        );
      }
    } catch {
      if (gen !== this.generation) return;
      this.setMessage('Processes unavailable');
    }
    this.place();
  }

  private setMessage(text: string): void {
    const note = document.createElement('span');
    note.className = 'system-popup-note';
    note.textContent = text;
    this.list.replaceChildren(note);
  }

  /** Below the row, or above it when there is no room below, kept inside the window. */
  private place(): void {
    if (!this.anchor || this.el.hidden) return;
    const r = this.anchor.getBoundingClientRect();
    const width = Math.max(220, r.width);
    this.el.style.width = `${width}px`;
    const h = this.el.offsetHeight;
    const below = r.bottom + GAP_PX;
    const top = below + h <= window.innerHeight ? below : Math.max(0, r.top - GAP_PX - h);
    const left = Math.min(Math.max(0, r.left), Math.max(0, window.innerWidth - width));
    this.el.style.top = `${top}px`;
    this.el.style.left = `${left}px`;
  }
}
