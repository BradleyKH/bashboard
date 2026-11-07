// Console and Network logs for the Local Browser DevTools drawer (docs/design/browser.md section
// 4.21). Pure, no DOM. `BrowserEvent` mirrors the Rust bridge's event enum.

export type BrowserEvent =
  | { kind: 'navigated'; url: string; title?: string; unreachableUrl?: string }
  | { kind: 'navigatedInPage'; url: string }
  | { kind: 'title'; title: string }
  | { kind: 'blocked'; url: string; external: boolean }
  | { kind: 'console'; level: string; text: string; source?: string; url?: string; line?: number; timestamp: number }
  | { kind: 'exception'; text: string; url?: string; line?: number; timestamp: number }
  | {
      kind: 'request';
      requestId: string;
      url: string;
      method: string;
      resourceType: string;
      headers: Record<string, string>;
      timestamp: number;
    }
  | {
      kind: 'response';
      requestId: string;
      status: number;
      statusText: string;
      mimeType: string;
      headers: Record<string, string>;
      timestamp: number;
    }
  | { kind: 'finished'; requestId: string; encodedLength: number; timestamp: number }
  | { kind: 'failed'; requestId: string; errorText: string; canceled: boolean; timestamp: number }
  | { kind: 'loadState'; loading: boolean };

export const CONSOLE_CAP = 2000;
export const NETWORK_CAP = 1000;

export type ConsoleLevel = 'log' | 'info' | 'warn' | 'error' | 'debug';
export const CONSOLE_LEVELS: readonly ConsoleLevel[] = ['log', 'info', 'warn', 'error', 'debug'];

export interface ConsoleEntry {
  id: number;
  level: ConsoleLevel;
  text: string;
  source?: string;
  url?: string;
  line?: number;
  timestamp: number;
  /** An uncaught exception, shown as an error. */
  exception: boolean;
}

export interface ConsoleFilter {
  /** Levels to keep; undefined keeps every level. */
  levels?: ReadonlySet<ConsoleLevel> | readonly ConsoleLevel[];
  /** Case-insensitive match on the message text. */
  text?: string;
}

/** Maps a CDP console type ("warning", "assert", "trace", ...) onto the five levels the drawer shows. */
export function consoleLevel(raw: string): ConsoleLevel {
  switch (raw) {
    case 'warning':
    case 'warn':
      return 'warn';
    case 'error':
    case 'assert':
      return 'error';
    case 'info':
      return 'info';
    case 'debug':
    case 'trace':
      return 'debug';
    default:
      return 'log';
  }
}

/** A ring buffer of console output; the oldest entries drop once `cap` is exceeded. */
export class ConsoleLog {
  private items: ConsoleEntry[] = [];
  private nextId = 1;

  constructor(private readonly cap = CONSOLE_CAP) {}

  /** Records a console or exception event; any other event is ignored. Returns the entry or null. */
  add(ev: BrowserEvent): ConsoleEntry | null {
    let entry: ConsoleEntry;
    if (ev.kind === 'console') {
      entry = {
        id: this.nextId++,
        level: consoleLevel(ev.level),
        text: ev.text,
        source: ev.source,
        url: ev.url,
        line: ev.line,
        timestamp: ev.timestamp,
        exception: false,
      };
    } else if (ev.kind === 'exception') {
      entry = {
        id: this.nextId++,
        level: 'error',
        text: ev.text,
        url: ev.url,
        line: ev.line,
        timestamp: ev.timestamp,
        exception: true,
      };
    } else {
      return null;
    }
    this.items.push(entry);
    if (this.items.length > this.cap) this.items.splice(0, this.items.length - this.cap);
    return entry;
  }

  clear(): void {
    this.items = [];
  }

  get size(): number {
    return this.items.length;
  }

  entries(): readonly ConsoleEntry[] {
    return this.items;
  }

  filter(f: ConsoleFilter = {}): ConsoleEntry[] {
    const levels = f.levels ? new Set<ConsoleLevel>(f.levels) : null;
    const needle = (f.text ?? '').trim().toLowerCase();
    return this.items.filter(
      (e) => (!levels || levels.has(e.level)) && (needle === '' || e.text.toLowerCase().includes(needle)),
    );
  }

  /** Entries per level, over everything buffered (not the filter). */
  counts(): Record<ConsoleLevel, number> {
    const out: Record<ConsoleLevel, number> = { log: 0, info: 0, warn: 0, error: 0, debug: 0 };
    for (const e of this.items) out[e.level]++;
    return out;
  }
}

export type NetworkTypeGroup = 'fetch' | 'doc' | 'js' | 'css' | 'img' | 'other';
export const NETWORK_TYPE_GROUPS: readonly NetworkTypeGroup[] = ['fetch', 'doc', 'js', 'css', 'img', 'other'];

/** The filter chip a CDP resource type falls under. */
export function typeGroup(resourceType: string): NetworkTypeGroup {
  switch (resourceType.toLowerCase()) {
    case 'xhr':
    case 'fetch':
      return 'fetch';
    case 'document':
      return 'doc';
    case 'script':
      return 'js';
    case 'stylesheet':
      return 'css';
    case 'image':
      return 'img';
    default:
      return 'other';
  }
}

export interface NetworkRow {
  requestId: string;
  method: string;
  url: string;
  /** The CDP resource type, as reported. */
  type: string;
  status: number | null;
  statusText: string;
  mimeType: string;
  /** Encoded bytes on the wire; null until the request finishes. */
  size: number | null;
  /** The request's timestamp, in the event stream's unit. */
  start: number;
  /** Finish (or failure) timestamp minus `start`, in the same unit; null while pending. */
  duration: number | null;
  failed: boolean;
  canceled: boolean;
  errorText: string;
  requestHeaders?: Record<string, string>;
  responseHeaders: Record<string, string>;
}

export interface NetworkFilter {
  /** Case-insensitive match on URL, method, or status. */
  text?: string;
  /** Type groups to keep; undefined or empty keeps all. */
  types?: ReadonlySet<NetworkTypeGroup> | readonly NetworkTypeGroup[];
}

/** Rows assembled from request, response, finished, and failed events, oldest first. */
export class NetworkLog {
  private byId = new Map<string, NetworkRow>();

  constructor(private readonly cap = NETWORK_CAP) {}

  /** Applies a network event; any other event is ignored. */
  apply(ev: BrowserEvent): void {
    switch (ev.kind) {
      case 'request': {
        const existing = this.byId.get(ev.requestId);
        if (existing) {
          // A redirect reuses the request id; the row follows the new hop.
          existing.method = ev.method;
          existing.url = ev.url;
          existing.start = ev.timestamp;
          existing.requestHeaders = ev.headers;
          return;
        }
        this.byId.set(ev.requestId, {
          requestId: ev.requestId,
          method: ev.method,
          url: ev.url,
          type: ev.resourceType,
          status: null,
          statusText: '',
          mimeType: '',
          size: null,
          start: ev.timestamp,
          duration: null,
          failed: false,
          canceled: false,
          errorText: '',
          requestHeaders: ev.headers,
          responseHeaders: {},
        });
        // Maps iterate in insertion order, so the first key is the oldest row.
        while (this.byId.size > this.cap) this.byId.delete(this.byId.keys().next().value as string);
        return;
      }
      case 'response': {
        const row = this.byId.get(ev.requestId);
        if (!row) return;
        row.status = ev.status;
        row.statusText = ev.statusText;
        row.mimeType = ev.mimeType;
        row.responseHeaders = ev.headers;
        return;
      }
      case 'finished': {
        const row = this.byId.get(ev.requestId);
        if (!row) return;
        row.size = ev.encodedLength;
        row.duration = Math.max(0, ev.timestamp - row.start);
        return;
      }
      case 'failed': {
        const row = this.byId.get(ev.requestId);
        if (!row) return;
        row.failed = true;
        row.canceled = ev.canceled;
        row.errorText = ev.errorText;
        row.duration = Math.max(0, ev.timestamp - row.start);
        return;
      }
      default:
        return;
    }
  }

  clear(): void {
    this.byId.clear();
  }

  get size(): number {
    return this.byId.size;
  }

  get(requestId: string): NetworkRow | undefined {
    return this.byId.get(requestId);
  }

  rows(): NetworkRow[] {
    return [...this.byId.values()];
  }

  filter(f: NetworkFilter = {}): NetworkRow[] {
    const picked = new Set<NetworkTypeGroup>(f.types ?? []);
    const types = picked.size > 0 ? picked : null;
    const needle = (f.text ?? '').trim().toLowerCase();
    return this.rows().filter((r) => {
      if (types && !types.has(typeGroup(r.type))) return false;
      if (needle === '') return true;
      const hay = `${r.url}\n${r.method}\n${r.status ?? ''}`.toLowerCase();
      return hay.includes(needle);
    });
  }
}
