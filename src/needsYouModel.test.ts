import { describe, expect, it } from 'vitest';
import type { PullRequest, Run } from './forgeApi';
import {
  ROW_CAP,
  ageOf,
  ageText,
  applyHides,
  enteredUrgent,
  groupOf,
  hideIdentity,
  hideKey,
  hideSource,
  hideTarget,
  orderItems,
  phrase,
  pruneHides,
  stableKey,
  statusIcon,
  subject,
  tooltip,
  usageItems,
  visibleRows,
  type NeedsItem,
  type ShipItem,
  type SignInItem,
  type TerminalItem,
  type UsageItem,
  type UsageWindow,
} from './needsYouModel';

const MIN = 60_000;
const NOW = Date.parse('2026-11-13T12:00:00Z');

const term = (over: Partial<TerminalItem> = {}): TerminalItem => ({
  kind: 'terminal',
  paneId: 'p1',
  tabId: 't1',
  title: 'api-server',
  status: 'waiting',
  reason: '',
  since: NOW - 4 * MIN,
  ...over,
});

const run = (over: Partial<Run> = {}): Run => ({ id: 'r1', title: 'Deploy', name: 'Build', status: 'failure', ...over }) as Run;
const pull = (over: Partial<PullRequest> = {}): PullRequest =>
  ({ number: 12, title: 'Add export', updatedAt: '2026-11-13T10:00:00Z', reviewers: [], ...over }) as PullRequest;
const base = { target: 'remote:bitbucket.org/keysys/kweb', repo: 'bitbucket.org/keysys/kweb', since: 0 };

const branchItem = (over: Partial<ShipItem> = {}, r: Run = run(), branch = 'main'): ShipItem => ({
  kind: 'ship',
  since: NOW - 10 * MIN,
  item: { ...base, kind: 'branch', tab: 'pipelines', branch, run: r },
  ...over,
});
const pullItem = (kind: 'review' | 'mine' | 'approved', p: PullRequest = pull(), since = NOW - 30 * MIN): ShipItem => ({
  kind: 'ship',
  since,
  item: { ...base, kind, tab: 'pulls', pull: p },
});
const signIn = (over: Partial<SignInItem> = {}): SignInItem => ({
  kind: 'signIn',
  text: 'Sign in to bitbucket.org for 3 pinned repos',
  title: 'Open the Accounts tab',
  host: 'bitbucket.org',
  openTokenForm: true,
  ...over,
});
const usage = (over: Partial<UsageItem> = {}): UsageItem => ({
  kind: 'usage',
  agent: 'claude',
  agentName: 'Claude',
  label: '5-hour',
  percent: 84,
  resetsAt: NOW + 60 * MIN,
  ...over,
});

describe('groupOf', () => {
  it('puts a waiting terminal in Blocked', () => {
    expect(groupOf(term({ status: 'waiting' }))).toBe(0);
  });

  it('puts failures and exhausted limits in Broken', () => {
    expect(groupOf(term({ status: 'failed' }))).toBe(1);
    expect(groupOf(branchItem())).toBe(1);
    expect(groupOf(pullItem('mine'))).toBe(1);
    expect(groupOf(usage({ percent: 100 }))).toBe(1);
  });

  it('puts finished work, approvals, review requests, a near limit, and sign-in in Ready', () => {
    expect(groupOf(term({ status: 'done' }))).toBe(2);
    expect(groupOf(pullItem('approved'))).toBe(2);
    expect(groupOf(pullItem('review'))).toBe(2);
    expect(groupOf(usage({ percent: 99 }))).toBe(2);
    expect(groupOf(signIn())).toBe(2);
  });
});

describe('orderItems', () => {
  it('orders by group, then oldest first', () => {
    const doneOld = term({ paneId: 'd1', status: 'done', since: NOW - 50 * MIN });
    const doneNew = term({ paneId: 'd2', status: 'done', since: NOW - 2 * MIN });
    const failedTerm = term({ paneId: 'f1', status: 'failed', since: NOW - 6 * MIN });
    const failedBranch = branchItem({ since: NOW - 12 * MIN });
    const waitNew = term({ paneId: 'w2', since: NOW - 1 * MIN });
    const waitOld = term({ paneId: 'w1', since: NOW - 9 * MIN });
    const review = pullItem('review', pull(), NOW - 180 * MIN);
    const ordered = orderItems([doneNew, review, failedTerm, waitNew, doneOld, failedBranch, waitOld]);
    expect(ordered).toEqual([waitOld, waitNew, failedBranch, failedTerm, review, doneOld, doneNew]);
  });

  it('sorts usage by soonest reset after the aged rows, and sign-in last', () => {
    const later = usage({ agent: 'codex', agentName: 'Codex', percent: 90, resetsAt: NOW + 120 * MIN });
    const sooner = usage({ resetsAt: NOW + 30 * MIN });
    const open = usage({ agent: 'copilot', percent: 85, resetsAt: null });
    const done = term({ status: 'done', since: NOW - MIN });
    const si = signIn();
    expect(orderItems([si, later, open, sooner, done])).toEqual([done, sooner, later, open, si]);
  });

  it('keeps input order on ties and does not mutate its input', () => {
    const a = term({ paneId: 'a', since: 5 });
    const b = term({ paneId: 'b', since: 5 });
    const input = [b, a];
    expect(orderItems(input)).toEqual([b, a]);
    expect(input).toEqual([b, a]);
  });
});

describe('visibleRows', () => {
  const rows = (n: number): NeedsItem[] => Array.from({ length: n }, (_, i) => term({ paneId: `p${i}` }));

  it('shows everything at or under the cap', () => {
    expect(visibleRows(rows(ROW_CAP), false)).toMatchObject({ more: 0, overflowing: false });
    expect(visibleRows(rows(ROW_CAP), false).shown).toHaveLength(ROW_CAP);
  });

  it('caps at six with an overflow count', () => {
    const v = visibleRows(rows(9), false);
    expect(v.shown).toHaveLength(6);
    expect(v.more).toBe(3);
    expect(v.overflowing).toBe(true);
  });

  it('shows all when expanded, still flagged overflowing so it can collapse', () => {
    const v = visibleRows(rows(9), true);
    expect(v.shown).toHaveLength(9);
    expect(v.more).toBe(0);
    expect(v.overflowing).toBe(true);
  });

  it('handles an empty list', () => {
    expect(visibleRows([], false)).toEqual({ shown: [], more: 0, overflowing: false });
  });
});

describe('row text', () => {
  it('names the subject of each kind', () => {
    expect(subject(term())).toBe('api-server');
    expect(subject(branchItem())).toBe('keysys/kweb');
    expect(subject(usage())).toBe('Claude');
    expect(subject(signIn())).toBe('bitbucket.org');
    expect(subject(signIn({ host: null }))).toBe('Ship');
  });

  it('phrases terminals', () => {
    expect(phrase(term({ reason: 'Claude needs your permission to use Bash' }))).toBe('needs permission');
    expect(phrase(term({ reason: 'Which date format?' }))).toBe('asked a question');
    expect(phrase(term({ reason: '' }))).toBe('asked a question');
    expect(phrase(term({ status: 'done' }))).toBe('finished');
    expect(phrase(term({ status: 'failed' }))).toBe('session failed');
  });

  it('phrases Ship items through the Ship section text', () => {
    expect(phrase(branchItem())).toBe('main failed');
    expect(phrase(pullItem('review'))).toBe('#12 needs your review');
    expect(phrase(pullItem('mine', pull({ checks: 'failure' })))).toBe('#12 checks failing');
  });

  it('phrases usage, with 100 as reached and a fraction floored', () => {
    expect(phrase(usage())).toBe('5-hour limit 84%');
    expect(phrase(usage({ percent: 84.9 }))).toBe('5-hour limit 84%');
    expect(phrase(usage({ percent: 99.6 }))).toBe('5-hour limit 99%');
    expect(phrase(usage({ label: 'weekly', percent: 100 }))).toBe('weekly limit reached');
  });

  it('drops the host from the sign-in phrase', () => {
    expect(phrase(signIn())).toBe('sign in for 3 pinned repos');
    expect(phrase(signIn({ host: null, text: 'Sign in for 2 pinned repos' }))).toBe('sign in for 2 pinned repos');
  });

  it('builds tooltips', () => {
    expect(tooltip(term({ reason: 'Allow Bash?' }))).toBe('Allow Bash?');
    expect(tooltip(term({ status: 'done' }))).toBe('api-server finished');
    expect(tooltip(branchItem())).toBe('Deploy\nBuild');
    expect(tooltip(branchItem({}, run({ title: 'Same', name: 'Same' })))).toBe('Same');
    expect(tooltip(pullItem('review'))).toBe('Add export');
    expect(tooltip(signIn())).toBe('Open the Accounts tab');
    expect(tooltip(usage())).toMatch(/^5-hour limit 84%\nResets /);
    expect(tooltip(usage({ resetsAt: null }))).toBe('5-hour limit 84%');
  });

  it('maps to the Ship status icons', () => {
    expect(statusIcon(term({ status: 'waiting' }))).toBe('waiting');
    expect(statusIcon(term({ status: 'failed' }))).toBe('failure');
    expect(statusIcon(term({ status: 'done' }))).toBe('success');
    expect(statusIcon(branchItem())).toBe('failure');
    expect(statusIcon(pullItem('approved'))).toBe('success');
    expect(statusIcon(pullItem('review'))).toBe('other');
    expect(statusIcon(signIn())).toBe('other');
    expect(statusIcon(usage())).toBe('other');
  });
});

describe('ageText', () => {
  it('abbreviates to minutes, hours, and days', () => {
    expect(ageText(NOW - 20_000, NOW)).toBe('now');
    expect(ageText(NOW - 4 * MIN, NOW)).toBe('4m');
    expect(ageText(NOW - 59 * MIN, NOW)).toBe('59m');
    expect(ageText(NOW - 3 * 60 * MIN, NOW)).toBe('3h');
    expect(ageText(NOW - 47 * 60 * MIN, NOW)).toBe('1d');
    expect(ageText(NOW - 2 * 24 * 60 * MIN, NOW)).toBe('2d');
  });

  it('is empty for an unknown time, and for rows without one', () => {
    expect(ageText(0, NOW)).toBe('');
    expect(ageOf(term(), NOW)).toBe('4m');
    expect(ageOf(usage(), NOW)).toBe('');
    expect(ageOf(signIn(), NOW)).toBe('');
  });

  it('ages usage and sign-in rows from the time the store stamped, without moving their order', () => {
    expect(ageOf(usage({ since: NOW - 3 * 60 * MIN }), NOW)).toBe('3h');
    expect(ageOf(signIn({ since: NOW - 2 * MIN }), NOW)).toBe('2m');
    const early = usage({ agent: 'a', resetsAt: NOW + MIN, since: NOW - MIN });
    const late = usage({ agent: 'b', resetsAt: NOW + 2 * MIN, since: NOW - 60 * MIN });
    expect(orderItems([late, early])).toEqual([early, late]);
    expect(hideKey(usage({ since: 5 }))).toBe(hideKey(usage()));
    expect(stableKey(signIn({ since: 5 }))).toBe(stableKey(signIn()));
  });
});

describe('hideSource and hideIdentity', () => {
  it('sorts keys by feed, Ship rows and the sign-in row together', () => {
    expect(hideSource(hideKey(usage())!)).toBe('usage');
    expect(hideSource(hideKey(signIn())!)).toBe('ship');
    expect(hideSource(hideKey(pullItem('review'))!)).toBe('ship');
    expect(hideSource(hideKey(branchItem())!)).toBe('ship');
  });

  it('names the Ship target of a branch or pull key, and none for the others', () => {
    expect(hideTarget(hideKey(pullItem('review'))!)).toBe(base.target);
    expect(hideTarget(hideKey(branchItem())!)).toBe(base.target);
    expect(hideTarget(hideKey(signIn())!)).toBeNull();
    expect(hideTarget(hideKey(usage())!)).toBeNull();
  });

  it('drops the state version', () => {
    const a = hideKey(pullItem('review', pull({ updatedAt: '2026-11-13T10:00:00Z' })))!;
    const b = hideKey(pullItem('review', pull({ updatedAt: '2026-11-13T11:00:00Z' })))!;
    expect(a).not.toBe(b);
    expect(hideIdentity(a)).toBe(hideIdentity(b));
  });
});

describe('hideKey', () => {
  it('is null for a terminal', () => {
    expect(hideKey(term())).toBeNull();
  });

  it('changes when a branch gets a new run, but not for another title', () => {
    const k = hideKey(branchItem({}, run({ id: 'r1' })));
    expect(hideKey(branchItem({}, run({ id: 'r2' })))).not.toBe(k);
    expect(hideKey(branchItem({}, run({ id: 'r1', title: 'Other' })))).toBe(k);
    expect(hideKey(branchItem({}, run({ id: 'r1' }), 'uat'))).not.toBe(k);
  });

  it('changes when a pull request is updated, and tells kinds and numbers apart', () => {
    const k = hideKey(pullItem('review', pull({ updatedAt: '2026-11-13T10:00:00Z' })));
    expect(hideKey(pullItem('review', pull({ updatedAt: '2026-11-13T11:00:00Z' })))).not.toBe(k);
    expect(hideKey(pullItem('approved', pull({ updatedAt: '2026-11-13T10:00:00Z' })))).not.toBe(k);
    expect(hideKey(pullItem('review', pull({ number: 13, updatedAt: '2026-11-13T10:00:00Z' })))).not.toBe(k);
  });

  it('keys usage by agent, label, and reset time, not by percent', () => {
    const k = hideKey(usage());
    expect(hideKey(usage({ percent: 95 }))).toBe(k);
    expect(hideKey(usage({ resetsAt: NOW + 999 * MIN }))).not.toBe(k);
    expect(hideKey(usage({ label: 'weekly' }))).not.toBe(k);
    expect(hideKey(usage({ agent: 'codex' }))).not.toBe(k);
  });

  it('keys sign-in by host and text', () => {
    const k = hideKey(signIn());
    expect(hideKey(signIn({ text: 'Sign in to bitbucket.org for 2 pinned repos' }))).not.toBe(k);
    expect(hideKey(signIn({ host: 'github.com' }))).not.toBe(k);
  });
});

describe('applyHides and pruneHides', () => {
  const review = pullItem('review');
  const failed = branchItem();
  const waiting = term();

  it('hides a keyed item, never a terminal, and shows it again once its state changes', () => {
    const hides = new Set([hideKey(review) as string, hideKey(failed) as string]);
    expect(applyHides([waiting, review, failed], hides)).toEqual([waiting]);
    const pushed = pullItem('review', pull({ updatedAt: '2026-11-13T11:30:00Z' }));
    expect(applyHides([pushed, branchItem({}, run({ id: 'r2' }))], hides)).toHaveLength(2);
  });

  it('prunes keys whose identity matches no current item', () => {
    const gone = pullItem('review', pull({ number: 99 }));
    const hides = new Set([hideKey(review) as string, hideKey(gone) as string]);
    expect([...pruneHides(hides, [review, waiting])]).toEqual([hideKey(review)]);
  });

  it('keeps a key whose identity is live even after the state moved on', () => {
    const old = hideKey(review) as string;
    const pushed = pullItem('review', pull({ updatedAt: '2026-11-13T11:30:00Z' }));
    expect(pruneHides(new Set([old]), [pushed]).has(old)).toBe(true);
  });

  it('prunes everything when no items remain, and does not mutate its input', () => {
    const hides = new Set([hideKey(review) as string]);
    expect(pruneHides(hides, []).size).toBe(0);
    expect(hides.size).toBe(1);
  });
});

describe('stableKey and enteredUrgent', () => {
  it('keys terminals by pane', () => {
    expect(stableKey(term({ paneId: 'a' }))).not.toBe(stableKey(term({ paneId: 'b' })));
  });

  it('reports a new failure, and a new run on the same branch', () => {
    const first = branchItem({}, run({ id: 'r1' }));
    const prev = new Set([stableKey(first)]);
    expect(enteredUrgent(prev, [first])).toEqual([]);
    const next = branchItem({}, run({ id: 'r2' }));
    expect(enteredUrgent(prev, [first, next])).toEqual([next]);
  });

  it('ignores Ready items', () => {
    expect(enteredUrgent(new Set(), [pullItem('review'), pullItem('approved'), signIn(), usage()])).toEqual([]);
  });

  it('ignores terminals, even blocked or failed ones', () => {
    expect(enteredUrgent(new Set(), [term({ status: 'waiting' }), term({ status: 'failed' })])).toEqual([]);
  });

  it('reports a pull request that newly has failing checks', () => {
    const failing = pullItem('mine', pull({ checks: 'failure' }));
    expect(enteredUrgent(new Set(), [failing])).toEqual([failing]);
  });

  it('reports a usage window that climbs from Ready to Broken', () => {
    const near = usage({ percent: 90 });
    const prev = new Set([stableKey(near)]);
    const full = usage({ percent: 100 });
    expect(enteredUrgent(prev, [full])).toEqual([full]);
    expect(enteredUrgent(new Set([stableKey(full)]), [usage({ percent: 100 })])).toEqual([]);
  });
});

describe('usageItems', () => {
  const win = (over: Partial<UsageWindow> = {}): UsageWindow => {
    const { kind: _kind, ...w } = usage(over);
    return w;
  };

  it('keeps windows at or past the threshold', () => {
    const items = usageItems([win({ percent: 79.9 }), win({ label: 'weekly', percent: 80 }), win({ agent: 'codex', percent: 100 })], 80, NOW);
    expect(items.map((i) => [i.agent, i.label])).toEqual([
      ['claude', 'weekly'],
      ['codex', '5-hour'],
    ]);
    expect(items.every((i) => i.kind === 'usage')).toBe(true);
  });

  it('drops a window whose reset time has passed', () => {
    expect(usageItems([win({ resetsAt: NOW - 1 }), win({ resetsAt: NOW })], 80, NOW)).toEqual([]);
    expect(usageItems([win({ resetsAt: NOW + 1 })], 80, NOW)).toHaveLength(1);
  });

  it('keeps a window with no reset time', () => {
    expect(usageItems([win({ resetsAt: null })], 80, NOW)).toHaveLength(1);
  });

  it('follows a lowered threshold', () => {
    expect(usageItems([win({ percent: 50 })], 80, NOW)).toEqual([]);
    expect(usageItems([win({ percent: 50 })], 40, NOW)).toHaveLength(1);
  });
});
