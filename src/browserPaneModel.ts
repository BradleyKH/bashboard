// Display and saved-state helpers for the Local Browser pane (docs/design/browser.md section 4.21).
// Pure, no DOM.
import { presetById, rotate, type DevicePreset } from './devicePresets';
import { hostLabel, normalizeInput } from './localBrowserModel';

export type DevtoolsTab = 'console' | 'network';

export interface DevtoolsState {
  open: boolean;
  tab: DevtoolsTab;
  /** The drawer's height in CSS pixels. */
  height: number;
  /** Console and Network side by side, ignoring `tab`. */
  split: boolean;
  /** Console's share of the drawer's width while split. */
  splitRatio: number;
}

export const DRAWER_MIN = 80;
const DRAWER_MAX = 2000;
const DRAWER_DEFAULT = 260;
/** Room the page keeps above the drawer, so dragging it up never hides the page entirely. */
const PAGE_MIN = 60;
const SPLIT_MIN = 0.15;
const SPLIT_MAX = 0.85;

export const DEFAULT_DEVTOOLS: DevtoolsState = {
  open: false,
  tab: 'console',
  height: DRAWER_DEFAULT,
  split: false,
  splitRatio: 0.5,
};

/** Saved drawer state with anything missing or out of range replaced by its default. */
export function normalizeDevtools(saved: Partial<DevtoolsState> | null | undefined): DevtoolsState {
  const h = saved?.height;
  return {
    open: saved?.open === true,
    tab: saved?.tab === 'network' ? 'network' : 'console',
    height: typeof h === 'number' && Number.isFinite(h) ? Math.round(Math.min(DRAWER_MAX, Math.max(DRAWER_MIN, h))) : DRAWER_DEFAULT,
    split: saved?.split === true,
    splitRatio: clampSplitRatio(saved?.splitRatio),
  };
}

/** Console's share of a split drawer, kept wide enough that neither panel vanishes. */
export function clampSplitRatio(ratio: unknown): number {
  if (typeof ratio !== 'number' || !Number.isFinite(ratio)) return DEFAULT_DEVTOOLS.splitRatio;
  return Math.round(Math.min(SPLIT_MAX, Math.max(SPLIT_MIN, ratio)) * 1000) / 1000;
}

/** The drawer height to show in a pane body `available` pixels tall. */
export function clampDrawerHeight(height: number, available: number): number {
  const max = Math.max(DRAWER_MIN, available - PAGE_MIN);
  return Math.round(Math.min(max, Math.max(DRAWER_MIN, height)));
}

export interface DeviceState {
  id: string;
  rotated: boolean;
}

const ROTATED_SUFFIX = ':rotated';

/** A saved device string: a preset id, with `:rotated` when turned on its side. Unknown ids mean Responsive. */
export function parseDevice(saved: string | null | undefined): DeviceState {
  const s = saved ?? '';
  const rotated = s.endsWith(ROTATED_SUFFIX);
  const preset = presetById(rotated ? s.slice(0, -ROTATED_SUFFIX.length) : s);
  return { id: preset.id, rotated: rotated && preset.width !== null };
}

export function formatDevice(d: DeviceState): string {
  return d.rotated ? `${d.id}${ROTATED_SUFFIX}` : d.id;
}

/** The preset to lay out, already rotated when the state says so. */
export function devicePreset(d: DeviceState): DevicePreset {
  const p = presetById(d.id);
  return d.rotated ? rotate(p) : p;
}

/** The toolbar's short name for the device: "Responsive", or "390x844". */
export function deviceLabel(d: DeviceState): string {
  const p = devicePreset(d);
  return p.width === null ? 'Responsive' : `${p.width}x${p.height}`;
}

/** Chromium's page for a frame whose document failed to load. */
export function isErrorPageUrl(url: string): boolean {
  return url.startsWith('chrome-error:');
}

/** A URL that means "no page": the start page shows instead. */
export function isBlankUrl(url: string | null): boolean {
  return url === null || url === '' || url === 'about:blank';
}

/** "localhost:5173" for the unreachable-page overlay; the raw text when it does not parse. */
export function hostOnly(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/** Why an https loopback page failed, from the core's own TLS handshake (`browser_probe_tls`). */
export type TlsProbe = 'untrusted' | 'notTls' | 'refused' | 'other';

export interface UnreachableMessage {
  heading: string;
  hint: string;
  /** A command that fixes the problem, shown apart so it can be copied. */
  command?: string;
}

/** The overlay text for a document that failed to load; `probe` is set only for https. */
export function unreachableMessage(url: string | null, probe: TlsProbe | null): UnreachableMessage {
  const where = url ? hostOnly(url) : 'that address';
  if (probe === 'untrusted') {
    return {
      heading: `The certificate for ${where} is not trusted`,
      hint: 'Local Browser loads https only with a certificate Windows trusts. For an ASP.NET Core development certificate, run this, then retry:',
      command: 'dotnet dev-certs https --trust',
    };
  }
  if (probe === 'notTls') {
    return {
      heading: `${where} did not answer over https`,
      hint: `If it serves plain http, open http://${where} instead.`,
    };
  }
  return { heading: `Nothing is listening on ${where}`, hint: 'Start the dev server, then retry.' };
}

/** The pane notice for a navigation the bridge stopped. */
export function blockedNotice(url: string, external: boolean, appOrigin: string | null): string {
  if (external) return `Opened ${hostOnly(url)} in your browser.`;
  const checked = normalizeInput(url, appOrigin);
  const reason = checked.ok ? 'Local Browser only opens localhost and 127.0.0.1.' : checked.reason;
  return `Blocked ${hostLabel(url)}. ${reason}`;
}

/** The path and query of a request URL, for the Network table; the whole URL for data: and the like. */
export function urlPath(url: string): string {
  try {
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return url.length > 80 ? `${url.slice(0, 80)}...` : url;
    return u.pathname + u.search;
  } catch {
    return url;
  }
}

/** "12 ms", "1.24 s"; empty while pending. */
export function formatDuration(ms: number | null): string {
  if (ms === null) return '';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(2)} s`;
}

/** "14:03:07.215" in local time. */
export function formatClock(timestamp: number): string {
  const d = new Date(timestamp);
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}

/** The body as shown in the Network detail: JSON indented, anything else as is. */
export function prettyBody(body: string, mimeType: string): string {
  const looksJson = /json/i.test(mimeType) || /^\s*[[{]/.test(body);
  if (!looksJson) return body;
  try {
    return JSON.stringify(JSON.parse(body), null, 2);
  } catch {
    return body;
  }
}

/** Decoded size of a base64 body, for the binary notice. */
export function base64Size(body: string): number {
  const trimmed = body.replace(/\s/g, '');
  const pad = trimmed.endsWith('==') ? 2 : trimmed.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor((trimmed.length * 3) / 4) - pad);
}
