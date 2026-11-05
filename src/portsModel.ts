// Listening ports for the dashboard's Ports section and the Ports pane (docs/design.md section
// 4.19). Pure, no DOM.
import type { ConfirmOptions } from './confirmDialog';
import { displayPath } from './displayPath';
import type { Listener } from './ports';

/** Names one listener: the process (pid and start time, so a reused pid differs) and the port. */
export function listenerKey(l: Listener): string {
  return `${l.pid}:${l.startedAt}:${l.port}`;
}

/** Programs that serve while developing, which the dashboard lists wherever they were started. */
const DEV_RUNTIMES = new Set([
  'node', 'bun', 'deno', 'python', 'pythonw', 'py', 'uvicorn', 'gunicorn', 'dotnet', 'iisexpress',
  'java', 'javaw', 'ruby', 'php', 'php-cgi', 'perl', 'go', 'cargo', 'esbuild', 'caddy', 'nginx',
  'httpd', 'hugo', 'postgres', 'mysqld', 'mariadbd', 'redis-server', 'mongod', 'ollama',
  'ollama app', 'lm studio', 'lms', 'llama-server',
]);

/** Whether a listener looks like something you started while developing, not a background app. */
export function isDevListener(l: Listener): boolean {
  return l.ptyId !== null || l.fromShell || DEV_RUNTIMES.has(processLabel(l.name).toLowerCase());
}

export interface DashboardPorts {
  /** Pane-started first, then by port. */
  rows: Listener[];
  /** Other programs' listeners, which the section counts in one row instead of listing. */
  others: number;
}

/** The dashboard's ports: dev listeners listed, other apps counted; services and Bashboard itself left out. */
export function dashboardListeners(list: readonly Listener[]): DashboardPorts {
  const user = list.filter((l) => !l.system && !l.own);
  const rows = user
    .filter(isDevListener)
    .sort((a, b) => Number(b.ptyId !== null) - Number(a.ptyId !== null) || a.port - b.port || a.pid - b.pid);
  return { rows, others: user.length - rows.length };
}

export interface PaneFilter {
  showSystem: boolean;
  /** Only rows traced to a pane that is still open. */
  paneOnly: boolean;
  /** Case-insensitive; matches the port, process name, command line, folder, or owning pane. */
  text: string;
}

export type PortSortColumn = 'port' | 'program' | 'pane' | 'address' | 'pid' | 'up';

export interface PortSort {
  column: PortSortColumn;
  desc: boolean;
}

export const DEFAULT_PORT_SORT: PortSort = { column: 'port', desc: false };

/** A header click: the same column flips direction, a new one starts ascending. */
export function nextPortSort(current: PortSort, column: PortSortColumn): PortSort {
  return column === current.column ? { column, desc: !current.desc } : { column, desc: false };
}

const text = (a: string, b: string) => a.localeCompare(b, undefined, { sensitivity: 'base', numeric: true });

/** Compares on the column alone, ascending; 0 on a tie. */
function compareColumn(column: PortSortColumn, a: Listener, b: Listener, ownerTitle: (l: Listener) => string | null): number {
  switch (column) {
    case 'port':
      return a.port - b.port;
    case 'program':
      return text(processLabel(a.name), processLabel(b.name));
    case 'pane':
      return text(ownerTitle(a) ?? '', ownerTitle(b) ?? '');
    case 'address':
      return text(addressLabel(a.addresses), addressLabel(b.addresses));
    case 'pid':
      return a.pid - b.pid;
    case 'up':
      // Shortest uptime first, so the latest start leads.
      return b.startedAt - a.startedAt;
  }
}

/** Sorts on `sort`, then by port and pid. Rows with no pane sort last either way, being blanks. */
export function sortListeners(
  rows: Listener[],
  sort: PortSort,
  ownerTitle: (l: Listener) => string | null,
): Listener[] {
  const sign = sort.desc ? -1 : 1;
  return rows.sort((a, b) => {
    if (sort.column === 'pane') {
      const blank = Number(ownerTitle(a) === null) - Number(ownerTitle(b) === null);
      if (blank !== 0) return blank;
    }
    return sign * compareColumn(sort.column, a, b, ownerTitle) || a.port - b.port || a.pid - b.pid;
  });
}

/** The Ports pane's rows, sorted on `sort`. */
export function paneListeners(
  list: readonly Listener[],
  filter: PaneFilter,
  ownerTitle: (l: Listener) => string | null,
  sort: PortSort = DEFAULT_PORT_SORT,
): Listener[] {
  const needle = filter.text.trim().toLowerCase();
  const rows = list
    .filter((l) => filter.showSystem || !l.system)
    .filter((l) => !filter.paneOnly || ownerTitle(l) !== null)
    .filter((l) => {
      if (needle === '') return true;
      const hay = [String(l.port), l.name, l.command, l.cwd ?? '', ownerTitle(l) ?? ''].join('\n').toLowerCase();
      return hay.includes(needle);
    });
  return sortListeners(rows, sort, ownerTitle);
}

function isLoopback(a: string): boolean {
  return a === '::1' || a.startsWith('127.');
}

function isAny(a: string): boolean {
  return a === '0.0.0.0' || a === '::';
}

/** "localhost", "all interfaces", or the one address it is bound to. */
export function addressLabel(addresses: readonly string[]): string {
  if (addresses.some(isAny)) return 'all interfaces';
  if (addresses.length > 0 && addresses.every(isLoopback)) return 'localhost';
  return addresses.join(', ');
}

/** Whether the port answers from other machines, which the rows flag. */
export function isExposed(addresses: readonly string[]): boolean {
  return !addresses.every(isLoopback);
}

/** The status dot's tooltip. */
export function exposureLabel(addresses: readonly string[]): string {
  return isExposed(addresses) ? 'Reachable from other machines' : 'Local only';
}

/** The process name without `.exe`. */
export function processLabel(name: string): string {
  return name.replace(/\.exe$/i, '') || 'unknown';
}

/** "45s", "12m", "3h 5m", "2d 4h". */
export function formatUptime(nowSec: number, startedAt: number): string {
  if (startedAt <= 0) return '-';
  const s = Math.max(0, Math.floor(nowSec - startedAt));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return m % 60 ? `${h}h ${m % 60}m` : `${h}h`;
  const d = Math.floor(h / 24);
  return h % 24 ? `${d}d ${h % 24}h` : `${d}d`;
}

/** Whether Stop may end it: never Bashboard itself or the kernel. */
export function canStop(l: Listener): boolean {
  return !l.own && l.pid > 4;
}

export function localUrl(l: Listener): string {
  return `http://localhost:${l.port}`;
}

/** The row tooltip: what is running, where, and since when. */
export function listenerTooltip(l: Listener, owner: string | null, nowSec: number): string {
  const lines = [`${processLabel(l.name)} (pid ${l.pid}) on port ${l.port}, ${addressLabel(l.addresses)}`];
  if (l.cwd) lines.push(`in ${displayPath(l.cwd)}`);
  if (l.command) lines.push(l.command);
  lines.push(owner ? `Started from ${owner}` : 'Not started from a pane');
  lines.push(`Up ${formatUptime(nowSec, l.startedAt)}`);
  return lines.join('\n');
}

/** Keys in `list` that were not in `seen`; the first snapshot flashes nothing. */
export function newKeys(seen: ReadonlySet<string> | null, list: readonly Listener[]): Set<string> {
  if (seen === null) return new Set();
  return new Set(list.map(listenerKey).filter((k) => !seen.has(k)));
}

export function stopConfirm(l: Listener, owner: string | null): ConfirmOptions {
  const what = `${processLabel(l.name)} (pid ${l.pid})`;
  const body = [`Stopping ${what} ends it and every process it started, closing port ${l.port}.`];
  if (l.command) body.push(l.command);
  body.push(owner ? `It was started from ${owner}.` : 'It was not started from a Bashboard pane.');
  return { title: `Stop ${processLabel(l.name)}?`, body, confirmLabel: 'Stop' };
}
