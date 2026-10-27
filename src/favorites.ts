import { lastFolder } from './dashboardModel';
import { parseProfileId } from './profiles';
import type { Session } from './sessions';

/** favorites.json (docs/design.md sections 3.7 and 7), in display order. */
export interface Favorite {
  label: string;
  path: string;
  /** Shell profile id; absent means the default profile. */
  profile?: string;
}

export function parseFavorites(raw: unknown): Favorite[] {
  if (!Array.isArray(raw)) return [];
  const out: Favorite[] = [];
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) continue;
    const { label, path, profile } = item as Record<string, unknown>;
    if (typeof path !== 'string' || path.trim() === '') continue;
    const text = typeof label === 'string' ? label.trim() : '';
    const profileId = parseProfileId(profile);
    out.push({ label: text || lastFolder(path), path, ...(profileId ? { profile: profileId } : {}) });
  }
  return out;
}

/**
 * The path a favorite's row shows under its label: the parent folder when the label is still the
 * folder's own name, which would otherwise appear twice, and the whole path once it is renamed.
 */
export function favoritePathText(favorite: Favorite): string {
  const trimmed = favorite.path.replace(/[\\/]+$/, '');
  if (favorite.label !== lastFolder(trimmed)) return favorite.path;
  const cut = Math.max(trimmed.lastIndexOf('\\'), trimmed.lastIndexOf('/'));
  if (cut <= 0) return favorite.path;
  const parent = trimmed.slice(0, cut);
  // A bare C: means the current folder on drive C, not its root.
  return /^[A-Za-z]:$/.test(parent) ? trimmed.slice(0, cut + 1) : parent;
}

function normalize(p: string): string {
  return p.replace(/[\\/]+/g, '/').replace(/\/+$/, '').toLowerCase();
}

/** Case-insensitive; `/` and `\` alike; trailing separators ignored. */
export function samePath(a: string, b: string): boolean {
  return normalize(a) === normalize(b);
}

/** Session folders, most recently active first, without duplicates or favorites. */
export function recentFolders(sessions: Session[], favorites: Favorite[], limit = 5): string[] {
  const sorted = [...sessions].sort((a, b) => b.statusChangedAt - a.statusChangedAt);
  const out: string[] = [];
  for (const s of sorted) {
    if (out.length >= limit) break;
    if (!s.cwd) continue;
    if (favorites.some((f) => samePath(f.path, s.cwd))) continue;
    if (out.some((p) => samePath(p, s.cwd))) continue;
    out.push(s.cwd);
  }
  return out;
}

/** Copy of `list` with the item at `from` moved to index `to`; unchanged for bad indices. */
export function moveItem<T>(list: T[], from: number, to: number): T[] {
  const out = [...list];
  if (from < 0 || from >= out.length || to < 0 || to >= out.length) return out;
  const [item] = out.splice(from, 1);
  out.splice(to, 0, item);
  return out;
}
