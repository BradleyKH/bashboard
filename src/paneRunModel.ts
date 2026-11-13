// Binding a new CI run to the terminal pane whose push likely started it
// (docs/design/ship.md section 4.26). Pure, no DOM.
import type { Run, RunStatus } from './forgeApi';
import { statusInfo } from './shipModel';

/** The run a pane shows on its session card. */
export interface PaneRun {
  name: string;
  number: number | null;
  status: RunStatus;
  url: string;
}

/** Slack for clock skew between this machine and the host, and for a run created just before the change was seen. */
const FIRST_READ_SLACK_MS = 2 * 60 * 1000;

/**
 * Runs in `next` that this key has not shown before. With no previous list (the key's first read)
 * the list holds the branch's history, so only a run created at or after the triggering change
 * counts, and one whose `createdAt` does not parse is treated as old rather than guessed at.
 */
export function newRuns(prev: readonly Run[] | null, next: readonly Run[], triggerAt: number): Run[] {
  if (prev === null) {
    const since = triggerAt - FIRST_READ_SLACK_MS;
    return next.filter((r) => Date.parse(r.createdAt) >= since);
  }
  const known = new Set(prev.map((r) => r.id));
  return next.filter((r) => !known.has(r.id));
}

/** Queued, running, or waiting on a person: the run has not reached a final status. */
export function isRunActive(run: Run): boolean {
  return run.status === 'queued' || run.status === 'running' || run.status === 'waiting';
}

/** The pane mark a bound run's move from `prev` to `next` earns; only a success or failure counts. */
export function runFinish(prev: Run, next: Run): 'done' | 'failed' | null {
  if (!isRunActive(prev) || isRunActive(next)) return null;
  if (next.status === 'success') return 'done';
  if (next.status === 'failure') return 'failed';
  return null;
}

export function paneRunOf(run: Run): PaneRun {
  return { name: run.name || run.title || 'CI', number: run.number, status: run.status, url: run.webUrl };
}

export function runChip(run: PaneRun): { text: string; title: string; modifier: string } {
  const info = statusInfo(run.status);
  const number = run.number === null ? '' : ` #${run.number}`;
  const title = run.url ? `${run.name}\n${run.url}` : run.name;
  return { text: `${run.name}${number} ${info.label.toLowerCase()}`, title, modifier: info.modifier };
}
