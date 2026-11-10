// Display and saved-state helpers for the Local Browser pane (docs/design/browser.md section 4.21).
// Pure, no DOM.
import { presetById, rotate, type DevicePreset } from './devicePresets';
import { fileUrlToPath, hostLabel, normalizeInput, pathToFileUrl } from './localBrowserModel';

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
  split: true,
  splitRatio: 0.5,
};

/** Saved drawer state with anything missing or out of range replaced by its default. */
export function normalizeDevtools(saved: Partial<DevtoolsState> | null | undefined): DevtoolsState {
  const h = saved?.height;
  return {
    open: saved?.open === true,
    tab: saved?.tab === 'network' ? 'network' : 'console',
    height: typeof h === 'number' && Number.isFinite(h) ? Math.round(Math.min(DRAWER_MAX, Math.max(DRAWER_MIN, h))) : DRAWER_DEFAULT,
    split: saved?.split !== false,
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
  if (url?.startsWith('file:')) {
    return { heading: `Could not open ${hostLabel(url)}`, hint: 'The file may have moved or been deleted. Check its path, then retry.' };
  }
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

/**
 * The pane notice for a navigation the bridge stopped. `downloaded` marks a Downloaded page asking for
 * a loopback address outside its own folder's listener (docs/design/security.md section 9.1).
 */
export function blockedNotice(url: string, external: boolean, appOrigin: string | null, downloaded = false): string {
  if (downloaded) return `Blocked ${hostLabel(url)}. Downloaded pages can't open local services.`;
  if (external) return `Opened ${hostOnly(url)} in your browser.`;
  const checked = normalizeInput(url, appOrigin);
  // A page-initiated file:// navigation passes the address field's rules but still cannot open: only
  // a path typed in the field is served (docs/design/browser.md section 3.21).
  const reason = checked.ok ? 'Only loopback addresses and local HTML files typed in the address field open.' : checked.reason;
  return `Blocked ${hostLabel(url)}. ${reason}`;
}

/** Where a file page's mount is served, from `browser_serve_file`. */
export interface FileMount {
  /** `http://127.0.0.1:<port>/<token>/`. */
  base: string;
  /** The served file on disk; its folder is the mount's root, which request paths are relative to. */
  path: string;
  /** The mount's name: its folder, or `path` itself on a single-file mount. */
  folder?: string;
}

/**
 * The file on disk a serving URL under `mount` names, as a Windows path; null for any other URL.
 * The query and hash are dropped, since a file page's identity is its file.
 */
export function servedPath(url: string, mount: FileMount | null): string | null {
  if (mount === null || !url.startsWith(mount.base)) return null;
  const rel = url.slice(mount.base.length).split(/[?#]/)[0];
  let segments: string[];
  try {
    segments = rel.split('/').map(decodeURIComponent);
  } catch {
    return null;
  }
  // The same segments the core refuses (3.21 Requests). A decoded `\` or `/` would otherwise let a
  // page's own address name a file outside its mount, which the pane then serves to itself.
  if (segments.some((s) => s === '' || s.startsWith('.') || /[\\/:\0]/.test(s))) return null;
  const root = mount.path.replace(/[\\/]+[^\\/]*$/, '');
  const path = `${root}\\${segments.join('\\')}`;
  // A single-file mount (a drive root or the home folder) serves no other path, so a page's own
  // address must not name another file there for the pane to open (3.21 Mounts).
  if (mount.folder === mount.path && path.toLowerCase() !== mount.path.toLowerCase()) return null;
  return path;
}

/** The live tokens the core keeps per pane (3.21 Mounts), and so the serving bases a pane remembers. */
export const MOUNTS_PER_PANE = 20;

/**
 * The mount a serving URL is under, from `mounts` (the current one first), and the `file:///` URL of
 * the file it names; null when it is under none. A pane keeps every mount it has been served, since
 * Back and Forward can land on an address under a listener it has since moved off or a file page it
 * has since left (3.21 Mounts).
 */
export function findMount<M extends FileMount>(url: string, mounts: readonly M[]): { mount: M; fileUrl: string } | null {
  for (const mount of mounts) {
    const path = servedPath(url, mount);
    const fileUrl = path !== null && pathToFileUrl(path);
    if (fileUrl) return { mount, fileUrl };
  }
  return null;
}

/** The `file:///` URL for a serving URL under any of `mounts`, or `url` itself when it is under none. */
export function shownUrl(url: string, mounts: readonly FileMount[]): string {
  return findMount(url, mounts)?.fileUrl ?? url;
}

/** `mounts` with `mount` first and no other entry for its base, at most `cap` long. */
export function rememberMount<M extends FileMount>(mounts: readonly M[], mount: M, cap = MOUNTS_PER_PANE): M[] {
  return [mount, ...mounts.filter((m) => m.base !== mount.base)].slice(0, cap);
}

/** What a committed document means for a pane's file mode. */
export type FilePageStep<M extends FileMount> =
  /** Not a serving address of this pane: the pane leaves file mode. */
  | { kind: 'leave' }
  /**
   * A file page. `reenter` when the pane was not in file mode (Back or Forward from another page);
   * `serve` when the core must serve the file again, to refresh its trust badge and file watch, or
   * to move it to the listener its trust calls for.
   */
  | { kind: 'file'; mount: M; fileUrl: string; reenter: boolean; serve: boolean };

/**
 * The step for a document committed at `url`. `current` is the file page shown before it, or null
 * outside file mode. Only HTML is served again, since the core serves nothing else as a page.
 */
export function filePageStep<M extends FileMount>(
  url: string,
  current: { base: string; fileUrl: string | null } | null,
  mounts: readonly M[],
): FilePageStep<M> {
  const hit = findMount(url, mounts);
  if (hit === null) return { kind: 'leave' };
  const reenter = current === null;
  const changed = reenter || hit.fileUrl !== current.fileUrl || !url.startsWith(current.base);
  return { kind: 'file', ...hit, reenter, serve: changed && isHtmlFile(hit.fileUrl) };
}

/** What the address field shows for `url`: a file's path for a `file:///` URL, else undefined (the URL itself). */
export function displayText(url: string | null): string | undefined {
  return url?.startsWith('file:') ? (fileUrlToPath(url) ?? undefined) : undefined;
}

/** Whether a file URL or path names an HTML page, the only kind the file server will serve as a page. */
export function isHtmlFile(url: string): boolean {
  return /\.html?$/i.test(url.split(/[?#]/)[0]);
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
