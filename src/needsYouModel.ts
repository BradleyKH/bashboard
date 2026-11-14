// The "Needs you" list: what the user should act on across terminals, Ship, and agent usage
// limits (docs/design/dashboard.md section 4.28). Pure, no DOM.
import type { RunStatus } from './forgeApi';
import type { DashboardItem } from './shipOverviewModel';
import { itemStatus, itemText, itemTitle, repoLabel, type SignInLine } from './shipSectionModel';

export interface TerminalItem {
  kind: 'terminal';
  paneId: string;
  tabId: string;
  title: string;
  status: 'waiting' | 'done' | 'failed';
  /** What the terminal is waiting on, or how it finished; empty when unknown. */
  reason: string;
  /** Epoch ms the status began. */
  since: number;
}

export interface ShipItem {
  kind: 'ship';
  item: DashboardItem;
  /** Epoch ms; 0 when the forge gave no usable time. */
  since: number;
}

export interface SignInItem extends SignInLine {
  kind: 'signIn';
  /** Epoch ms the row first appeared, which the store stamps; the source carries no time of its own. */
  since?: number;
}

/** One rate-limit window of an agent, as the store receives it. */
export interface UsageWindow {
  /** The agent id, so a window's identity survives a rename of its display name. */
  agent: string;
  agentName: string;
  /** "5-hour" or "weekly". */
  label: string;
  /** 0 to 100. */
  percent: number;
  /** Epoch ms the window resets; null when the agent does not say, so it never expires. */
  resetsAt: number | null;
}

export interface UsageItem extends UsageWindow {
  kind: 'usage';
  /** Epoch ms the row first appeared, which the store stamps; the source carries no time of its own. */
  since?: number;
}

export type NeedsItem = TerminalItem | ShipItem | SignInItem | UsageItem;

/** 0 is most urgent. */
export type NeedsGroup = 0 | 1 | 2;

/** Rows shown before "+ N more". */
export const ROW_CAP = 6;

/** Hide and stable keys join an item's fields with FIELD, and put the state version after VERSION. */
const FIELD = '\u001f';
const VERSION = '\u001e';

/** Blocked (0): a waiting terminal. Broken (1): a failure or an exhausted limit. Ready (2): the rest. */
export function groupOf(item: NeedsItem): NeedsGroup {
  switch (item.kind) {
    case 'terminal':
      return item.status === 'waiting' ? 0 : item.status === 'failed' ? 1 : 2;
    case 'ship':
      return item.item.kind === 'branch' || item.item.kind === 'mine' ? 1 : 2;
    case 'usage':
      return item.percent >= 100 ? 1 : 2;
    case 'signIn':
      return 2;
  }
}

/** Within a group: terminals and Ship by age, then usage, then the sign-in row. */
function tier(item: NeedsItem): number {
  return item.kind === 'usage' ? 1 : item.kind === 'signIn' ? 2 : 0;
}

function sortKey(item: NeedsItem): number {
  if (item.kind === 'terminal' || item.kind === 'ship') return item.since;
  // An unknown reset sorts after the dated ones.
  return item.kind === 'usage' ? (item.resetsAt ?? Number.MAX_SAFE_INTEGER) : 0;
}

/** By group, then oldest first (usage by soonest reset, the sign-in row last); ties keep input order. */
export function orderItems(items: readonly NeedsItem[]): NeedsItem[] {
  return items
    .map((item, index) => ({ item, index, group: groupOf(item), tier: tier(item), key: sortKey(item) }))
    .sort((a, b) => a.group - b.group || a.tier - b.tier || a.key - b.key || a.index - b.index)
    .map((e) => e.item);
}

/**
 * The first `ROW_CAP` items, or all when `expanded`; `more` counts those left behind, and
 * `overflowing` says whether the list is long enough for a "Show fewer" once expanded.
 */
export function visibleRows(
  items: readonly NeedsItem[],
  expanded: boolean,
): { shown: NeedsItem[]; more: number; overflowing: boolean } {
  const overflowing = items.length > ROW_CAP;
  if (expanded || !overflowing) return { shown: [...items], more: 0, overflowing };
  return { shown: items.slice(0, ROW_CAP), more: items.length - ROW_CAP, overflowing };
}

/** Whole percent for display; floored so "100%" never shows for a window still under it. */
const shownPercent = (p: number): number => Math.floor(p);

/** The pane title, `owner/name`, the host, or the agent name. */
export function subject(item: NeedsItem): string {
  switch (item.kind) {
    case 'terminal':
      return item.title;
    case 'ship':
      return repoLabel(item.item.repo);
    case 'usage':
      return item.agentName;
    case 'signIn':
      return item.host ?? 'Ship';
  }
}

export function phrase(item: NeedsItem): string {
  switch (item.kind) {
    case 'terminal':
      if (item.status === 'done') return 'finished';
      if (item.status === 'failed') return 'session failed';
      return /permission/i.test(item.reason) ? 'needs permission' : 'asked a question';
    case 'ship':
      return itemText(item.item);
    case 'usage':
      return item.percent >= 100 ? `${item.label} limit reached` : `${item.label} limit ${shownPercent(item.percent)}%`;
    case 'signIn': {
      // The host is the row's subject, so the phrase drops it.
      const text = item.host ? item.text.replace(` to ${item.host}`, '') : item.text;
      return text.charAt(0).toLowerCase() + text.slice(1);
    }
  }
}

/** The row's `title` attribute: detail lines joined by newlines. */
export function tooltip(item: NeedsItem): string {
  switch (item.kind) {
    case 'terminal':
      return item.reason || `${item.title} ${phrase(item)}`;
    case 'ship': {
      const d = item.item;
      const lines = d.kind === 'branch' ? [d.run.title, d.run.name] : [d.pull.title];
      return [...new Set(lines.filter(Boolean))].join('\n') || itemTitle(d);
    }
    case 'usage': {
      const head = `${item.label} limit ${shownPercent(item.percent)}%`;
      if (item.resetsAt === null) return head;
      const when = new Date(item.resetsAt).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' });
      return `${head}\nResets ${when}`;
    }
    case 'signIn':
      return item.title;
  }
}

/** The `RunStatus` whose Ship icon the row wears; a usage row draws its own ring meter instead. */
export function statusIcon(item: NeedsItem): RunStatus {
  switch (item.kind) {
    case 'terminal':
      return item.status === 'waiting' ? 'waiting' : item.status === 'failed' ? 'failure' : 'success';
    case 'ship':
      return itemStatus(item.item);
    default:
      return 'other';
  }
}

/** "now", "4m", "3h", "2d"; empty when the time is unknown (0). */
export function ageText(since: number, now: number): string {
  if (since <= 0) return '';
  const m = Math.floor((now - since) / 60_000);
  if (m < 1) return 'now';
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}h` : `${Math.floor(h / 24)}d`;
}

/** The row's age text; usage and sign-in rows age from when the store first saw them, empty until it does. */
export function ageOf(item: NeedsItem, now: number): string {
  return ageText(item.since ?? 0, now);
}

/** Identity (what the row is about) and version (the state of it a hide was made against). */
function keyParts(item: Exclude<NeedsItem, TerminalItem>): { identity: string; version: string } {
  switch (item.kind) {
    case 'ship': {
      const d = item.item;
      return d.kind === 'branch'
        ? { identity: ['branch', d.target, d.branch].join(FIELD), version: d.run.id }
        : { identity: [d.kind, d.target, String(d.pull.number)].join(FIELD), version: d.pull.updatedAt };
    }
    case 'usage':
      return { identity: ['usage', item.agent, item.label].join(FIELD), version: String(item.resetsAt ?? '') };
    case 'signIn':
      return { identity: ['signIn', item.host ?? ''].join(FIELD), version: item.text };
  }
}

/** Null for a terminal (it clears when its state changes); else identity plus state version. */
export function hideKey(item: NeedsItem): string | null {
  if (item.kind === 'terminal') return null;
  const { identity, version } = keyParts(item);
  return identity + VERSION + version;
}

/** The part of a hide key that names what the row is about, without the state version. */
export const hideIdentity = (key: string): string => key.split(VERSION, 1)[0];

/** The Ship target (clone path or `remote:` id) a branch or pull hide key belongs to; null for sign-in and usage keys. */
export function hideTarget(key: string): string | null {
  const [kind, target] = hideIdentity(key).split(FIELD);
  return kind === 'branch' || kind === 'review' || kind === 'mine' || kind === 'approved' ? (target ?? null) : null;
}

/** Which feed a hide key came from, so a feed's hides are pruned only once that feed has loaded. */
export function hideSource(key: string): 'ship' | 'usage' {
  return key.split(FIELD, 1)[0] === 'usage' ? 'usage' : 'ship';
}

export function applyHides(items: readonly NeedsItem[], hides: ReadonlySet<string>): NeedsItem[] {
  return items.filter((item) => {
    const key = hideKey(item);
    return key === null || !hides.has(key);
  });
}

/** Drops hide keys whose identity matches no current item, so the set cannot grow forever. */
export function pruneHides(hides: ReadonlySet<string>, items: readonly NeedsItem[]): Set<string> {
  const live = new Set<string>();
  for (const item of items) {
    const key = hideKey(item);
    if (key !== null) live.add(hideIdentity(key));
  }
  return new Set([...hides].filter((key) => live.has(hideIdentity(key))));
}

/**
 * Identifies an item and the group it is in: a new failure or a limit reaching 100% is a new key,
 * so Ready to Broken counts as entering.
 */
export function stableKey(item: NeedsItem): string {
  if (item.kind === 'terminal') return ['terminal', item.paneId].join(FIELD);
  return `${groupOf(item)}${FIELD}${hideKey(item)}`;
}

/** Non-terminal items now Blocked or Broken whose stable key was not among `prevKeys`. */
export function enteredUrgent(prevKeys: ReadonlySet<string>, next: readonly NeedsItem[]): NeedsItem[] {
  return next.filter((item) => item.kind !== 'terminal' && groupOf(item) <= 1 && !prevKeys.has(stableKey(item)));
}

/**
 * Windows at or past `usagePercent` become items; a window whose reset time has passed is
 * dropped, since its figure no longer holds.
 */
export function usageItems(windows: readonly UsageWindow[], usagePercent: number, now: number): UsageItem[] {
  return windows
    .filter((w) => w.percent >= usagePercent && (w.resetsAt === null || w.resetsAt > now))
    .map((w) => ({ kind: 'usage', ...w }));
}
