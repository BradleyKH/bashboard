// Pure model for the dashboard System section (docs/design/dashboard.md section 4.6): wire types,
// value formatting, load bands, and the sparkline buffer and scale. No DOM, no Tauri.

/** One fixed drive, as `system.rs` reports it. */
export interface DiskRow {
  mount: string;
  totalBytes: number;
  availableBytes: number;
}

/** Payload of the `system_sample` command. A null rate has no previous sample to diff against. */
export interface SystemSample {
  cpuPercent: number | null;
  memoryUsedBytes: number;
  memoryTotalBytes: number;
  netRxPerSec: number | null;
  netTxPerSec: number | null;
  /** Null when the caller did not ask for disks. */
  disks: DiskRow[] | null;
}

const UNITS = ['B', 'KB', 'MB', 'GB', 'TB'];

function unitFor(bytes: number): number {
  let unit = 0;
  let value = bytes;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return unit;
}

/** Binary units: 1023 B, 1.0 KB, 10 KB, 1.5 GB, 2.0 TB. */
export function formatBytes(bytes: number): string {
  const unit = unitFor(bytes);
  if (unit === 0) return `${Math.round(bytes)} B`;
  const value = bytes / 1024 ** unit;
  return `${value.toFixed(value < 10 ? 1 : 0)} ${UNITS[unit]}`;
}

/** "21.4 / 32 GB": both figures in the total's unit, the total without a decimal when whole. */
export function formatMemory(used: number, total: number): string {
  const unit = unitFor(total);
  const scale = 1024 ** unit;
  const totalValue = total / scale;
  const totalText = Number.isInteger(totalValue) ? String(totalValue) : totalValue.toFixed(1);
  const usedText = unit === 0 ? String(Math.round(used)) : (used / scale).toFixed(1);
  return `${usedText} / ${totalText} ${UNITS[unit]}`;
}

/** "1.2 MB/s", "40 KB/s", "0 B/s". */
export function formatRate(bytesPerSec: number): string {
  return `${formatBytes(bytesPerSec)}/s`;
}

/** "↓ 1.2 MB/s ↑ 40 KB/s", or hyphens until both rates are known. */
export function formatNetwork(rx: number | null, tx: number | null): string {
  if (rx === null || tx === null) return '\u2193 - \u2191 -';
  return `\u2193 ${formatRate(rx)} \u2191 ${formatRate(tx)}`;
}

/** "C: 112 GB free". */
export function formatDiskFree(row: DiskRow): string {
  return `${row.mount} ${formatBytes(row.availableBytes)} free`;
}

/** "23%", or "-" while unknown. */
export function formatPercent(p: number | null): string {
  return p === null ? '-' : `${Math.round(p)}%`;
}

export type LoadBand = 'ok' | 'warn' | 'error';

/** Bar color band: warning from 80% and error from 90%. */
export function loadBand(fraction: number): LoadBand {
  if (fraction >= 0.9) return 'error';
  if (fraction >= 0.8) return 'warn';
  return 'ok';
}

export const SPARKLINE_CAPACITY = 30;

/** Ring buffer of the last 60 seconds of readings at one per 2 seconds. */
export class Sparkline {
  private readonly buf: number[] = [];

  /** A null reading records nothing. */
  push(value: number | null): void {
    if (value === null) return;
    this.buf.push(value);
    if (this.buf.length > SPARKLINE_CAPACITY) this.buf.shift();
  }

  /** Oldest first. */
  values(): number[] {
    return [...this.buf];
  }
}

/** Floor for the rate sparkline's scale, so background chatter stays near the baseline. */
const RATE_SCALE_FLOOR = 256 * 1024;

/** Top of the rate sparkline's scale: the busiest reading on screen, never below 256 KB/s. */
export function rateScale(values: readonly number[]): number {
  return Math.max(RATE_SCALE_FLOOR, ...values);
}

/** One program in the top-processes popup: every process sharing an executable name, summed. */
export interface ProcessGroup {
  name: string;
  count: number;
  /** Share of the whole machine, on the same scale as `SystemSample.cpuPercent`. */
  cpuPercent: number;
  memoryBytes: number;
}

/** Payload of the `system_top_processes` command. */
export interface TopProcesses {
  byCpu: ProcessGroup[];
  byMemory: ProcessGroup[];
}

export type ProcessMetric = 'cpu' | 'memory';

/** How many programs the popup lists. */
export const TOP_PROCESS_LIMIT = 6;

export interface ProcessLine {
  name: string;
  /** "×12" when several processes share the name, else empty. */
  count: string;
  value: string;
}

/** The popup's lines for one metric: under 1% of CPU reads "<1%" rather than "0%". */
export function processLines(top: TopProcesses, metric: ProcessMetric): ProcessLine[] {
  const groups = metric === 'cpu' ? top.byCpu : top.byMemory;
  return groups.map((g) => ({
    name: g.name,
    count: g.count > 1 ? `×${g.count}` : '',
    value:
      metric === 'cpu'
        ? g.cpuPercent < 0.5
          ? '<1%'
          : `${Math.round(g.cpuPercent)}%`
        : formatBytes(g.memoryBytes),
  }));
}
