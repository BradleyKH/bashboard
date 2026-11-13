import type { Container } from './containers';
import type { TerminalStatus } from './terminalStatus';
import { sameOrInside } from './worktreeModel';

/** A terminal pane as Fix with agent weighs it. */
export interface AgentTerminal {
  paneId: string;
  /** The shell's working folder, when known. */
  folder: string | null;
  /** A coding agent session is bound to the pane. */
  agent: boolean;
  status: TerminalStatus;
  /** Position in focus history, 0 being the most recent; null for a pane never focused. */
  recency: number | null;
}

/** Log lines a container prompt carries, matching the failure report's excerpt. */
export const CONTAINER_LOG_LINES = 150;

/**
 * The terminal a fix prompt goes to: the most recently focused one in `root` running an agent
 * that is not busy, so the paste cannot land in the middle of a turn or a permission prompt.
 */
export function pickAgentPane(panes: readonly AgentTerminal[], root: string): string | null {
  const ready = panes.filter(
    (p) => p.agent && (p.status === 'idle' || p.status === 'done') && p.folder !== null && sameOrInside(p.folder, root),
  );
  if (ready.length === 0) return null;
  const rank = (p: AgentTerminal) => p.recency ?? Number.MAX_SAFE_INTEGER;
  return ready.reduce((best, p) => (rank(p) < rank(best) ? p : best)).paneId;
}

/** A prompt asking the agent to find why a container is failing, from the logs panel's cleaned text. */
export function containerFixPrompt(
  container: Pick<Container, 'name' | 'image' | 'project' | 'service' | 'engine'>,
  logText: string,
): string {
  const trimmed = logText.replace(/\n+$/, '');
  const lines = trimmed === '' ? [] : trimmed.split('\n');
  const tail = lines.slice(-CONTAINER_LOG_LINES);
  const header = [`The ${container.engine} container ${container.name} (image ${container.image}) is misbehaving.`];
  if (container.project) {
    header.push(`It is the ${container.service ?? 'unnamed'} service of the compose project ${container.project}.`);
  }
  const ask = 'Find the cause in this repo and fix it.';
  if (lines.length === 0) return [...header, '', 'Its log is empty.', '', ask].join('\n');
  const shown = tail.length < lines.length ? `The last ${tail.length} lines of its log:` : 'Its log:';
  return [...header, '', shown, '', '```', ...tail, '```', '', ask].join('\n');
}
