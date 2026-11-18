// The Sessions dialog's model: scope, search, age buckets, live merge, and the resume decision.
// No DOM.

import { resumeCommand } from './savedWorkspace';
import { sameOrInside, samePath, pathKey } from './pathCompare';
import { formatAge, lastFolder } from './dashboardModel';
import type { Session } from './sessions';
import type { PastSession } from './sessionHistoryApi';

/** A history row, with whether the session is running now and the pane it runs in. */
export interface HistoryRow extends PastSession {
  live: boolean;
  /** Pty id of the pane running the session; null when not live or running outside this app. */
  paneId: number | null;
}

/** What the "Only <repo>" checkbox filters to: the folder the dialog came from and its repo. */
export interface Scope {
  folder: string;
  repoRoot: string | null;
}

/** The terminal the dialog was opened from. */
export interface SessionsOrigin {
  paneId: number;
  cwd: string;
  /** Not busy. */
  idle: boolean;
  /** An agent session is bound to the pane. */
  agentBound: boolean;
  /** Main repo root holding `cwd`, resolved by the core; null outside git or when unresolved. */
  repoRoot: string | null;
}

export type ResumePlan =
  | { kind: 'focus'; paneId: number }
  | { kind: 'typeHere'; paneId: number; command: string }
  | { kind: 'newPane'; cwd: string; command: string; fellBack: boolean };

/** A stable identity for a scope, so a remembered checkbox state can tell when the scope changed. */
export function scopeKey(folder: string, repoRoot: string | null): string {
  return repoRoot ? `repo:${pathKey(repoRoot)}` : `folder:${pathKey(folder)}`;
}

/**
 * The scope for a terminal in `folder`, inferring the repo root from history since the terminal
 * carries none: the root of the session whose cwd is the longest ancestor of `folder` (the
 * worktree case, where `folder` may be a worktree with no root of its own), else the longest
 * session repo root containing `folder`. No match leaves a folder scope.
 */
export function scopeForFolder(folder: string, sessions: Pick<PastSession, 'cwd' | 'repoRoot'>[]): Scope {
  let root: string | null = null;
  let bestRank = -1;
  for (const s of sessions) {
    if (!s.repoRoot) continue;
    // Rank by path length within each rule; the cwd rule always outranks the repo root rule.
    const rank = sameOrInside(folder, s.cwd)
      ? 1_000_000 + s.cwd.length
      : sameOrInside(folder, s.repoRoot)
        ? s.repoRoot.length
        : -1;
    if (rank > bestRank) {
      bestRank = rank;
      root = s.repoRoot;
    }
  }
  return { folder, repoRoot: root };
}

/** The origin's scope: the core's repo root when it resolved one, else one inferred from history. */
export function scopeForOrigin(
  origin: Pick<SessionsOrigin, 'cwd' | 'repoRoot'>,
  sessions: Pick<PastSession, 'cwd' | 'repoRoot'>[],
): Scope {
  return origin.repoRoot ? { folder: origin.cwd, repoRoot: origin.repoRoot } : scopeForFolder(origin.cwd, sessions);
}

/** The name the checkbox shows: the repo's folder name, or the folder's own. */
export function scopeName(scope: Scope): string {
  return lastFolder(scope.repoRoot ?? scope.folder);
}

/**
 * Whether `session` belongs to `scope`. Two repo roots are compared when both sides have one, so a
 * worktree's sessions count as its main repo's. Otherwise the session's cwd must be the scope's
 * folder or inside it (a session started in a subfolder counts); a repo scope uses the repo root
 * there, since a session whose repo could not be resolved still lives under it.
 */
export function inScope(session: Pick<PastSession, 'cwd' | 'repoRoot'>, scope: Scope): boolean {
  if (scope.repoRoot && session.repoRoot) return samePath(session.repoRoot, scope.repoRoot);
  return sameOrInside(session.cwd, scope.repoRoot ?? scope.folder);
}

/** Every whitespace-separated word of `query` appears, in any order, in the title, prompts, or folder. */
export function matchesQuery(
  session: Pick<PastSession, 'title' | 'firstPrompt' | 'lastPrompt' | 'cwd'>,
  query: string,
): boolean {
  const words = query
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w.length > 0);
  if (words.length === 0) return true;
  const hay = [session.title, session.firstPrompt, session.lastPrompt, session.cwd]
    .filter((s): s is string => !!s)
    .join('\n')
    .toLowerCase();
  return words.every((w) => hay.includes(w));
}

/**
 * The distinct models across `sessions`, sorted, for the model filter. Claude Code writes
 * placeholder ids such as `<synthetic>` on locally generated replies; those name no real model.
 */
export function modelOptions(sessions: Pick<PastSession, 'model'>[]): string[] {
  const models = new Set<string>();
  for (const s of sessions) if (s.model && !s.model.startsWith('<')) models.add(s.model);
  return [...models].sort();
}

export const AGE_LABELS = ['Today', 'Yesterday', 'Previous 7 days', 'Previous 30 days', 'Older'] as const;
export type AgeLabel = (typeof AGE_LABELS)[number];

export interface AgeGroup<T> {
  label: AgeLabel;
  sessions: T[];
}

/**
 * Buckets by `updatedAt` on local calendar days, newest first within each bucket. Buckets run in
 * `AGE_LABELS` order and empty ones are omitted. "Previous 7 days" is everything from seven
 * calendar days ago up to the day before yesterday; "Previous 30 days" reaches back thirty days
 * the same way. A future timestamp (clock skew) counts as today.
 */
export function groupByAge<T extends { updatedAt: number }>(sessions: T[], now: number): AgeGroup<T>[] {
  const day = (back: number) => {
    const d = new Date(now);
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() - back);
    return d.getTime();
  };
  const cuts = [day(0), day(1), day(7), day(30)];
  const buckets: T[][] = AGE_LABELS.map(() => []);
  for (const s of [...sessions].sort((a, b) => b.updatedAt - a.updatedAt)) {
    const i = cuts.findIndex((cut) => s.updatedAt >= cut);
    buckets[i === -1 ? cuts.length : i].push(s);
  }
  return AGE_LABELS.flatMap((label, i) => (buckets[i].length > 0 ? [{ label, sessions: buckets[i] }] : []));
}

/** "now", "5m ago", "2h ago", "3d ago" for a row's `updatedAt`. */
export function relativeTime(updatedAt: number, now: number): string {
  const age = formatAge(Math.max(0, now - updatedAt));
  return age === 'now' ? age : `${age} ago`;
}

const liveKey = (agent: string, sessionId: string) => `${agent}:${sessionId}`;

/**
 * Marks the history rows whose session is in the roster, with the pane it runs in, and adds a row
 * for each live session history has not indexed yet (title from its name, else its folder's name).
 * A matched row takes the roster's newer activity time and permission mode. When the roster lists
 * a session twice, the entry bound to a pane wins.
 */
export function mergeLive(past: PastSession[], live: Session[]): HistoryRow[] {
  const byKey = new Map<string, Session>();
  for (const s of live) {
    const k = liveKey(s.agent, s.sessionId);
    const prev = byKey.get(k);
    if (!prev || (prev.paneId === null && s.paneId !== null)) byKey.set(k, s);
  }
  const seen = new Set<string>();
  const rows: HistoryRow[] = past.map((p) => {
    const k = liveKey(p.agent, p.sessionId);
    const s = byKey.get(k);
    seen.add(k);
    if (!s) return { ...p, live: false, paneId: null };
    return {
      ...p,
      live: true,
      paneId: s.paneId,
      updatedAt: Math.max(p.updatedAt, s.statusChangedAt),
      permissionMode: s.permissionMode ?? p.permissionMode,
    };
  });
  for (const [k, s] of byKey) {
    if (seen.has(k)) continue;
    rows.push({
      agent: s.agent,
      sessionId: s.sessionId,
      cwd: s.cwd,
      cwdExists: true,
      repoRoot: null,
      branch: null,
      title: s.name || lastFolder(s.cwd) || s.sessionId,
      firstPrompt: null,
      lastPrompt: null,
      startedAt: s.startedAt,
      updatedAt: s.statusChangedAt,
      permissionMode: s.permissionMode ?? null,
      model: null,
      live: true,
      paneId: s.paneId,
    });
  }
  return rows;
}

// Typed into a shell, so held to the characters real ids use (the same set a saved pane's id is).
const SAFE_SESSION_ID = /^[0-9A-Za-z-]{1,64}$/;

/**
 * The command that resumes `row`, as typed into a shell and as Copy resume command copies it; null
 * when the session id is not safe to type.
 */
export function resumeCommandText(row: HistoryRow): string | null {
  if (!SAFE_SESSION_ID.test(row.sessionId)) return null;
  return resumeCommand(row.sessionId, row.permissionMode ?? undefined, row.agent, row.model ?? undefined);
}

/**
 * What clicking a row does. A live session bound to a pane focuses it. Anything else resumes: the
 * command is typed into the origin terminal when that terminal is an idle shell already in the
 * session's folder (like a command pin), else a new terminal opens in the folder. A folder that no
 * longer exists falls back to the main repo root (`fellBack`), or stays as is when the session has
 * no repo. Null when the session id is not safe to type into a shell.
 */
export function resumePlan(row: HistoryRow, origin: SessionsOrigin | null): ResumePlan | null {
  if (row.live && row.paneId !== null) return { kind: 'focus', paneId: row.paneId };
  const command = resumeCommandText(row);
  if (command === null) return null;
  if (row.cwdExists && origin && origin.idle && !origin.agentBound && samePath(origin.cwd, row.cwd)) {
    return { kind: 'typeHere', paneId: origin.paneId, command };
  }
  if (!row.cwdExists && row.repoRoot) {
    return { kind: 'newPane', cwd: row.repoRoot, command, fellBack: true };
  }
  return { kind: 'newPane', cwd: row.cwd, command, fellBack: false };
}
