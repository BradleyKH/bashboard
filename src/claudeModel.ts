// The Claude dashboard section's pure model (docs/design.md section 4.6): token text, the context
// bar's scale and color bands, model display names, and merging the Panes cards, the roster,
// transcript contexts, and process figures into rows.

import type { TerminalCard, TerminalStatus } from './dashboardModel';
import type { Session } from './sessions';
import { formatBytes } from './systemModel';

/** The newest model and context of one session's transcript; mirrors `ClaudeContext` in `transcript.rs`. */
export interface ClaudeContext {
  sessionId: string;
  model: string | null;
  contextTokens: number | null;
}

/** Memory and CPU summed over a root pid's process tree; mirrors `ProcFigures` in `system.rs`. */
export interface ProcFigures {
  pid: number;
  memoryBytes: number;
  /** Percent of the whole machine; null until the core has two refreshes close together. */
  cpuPercent: number | null;
}

export type ContextBand = 'ok' | 'warn' | 'error';

export interface ClaudeRow {
  paneId: string;
  sessionId: string;
  title: string;
  /** The pane's folder; empty when it has none. */
  path: string;
  status: TerminalStatus;
  /** Display name, or the raw id for a model the app does not know. */
  model: string | null;
  tokens: number | null;
  tokensText: string;
  scale: number;
  fraction: number;
  band: ContextBand;
  processText: string | null;
}

export const CONTEXT_SMALL = 200_000;
export const CONTEXT_LARGE = 1_000_000;

// Truncating rather than rounding keeps a count just under a boundary from printing as the next
// tier's value ("10.0k", "1000k").
export function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 10_000) return `${(Math.floor(n / 100) / 10).toFixed(1)}k`;
  if (n < 1_000_000) return `${Math.floor(n / 1000)}k`;
  return `${Math.floor(n / 100_000) / 10}M`;
}

/**
 * The transcript names the model but not its context window, so the bar measures against 200k
 * until the count passes it, then 1M for the rest of the session (`wasLarge`).
 */
export function contextScale(tokens: number, wasLarge: boolean): number {
  return wasLarge || tokens > CONTEXT_SMALL ? CONTEXT_LARGE : CONTEXT_SMALL;
}

export function contextBand(fraction: number): ContextBand {
  if (fraction >= 0.8) return 'error';
  if (fraction >= 0.5) return 'warn';
  return 'ok';
}

const FAMILIES: Record<string, string> = {
  opus: 'Opus',
  sonnet: 'Sonnet',
  haiku: 'Haiku',
  fable: 'Fable',
};

const FAMILY_FIRST = /^claude-(opus|sonnet|haiku|fable)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?$/;
const VERSION_FIRST = /^claude-(\d+)(?:-(\d{1,2}))?-(opus|sonnet|haiku|fable)(?:-\d{8})?$/;

/** "claude-opus-5-5" and "claude-3-5-sonnet-20241022" to "Opus 5.5" and "Sonnet 3.5"; anything else unchanged. */
export function modelDisplayName(id: string): string {
  const bare = id.endsWith('[1m]') ? id.slice(0, -4) : id;
  let family: string;
  let major: string;
  let minor: string | undefined;
  const a = FAMILY_FIRST.exec(bare);
  const b = a ? null : VERSION_FIRST.exec(bare);
  if (a) [, family, major, minor] = a;
  else if (b) [, major, minor, family] = b;
  else return id;
  return `${FAMILIES[family]} ${minor === undefined ? major : `${major}.${minor}`}`;
}

/** "1.4 GB, 12%", with "-" for the CPU until the core reports it. */
export function formatProcess(fig: ProcFigures): string {
  const cpu = fig.cpuPercent === null ? '-' : `${Math.round(fig.cpuPercent)}%`;
  return `${formatBytes(fig.memoryBytes)}, ${cpu}`;
}

/**
 * One row per card bound to a Claude session, in card order. `procs` is keyed by the roster's
 * pid; `largeSessions` holds sessions whose context has passed 200k (see `nextLargeSessions`).
 */
export function claudeRows(
  cards: readonly TerminalCard[],
  sessions: readonly Session[],
  contexts: ReadonlyMap<string, ClaudeContext>,
  procs: ReadonlyMap<number, ProcFigures>,
  largeSessions: ReadonlySet<string>,
): ClaudeRow[] {
  const pidOf = new Map(sessions.map((s) => [s.sessionId, s.pid]));
  const rows: ClaudeRow[] = [];
  for (const card of cards) {
    const sessionId = card.sessionId;
    if (sessionId === null) continue;
    const ctx = contexts.get(sessionId);
    const tokens = ctx?.contextTokens ?? null;
    const scale = contextScale(tokens ?? 0, largeSessions.has(sessionId));
    const fraction = tokens === null ? 0 : Math.min(1, tokens / scale);
    const pid = pidOf.get(sessionId);
    const fig = pid === undefined ? undefined : procs.get(pid);
    rows.push({
      paneId: card.paneId,
      sessionId,
      title: card.title,
      path: card.path,
      status: card.status,
      model: ctx?.model == null ? null : modelDisplayName(ctx.model),
      tokens,
      tokensText: tokens === null ? '' : formatTokens(tokens),
      scale,
      fraction,
      band: contextBand(fraction),
      processText: fig ? formatProcess(fig) : null,
    });
  }
  return rows;
}

/** `prev` grown by any row whose context passed 200k; `prev` itself when nothing was added. */
export function nextLargeSessions(prev: ReadonlySet<string>, rows: readonly ClaudeRow[]): ReadonlySet<string> {
  const added = rows.filter((r) => r.tokens !== null && r.tokens > CONTEXT_SMALL && !prev.has(r.sessionId));
  if (added.length === 0) return prev;
  return new Set([...prev, ...added.map((r) => r.sessionId)]);
}
