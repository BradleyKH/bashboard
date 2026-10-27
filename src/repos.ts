import { moveItem, samePath } from './favorites';

/** One pinned file or folder; `path` is relative to the root (forward slashes) when inside it. */
export interface Pin {
  path: string;
  label?: string;
}

/** repos.json (docs/design.md sections 3.7 and 7): pins per repo, roots compared without regard to case. */
export interface RepoPins {
  root: string;
  pins: Pin[];
}

export type ReposFile = RepoPins[];

export function parseRepos(raw: unknown): ReposFile {
  if (!Array.isArray(raw)) return [];
  const out: ReposFile = [];
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) continue;
    const { root, pins } = item as Record<string, unknown>;
    if (typeof root !== 'string' || root.trim() === '' || !Array.isArray(pins)) continue;
    const good: Pin[] = [];
    for (const p of pins) {
      if (typeof p !== 'object' || p === null) continue;
      const { path, label } = p as Record<string, unknown>;
      if (typeof path !== 'string' || path.trim() === '') continue;
      const text = typeof label === 'string' ? label.trim() : '';
      good.push({ path, ...(text ? { label: text } : {}) });
    }
    if (good.length === 0) continue;
    const existing = out.find((r) => samePath(r.root, root));
    if (existing) existing.pins.push(...good);
    else out.push({ root, pins: good });
  }
  return out;
}

export function pinsFor(file: ReposFile, root: string): Pin[] {
  return file.find((r) => samePath(r.root, root))?.pins ?? [];
}

function slashes(p: string): string {
  return p.replace(/[\\/]+/g, '/');
}

function trimEnd(p: string): string {
  return p.replace(/\/+$/, '');
}

/** A forward-slash path relative to `root` when `absolute` is inside it, else `absolute` unchanged. */
export function toPinPath(root: string, absolute: string): string {
  const r = trimEnd(slashes(root));
  const a = trimEnd(slashes(absolute));
  if (a.toLowerCase() === r.toLowerCase()) return '.';
  if (a.toLowerCase().startsWith(r.toLowerCase() + '/')) return a.slice(r.length + 1);
  return absolute;
}

function isAbsolute(p: string): boolean {
  return /^[a-zA-Z]:[\\/]/.test(p) || p.startsWith('\\\\') || p.startsWith('/');
}

/** The absolute path a pin points at, using the root's own separator style. */
export function resolvePin(root: string, pin: Pin): string {
  if (isAbsolute(pin.path)) return pin.path;
  const rel = pin.path === '.' ? '' : trimEnd(slashes(pin.path));
  const base = root.replace(/[\\/]+$/, '');
  if (rel === '') return base;
  const sep = root.includes('\\') ? '\\' : '/';
  return base + sep + rel.split('/').join(sep);
}

function samePin(a: string, b: string): boolean {
  return trimEnd(slashes(a)).toLowerCase() === trimEnd(slashes(b)).toLowerCase();
}

function withPins(file: ReposFile, root: string, pins: Pin[]): ReposFile {
  const i = file.findIndex((r) => samePath(r.root, root));
  if (pins.length === 0) return i < 0 ? file : file.filter((_, j) => j !== i);
  if (i < 0) return [...file, { root, pins }];
  return file.map((r, j) => (j === i ? { ...r, pins } : r));
}

/** Adds a pin at the end; pinning a path that is already pinned returns `file` itself. */
export function addPin(file: ReposFile, root: string, pin: Pin): ReposFile {
  const pins = pinsFor(file, root);
  if (pins.some((p) => samePin(p.path, pin.path))) return file;
  return withPins(file, root, [...pins, pin]);
}

/** Drops the pin at `index`, and the root's entry with its last pin. */
export function removePin(file: ReposFile, root: string, index: number): ReposFile {
  const pins = pinsFor(file, root);
  if (index < 0 || index >= pins.length) return file;
  return withPins(file, root, pins.filter((_, i) => i !== index));
}

/** An empty label clears the label. */
export function renamePin(file: ReposFile, root: string, index: number, label: string): ReposFile {
  const pins = pinsFor(file, root);
  if (index < 0 || index >= pins.length) return file;
  const text = label.trim();
  const next = pins.map((p, i) => {
    if (i !== index) return p;
    return text ? { path: p.path, label: text } : { path: p.path };
  });
  return withPins(file, root, next);
}

export function movePin(file: ReposFile, root: string, from: number, to: number): ReposFile {
  return withPins(file, root, moveItem(pinsFor(file, root), from, to));
}
