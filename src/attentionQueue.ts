import type { TerminalStatus } from './terminalStatus';

export interface AttentionEntry {
  paneId: string;
  tabId: string;
  status: TerminalStatus;
  /** `statusChangedAt` for `waiting`; the mark time for `done` and `failed`. */
  changedAt: number;
  /** True when an agent session (Claude Code, Codex, Copilot) is bound to the pane. */
  agent: boolean;
}

/**
 * Pane ids that need the user: every `waiting` entry, then every `done` or `failed` entry, each
 * group oldest first. Ties fall to the tab's position in `tabOrder`, then to input order.
 */
export function attentionQueue(entries: AttentionEntry[], tabOrder: string[]): string[] {
  const tabIndex = (tabId: string): number => {
    const i = tabOrder.indexOf(tabId);
    return i < 0 ? tabOrder.length : i;
  };
  const ranked = entries
    .map((entry, index) => ({ entry, index }))
    .filter(({ entry }) => entry.status === 'waiting' || entry.status === 'done' || entry.status === 'failed')
    .map((item) => ({ ...item, group: item.entry.status === 'waiting' ? 0 : 1 }));
  ranked.sort(
    (a, b) =>
      a.group - b.group ||
      a.entry.changedAt - b.entry.changedAt ||
      tabIndex(a.entry.tabId) - tabIndex(b.entry.tabId) ||
      a.index - b.index,
  );
  return ranked.map(({ entry }) => entry.paneId);
}

/**
 * The pane after `focusedId` in the queue (wrapping), or the first when it is not queued. With
 * nothing queued it cycles the agent terminals instead, in input order, so the chord still walks
 * the AI sessions; null when there are none.
 */
export function nextAttention(
  entries: AttentionEntry[],
  tabOrder: string[],
  focusedId: string,
): string | null {
  const queue = attentionQueue(entries, tabOrder);
  const ring = queue.length > 0 ? queue : entries.filter((entry) => entry.agent).map((entry) => entry.paneId);
  if (ring.length === 0) return null;
  const at = ring.indexOf(focusedId);
  return at < 0 ? ring[0] : ring[(at + 1) % ring.length];
}
