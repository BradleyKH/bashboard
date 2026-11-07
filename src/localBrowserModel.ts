// URL entry, suggestions, bookmarks, and recent URLs for the Local Browser pane (docs/design/browser.md
// section 4.21). Pure, no DOM. The loopback rule matches the Rust browser policy: http or https,
// hosts `localhost` and `127.0.0.1`, any port, no credentials.
import type { Listener } from './ports';
import { localUrl, processLabel } from './portsModel';

export interface Bookmark {
  name: string;
  url: string;
}

export type NormalizeResult = { ok: true; url: string } | { ok: false; reason: string };

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1']);
const LOOPBACK_ONLY = 'Local Browser only opens localhost and 127.0.0.1.';

function effectivePort(u: URL): string {
  return u.port || (u.protocol === 'https:' ? '443' : '80');
}

/**
 * Whether `url` is the app's own dev server. Every loopback host and scheme reaches the same
 * server, so the app's port on any of them counts, not just the exact origin.
 */
export function isAppOrigin(url: string, appOrigin: string | null): boolean {
  if (appOrigin === null) return false;
  let u: URL;
  let app: URL;
  try {
    u = new URL(url);
    app = new URL(appOrigin);
  } catch {
    return false;
  }
  if (!LOOPBACK_HOSTS.has(app.hostname)) return u.origin === app.origin;
  return LOOPBACK_HOSTS.has(u.hostname) && effectivePort(u) === effectivePort(app);
}

/** Whether `url` is an http or https URL on a loopback host with no credentials. */
export function isLoopbackUrl(url: string): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  return (u.protocol === 'http:' || u.protocol === 'https:') && LOOPBACK_HOSTS.has(u.hostname) && u.username === '' && u.password === '';
}

/**
 * Turns what was typed into a loopback URL: `5173` and `:5173` mean `http://localhost:5173/`, and a
 * missing scheme means http. Anything else, including the app's own origin, is refused with a reason.
 */
export function normalizeInput(text: string, appOrigin: string | null): NormalizeResult {
  const t = text.trim();
  if (t === '') return { ok: false, reason: 'Enter a localhost address or port.' };
  if (/\s/.test(t)) return { ok: false, reason: 'A URL cannot contain spaces.' };

  let candidate = t;
  const port = /^:?(\d{1,5})$/.exec(t);
  if (port) {
    const n = Number(port[1]);
    if (n < 1 || n > 65535) return { ok: false, reason: 'Ports run from 1 to 65535.' };
    candidate = `http://localhost:${n}/`;
  } else if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(t)) {
    candidate = `http://${t}`;
  }

  let u: URL;
  try {
    u = new URL(candidate);
  } catch {
    return { ok: false, reason: `"${t}" is not a valid address. ${LOOPBACK_ONLY}` };
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return { ok: false, reason: LOOPBACK_ONLY };
  if (u.username !== '' || u.password !== '') return { ok: false, reason: 'Addresses with a username or password are not allowed.' };
  if (!LOOPBACK_HOSTS.has(u.hostname)) return { ok: false, reason: LOOPBACK_ONLY };
  if (isAppOrigin(u.href, appOrigin)) {
    return { ok: false, reason: 'That is Bashboard itself, which cannot be opened in a pane.' };
  }
  return { ok: true, url: u.href };
}

/** Compares URLs ignoring a bare trailing slash and letter case in the scheme and host. */
function urlKey(url: string): string {
  try {
    return new URL(url).href;
  } catch {
    return url;
  }
}

export function isBookmarked(bookmarks: readonly Bookmark[], url: string): boolean {
  const k = urlKey(url);
  return bookmarks.some((b) => urlKey(b.url) === k);
}

/** Adds the page as a bookmark, or removes it when it is already one. Returns a new array. */
export function toggleBookmark(bookmarks: readonly Bookmark[], url: string, title: string): Bookmark[] {
  const k = urlKey(url);
  if (bookmarks.some((b) => urlKey(b.url) === k)) return bookmarks.filter((b) => urlKey(b.url) !== k);
  return [...bookmarks, { name: title.trim() || hostLabel(url), url }];
}

/** "localhost:5173/path" for a URL, without the scheme. */
export function hostLabel(url: string): string {
  try {
    const u = new URL(url);
    const path = u.pathname === '/' && u.search === '' && u.hash === '' ? '' : u.pathname + u.search + u.hash;
    return u.host + path;
  } catch {
    return url;
  }
}

export const RECENT_CAP = 50;

/** Visited URLs, most recent first, one entry per URL, at most `RECENT_CAP`. */
export class RecentUrls {
  private items: string[];

  constructor(initial: readonly string[] = [], private readonly cap = RECENT_CAP) {
    this.items = [];
    for (const u of initial) if (!this.items.includes(u)) this.items.push(u);
    this.items.length = Math.min(this.items.length, cap);
  }

  add(url: string): void {
    this.items = [url, ...this.items.filter((u) => u !== url)].slice(0, this.cap);
  }

  list(): readonly string[] {
    return this.items;
  }
}

export type SuggestionSource = 'bookmark' | 'port' | 'recent';

export interface Suggestion {
  label: string;
  url: string;
  source: SuggestionSource;
}

export interface SuggestionInputs {
  bookmarks: readonly Bookmark[];
  listeners: readonly Listener[];
  recent: readonly string[];
}

const SOURCE_RANK: Record<SuggestionSource, number> = { bookmark: 0, port: 1, recent: 2 };

/**
 * Bookmarks, listening ports, and recent URLs that match `query`, one row per URL (the highest
 * source wins), best match first: prefix matches before substring matches, then bookmarks, ports,
 * and recents, each in its given order. Service and Bashboard's own listeners are skipped.
 */
export function suggestions(query: string, inputs: SuggestionInputs): Suggestion[] {
  const all: Suggestion[] = [];
  for (const b of inputs.bookmarks) all.push({ label: b.name || hostLabel(b.url), url: b.url, source: 'bookmark' });
  for (const l of inputs.listeners) {
    if (l.system || l.own) continue;
    all.push({ label: `localhost:${l.port} (${processLabel(l.name)})`, url: localUrl(l), source: 'port' });
  }
  for (const url of inputs.recent) all.push({ label: hostLabel(url), url, source: 'recent' });

  const needle = query.trim().toLowerCase();
  const seen = new Set<string>();
  const scored: { s: Suggestion; score: number; order: number }[] = [];
  all.forEach((s, order) => {
    const key = urlKey(s.url);
    if (seen.has(key)) return;
    const hosts = [s.label.toLowerCase(), hostLabel(s.url).toLowerCase(), s.url.toLowerCase()];
    let score = 0;
    if (needle !== '') {
      // A port typed after the colon counts as a prefix, so "5173" prefers localhost:5173 over :15173.
      if (hosts.some((h) => h.startsWith(needle) || h.includes(`:${needle}`))) score = 0;
      else if (hosts.some((h) => h.includes(needle))) score = 1;
      else return;
    }
    seen.add(key);
    scored.push({ s, score, order });
  });
  scored.sort((a, b) => a.score - b.score || SOURCE_RANK[a.s.source] - SOURCE_RANK[b.s.source] || a.order - b.order);
  return scored.map((x) => x.s);
}
