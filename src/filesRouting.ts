/** Where a Files request goes, and the path text it produces (docs/design.md section 4.12). */

import { samePath } from './favorites';
import { relativeWithin } from './filesModel';

export interface FilesPaneInfo {
  paneId: string;
  root: string;
  folder: string;
}

export interface FilesRequest {
  root: string;
  folder: string;
  /** Absolute path of the entry to select. */
  select?: string;
}

/**
 * Reuse a Files pane already showing the request's repo (preferring one already in that folder),
 * else open a new one.
 */
export function routeFilesRequest(
  panes: readonly FilesPaneInfo[],
  req: FilesRequest,
): { reuse: string } | { open: true } {
  const sameRepo = panes.filter((p) => samePath(p.root, req.root));
  const hit = sameRepo.find((p) => samePath(p.folder, req.folder)) ?? sameRepo[0];
  return hit ? { reuse: hit.paneId } : { open: true };
}

function parentOf(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, '');
  const idx = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
  if (idx < 0) return trimmed;
  const head = trimmed.slice(0, idx);
  if (head === '') return '/';
  return /^[A-Za-z]:$/.test(head) ? `${head}${path.includes('\\') ? '\\' : '/'}` : head;
}

/** A folder pin shows that folder; a file pin shows its folder and selects the file. */
export function pinTarget(
  _root: string,
  absolutePath: string,
  isDir: boolean,
): { folder: string; select?: string } {
  return isDir ? { folder: absolutePath } : { folder: parentOf(absolutePath), select: absolutePath };
}

/** Forward-slash path relative to the repo root, or the absolute path when outside it. */
export function insertPathText(root: string, path: string): string {
  const rel = relativeWithin(root, path);
  if (rel === null) return path;
  return rel === '' ? '.' : rel;
}

/** The target terminal's shell profile id, and whether Claude Code is running in it. */
export interface PathProfile {
  shell: string;
  claudeCode: boolean;
}

export function pathProfileFor(
  profileId: string | undefined,
  fallbackId: string,
  claudeCode: boolean,
): PathProfile {
  return { shell: profileId ?? fallbackId, claudeCode };
}

const SAFE_PATH = /^[A-Za-z0-9._\-/:@+]+$/;

function absoluteText(path: string, profile: PathProfile): string {
  let p = path.replace(/\\/g, '/');
  const root = /^[A-Za-z]:\/*$/.test(p) || /^\/+$/.test(p);
  p = root ? p.replace(/\/+$/, '/') : p.replace(/\/+$/, '');
  return backslashesFor(p, profile);
}

// Command Prompt built-ins reject forward slashes in paths; Claude Code running under cmd
// takes them fine.
function backslashesFor(text: string, profile: PathProfile): string {
  return profile.shell === 'cmd' && !profile.claudeCode ? text.replace(/\//g, '\\') : text;
}

function quoteFor(text: string, shell: string): string {
  if (SAFE_PATH.test(text.replace(/\\/g, '/'))) return text;
  switch (shell) {
    case 'pwsh':
    case 'powershell':
      return `'${text.replace(/'/g, "''")}'`;
    case 'cmd':
      return `"${text}"`;
    default:
      return `'${text.replace(/'/g, "'\\''")}'`;
  }
}

/**
 * Text for inserting paths into a terminal (docs/design.md section 4.4). Paths inside
 * `baseRoot` are relative; the caller picks the base: a drop passes the
 * target terminal's repo, Insert path the source pane's root. Slashes (backslashes for Command
 * Prompt without Claude Code, forward slashes otherwise) and quoting follow `profile`, which is
 * always the target terminal's.
 */
export function pathInsertText(
  paths: readonly string[],
  baseRoot: string | null,
  profile: PathProfile,
): string {
  if (paths.length === 0) return '';
  const parts = paths.map((path) => {
    const rel = baseRoot === null ? null : relativeWithin(baseRoot, path);
    const text = rel === null ? absoluteText(path, profile) : rel === '' ? '.' : backslashesFor(rel, profile);
    return quoteFor(text, profile.shell);
  });
  return `${parts.join(' ')} `;
}
