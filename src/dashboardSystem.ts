import './dashboardSystem.css';
import { PollTimer, type PollGate } from './pollTimer';
import { systemSample } from './systemApi';
import {
  Sparkline,
  formatDiskFree,
  formatMemory,
  formatNetwork,
  formatPercent,
  loadBand,
  type DiskRow,
  type SystemSample,
} from './systemModel';

const POLL_MS = 2000;
const DISK_MS = 60_000;
const SPARK_W = 120;
const SPARK_H = 22;

/** The dashboard's System section: CPU, memory, network, and disk rows (docs/design.md section 4.6). */
export class DashboardSystem {
  readonly el: HTMLElement;
  readonly head: HTMLElement;
  private readonly list: HTMLElement;
  private readonly cpuValue: HTMLElement;
  private readonly canvas: HTMLCanvasElement;
  private readonly memValue: HTMLElement;
  private readonly memBar: HTMLElement;
  private readonly netValue: HTMLElement;
  private readonly diskBox: HTMLElement;
  private readonly spark = new Sparkline();
  private readonly timer = new PollTimer(POLL_MS, () => void this.poll());
  private disks: DiskRow[] = [];
  private lastDisks: number | undefined;

  constructor() {
    this.el = document.createElement('section');
    this.el.className = 'dashboard-section system-section';

    this.head = document.createElement('div');
    this.head.className = 'dashboard-section-head';
    const h = document.createElement('h2');
    h.textContent = 'System';
    this.head.append(h);

    this.list = document.createElement('div');
    this.list.className = 'dashboard-list';

    const cpu = this.row('CPU');
    this.cpuValue = cpu.value;
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'system-spark';
    this.canvas.width = SPARK_W;
    this.canvas.height = SPARK_H;
    cpu.row.append(this.canvas);

    const mem = this.row('Memory');
    this.memValue = mem.value;
    this.memBar = this.bar(mem.row);

    const net = this.row('Network');
    this.netValue = net.value;

    this.diskBox = document.createElement('div');
    this.diskBox.className = 'system-disks';

    this.list.append(cpu.row, mem.row, net.row, this.diskBox);
    this.el.append(this.head, this.list);
    this.render(null);
  }

  setGate(partial: Partial<PollGate>): void {
    this.timer.setGate(partial);
  }

  private row(label: string): { row: HTMLElement; value: HTMLElement } {
    const row = document.createElement('div');
    row.className = 'system-row';
    const l = document.createElement('span');
    l.className = 'system-label';
    l.textContent = label;
    const value = document.createElement('span');
    value.className = 'system-value';
    row.append(l, value);
    return { row, value };
  }

  private bar(parent: HTMLElement): HTMLElement {
    const track = document.createElement('div');
    track.className = 'system-bar';
    const fill = document.createElement('div');
    fill.className = 'system-bar-fill';
    track.append(fill);
    parent.append(track);
    return fill;
  }

  private async poll(): Promise<void> {
    const now = Date.now();
    const includeDisks = this.lastDisks === undefined || now - this.lastDisks >= DISK_MS;
    try {
      const sample = await systemSample(includeDisks);
      if (sample.disks) {
        this.disks = sample.disks;
        this.lastDisks = now;
      }
      this.spark.push(sample.cpuPercent);
      this.render(sample);
    } catch {
      // Without the core (a browser-only run) the rows keep showing "-".
    }
  }

  private render(sample: SystemSample | null): void {
    this.cpuValue.textContent = formatPercent(sample?.cpuPercent ?? null);
    this.drawSpark();

    if (sample && sample.memoryTotalBytes > 0) {
      this.memValue.textContent = formatMemory(sample.memoryUsedBytes, sample.memoryTotalBytes);
      this.setBar(this.memBar, sample.memoryUsedBytes / sample.memoryTotalBytes);
    } else {
      this.memValue.textContent = '-';
      this.setBar(this.memBar, null);
    }

    this.netValue.textContent = sample
      ? formatNetwork(sample.netRxPerSec, sample.netTxPerSec)
      : formatNetwork(null, null);

    if (this.disks.length === 0) {
      const { row, value } = this.row('Disk');
      value.textContent = '-';
      this.diskBox.replaceChildren(row);
    } else {
      this.diskBox.replaceChildren(...this.disks.map((d) => this.diskRow(d)));
    }
  }

  private diskRow(d: DiskRow): HTMLElement {
    const { row, value } = this.row('Disk');
    value.textContent = formatDiskFree(d);
    const used = d.totalBytes > 0 ? 1 - d.availableBytes / d.totalBytes : null;
    this.setBar(this.bar(row), used);
    return row;
  }

  private setBar(fill: HTMLElement, fraction: number | null): void {
    if (fraction === null) {
      fill.style.width = '0%';
      fill.dataset.band = 'ok';
      return;
    }
    const f = Math.min(1, Math.max(0, fraction));
    fill.style.width = `${(f * 100).toFixed(1)}%`;
    fill.dataset.band = loadBand(f);
  }

  private drawSpark(): void {
    const ctx = this.canvas.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, SPARK_W, SPARK_H);
    const values = this.spark.values();
    if (values.length < 2) return;
    ctx.strokeStyle = getComputedStyle(this.el).getPropertyValue('--system-accent').trim() || '#4fb3c8';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    const step = SPARK_W / 29;
    const x0 = SPARK_W - (values.length - 1) * step;
    values.forEach((v, i) => {
      const x = x0 + i * step;
      const y = SPARK_H - 1 - (Math.min(100, Math.max(0, v)) / 100) * (SPARK_H - 2);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.stroke();
  }
}
