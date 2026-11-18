import { describe, expect, it } from 'vitest';
import {
  groupByAge,
  inScope,
  matchesQuery,
  mergeLive,
  modelOptions,
  relativeTime,
  resumeCommandText,
  resumePlan,
  scopeForFolder,
  scopeForOrigin,
  scopeKey,
  scopeName,
  type HistoryRow,
  type SessionsOrigin,
} from './sessionHistoryModel';
import type { PastSession } from './sessionHistoryApi';
import type { Session } from './sessions';

function past(over: Partial<PastSession> = {}): PastSession {
  return {
    agent: 'claude',
    sessionId: 's1',
    cwd: 'C:\\src\\app',
    cwdExists: true,
    repoRoot: 'C:\\src\\app',
    branch: 'main',
    title: 'Fix the login bug',
    firstPrompt: 'Why does login fail?',
    lastPrompt: 'Add a regression test',
    startedAt: 1000,
    updatedAt: 2000,
    permissionMode: null,
    model: null,
    ...over,
  };
}

function live(over: Partial<Session> = {}): Session {
  return {
    sessionId: 's1',
    pid: 1,
    name: null,
    cwd: 'C:\\src\\app',
    status: 'idle',
    statusChangedAt: 3000,
    startedAt: 1000,
    version: null,
    paneId: 7,
    waitingReason: null,
    agent: 'claude',
    ...over,
  };
}

function row(over: Partial<HistoryRow> = {}): HistoryRow {
  return { ...past(), live: false, paneId: null, ...over };
}

const origin = (over: Partial<SessionsOrigin> = {}): SessionsOrigin => ({
  paneId: 3,
  cwd: 'C:\\src\\app',
  idle: true,
  agentBound: false,
  repoRoot: 'C:\\src\\app',
  ...over,
});

describe('scope', () => {
  it('keys a repo scope by its root and a folder scope by the folder', () => {
    expect(scopeKey('C:\\src\\app\\sub', 'C:\\src\\app')).toBe(scopeKey('C:\\src\\app', 'c:/src/app/'));
    expect(scopeKey('C:\\src\\app', null)).not.toBe(scopeKey('C:\\src\\app', 'C:\\src\\app'));
    expect(scopeKey('C:\\a', null)).not.toBe(scopeKey('C:\\b', null));
  });

  it('names the repo folder, or the folder outside git', () => {
    expect(scopeName({ folder: 'C:\\src\\app\\sub', repoRoot: 'C:\\src\\app' })).toBe('app');
    expect(scopeName({ folder: 'C:\\notes', repoRoot: null })).toBe('notes');
  });

  it('infers the repo root from a worktree session in the folder', () => {
    const wt = past({ cwd: 'C:\\src\\app-wt\\feature', repoRoot: 'C:\\src\\app' });
    const other = past({ cwd: 'C:\\x', repoRoot: 'C:\\x' });
    expect(scopeForFolder('C:\\src\\app-wt\\feature\\sub', [other, wt])).toEqual({
      folder: 'C:\\src\\app-wt\\feature\\sub',
      repoRoot: 'C:\\src\\app',
    });
  });

  it('infers the repo root from a session root containing the folder, else leaves a folder scope', () => {
    const sibling = past({ cwd: 'C:\\src\\app\\other' });
    expect(scopeForFolder('C:\\src\\app\\sub', [sibling]).repoRoot).toBe('C:\\src\\app');
    expect(scopeForFolder('C:\\notes', [past()]).repoRoot).toBeNull();
    expect(scopeForFolder('C:\\notes', [])).toEqual({ folder: 'C:\\notes', repoRoot: null });
  });

  it("uses the origin's resolved repo root, else infers one from history", () => {
    const wt = { cwd: 'C:\\src\\app-wt\\fresh', repoRoot: 'C:\\src\\app' };
    expect(scopeForOrigin(wt, [])).toEqual({ folder: wt.cwd, repoRoot: 'C:\\src\\app' });
    const sibling = past({ cwd: 'C:\\src\\app\\other' });
    expect(scopeForOrigin({ cwd: 'C:\\src\\app\\sub', repoRoot: null }, [sibling]).repoRoot).toBe('C:\\src\\app');
  });

  const repo = { folder: 'C:\\src\\app\\sub', repoRoot: 'C:\\src\\app' };

  it('matches a worktree session to its main repo', () => {
    const wt = past({ cwd: 'C:\\src\\app-wt\\feature', repoRoot: 'C:\\src\\app' });
    expect(inScope(wt, repo)).toBe(true);
  });

  it('matches a session started in a subfolder, and rejects another repo', () => {
    expect(inScope(past({ cwd: 'C:\\src\\app\\packages\\x', repoRoot: 'C:\\src\\app' }), repo)).toBe(true);
    expect(inScope(past({ cwd: 'C:\\src\\other', repoRoot: 'C:\\src\\other' }), repo)).toBe(false);
  });

  it('falls back to the cwd when the session has no repo root', () => {
    expect(inScope(past({ cwd: 'C:\\src\\app\\x', repoRoot: null }), repo)).toBe(true);
    expect(inScope(past({ cwd: 'C:\\src\\other', repoRoot: null }), repo)).toBe(false);
  });

  it('outside git, the cwd must be the folder or inside it', () => {
    const folder = { folder: 'C:\\notes', repoRoot: null };
    expect(inScope(past({ cwd: 'C:\\notes', repoRoot: null }), folder)).toBe(true);
    expect(inScope(past({ cwd: 'c:/notes/2026', repoRoot: null }), folder)).toBe(true);
    expect(inScope(past({ cwd: 'C:\\notes2', repoRoot: null }), folder)).toBe(false);
    expect(inScope(past({ cwd: 'C:\\src\\app', repoRoot: 'C:\\src\\app' }), folder)).toBe(false);
  });
});

describe('matchesQuery', () => {
  it('matches everything on an empty query', () => {
    expect(matchesQuery(past(), '')).toBe(true);
    expect(matchesQuery(past(), '   ')).toBe(true);
  });

  it('is case-insensitive and needs every word, in any order', () => {
    expect(matchesQuery(past(), 'LOGIN fix')).toBe(true);
    expect(matchesQuery(past(), 'login nonsense')).toBe(false);
  });

  it('searches title, first prompt, last prompt, and folder', () => {
    expect(matchesQuery(past(), 'regression')).toBe(true);
    expect(matchesQuery(past(), 'why does')).toBe(true);
    expect(matchesQuery(past(), 'src app')).toBe(true);
  });

  it('words may come from different fields', () => {
    expect(matchesQuery(past(), 'regression why')).toBe(true);
  });

  it('copes with null prompts', () => {
    expect(matchesQuery(past({ firstPrompt: null, lastPrompt: null }), 'login')).toBe(true);
    expect(matchesQuery(past({ firstPrompt: null, lastPrompt: null }), 'regression')).toBe(false);
  });
});

describe('groupByAge', () => {
  const now = new Date(2026, 10, 17, 15, 30).getTime();
  const at = (daysBack: number, hour = 12) => new Date(2026, 10, 17 - daysBack, hour).getTime();
  const item = (updatedAt: number) => ({ updatedAt });

  it('buckets by local calendar day, in order, newest first', () => {
    const groups = groupByAge(
      [item(at(40)), item(at(0, 1)), item(at(1, 23)), item(at(5)), item(at(20)), item(at(0, 14)), item(at(2, 0))],
      now,
    );
    expect(groups.map((g) => g.label)).toEqual([
      'Today',
      'Yesterday',
      'Previous 7 days',
      'Previous 30 days',
      'Older',
    ]);
    expect(groups[0].sessions.map((s) => s.updatedAt)).toEqual([at(0, 14), at(0, 1)]);
    expect(groups[2].sessions.map((s) => s.updatedAt)).toEqual([at(2, 0), at(5)]);
  });

  it('omits empty buckets', () => {
    expect(groupByAge([item(at(0, 2))], now).map((g) => g.label)).toEqual(['Today']);
    expect(groupByAge([], now)).toEqual([]);
  });

  it('splits at local midnight and at the 7 and 30 day edges', () => {
    const label = (t: number) => groupByAge([item(t)], now)[0].label;
    expect(label(new Date(2026, 10, 16, 23, 59).getTime())).toBe('Yesterday');
    expect(label(new Date(2026, 10, 10, 0, 0).getTime())).toBe('Previous 7 days');
    expect(label(new Date(2026, 10, 9, 23, 59).getTime())).toBe('Previous 30 days');
    expect(label(new Date(2026, 9, 18, 0, 0).getTime())).toBe('Previous 30 days');
    expect(label(new Date(2026, 9, 17, 23, 59).getTime())).toBe('Older');
  });

  it('counts a future timestamp as today', () => {
    expect(groupByAge([item(now + 3600_000)], now)[0].label).toBe('Today');
  });

  it('does not mutate its input', () => {
    const input = [item(1), item(2)];
    groupByAge(input, now);
    expect(input.map((s) => s.updatedAt)).toEqual([1, 2]);
  });
});

describe('relativeTime', () => {
  it('reuses the dashboard age format with an "ago" suffix', () => {
    expect(relativeTime(10_000, 10_500)).toBe('now');
    expect(relativeTime(0, 5 * 60_000)).toBe('5m ago');
    expect(relativeTime(0, 3 * 3600_000)).toBe('3h ago');
    expect(relativeTime(0, 2 * 86400_000)).toBe('2d ago');
    expect(relativeTime(5000, 1000)).toBe('now');
  });
});

describe('mergeLive', () => {
  it('marks a history row live and carries its pane', () => {
    const [r] = mergeLive([past()], [live({ paneId: 7 })]);
    expect(r).toMatchObject({ live: true, paneId: 7, title: 'Fix the login bug', updatedAt: 3000 });
  });

  it('leaves a session absent from the roster not live', () => {
    const [r] = mergeLive([past()], []);
    expect(r).toMatchObject({ live: false, paneId: null, updatedAt: 2000 });
  });

  it('matches on agent as well as session id', () => {
    const [r] = mergeLive([past({ agent: 'codex' })], [live({ agent: 'claude' })]);
    expect(r.live).toBe(false);
  });

  it('does not move a row back in time, and takes the roster mode when it has one', () => {
    const [r] = mergeLive([past({ updatedAt: 9000, permissionMode: 'plan' })], [live()]);
    expect(r.updatedAt).toBe(9000);
    expect(r.permissionMode).toBe('plan');
    const [r2] = mergeLive([past({ permissionMode: 'plan' })], [live({ permissionMode: 'acceptEdits' })]);
    expect(r2.permissionMode).toBe('acceptEdits');
  });

  it('adds a live session history lacks, titled by its name else its folder', () => {
    const rows = mergeLive([], [live({ sessionId: 'n1', name: 'Release prep' }), live({ sessionId: 'n2' })]);
    expect(rows.map((r) => r.title)).toEqual(['Release prep', 'app']);
    expect(rows[0]).toMatchObject({
      live: true,
      paneId: 7,
      cwdExists: true,
      repoRoot: null,
      updatedAt: 3000,
      startedAt: 1000,
    });
  });

  it('prefers the roster entry bound to a pane when a session is listed twice', () => {
    const [r] = mergeLive([past()], [live({ paneId: null }), live({ paneId: 4 })]);
    expect(r.paneId).toBe(4);
  });

  it('keeps a live session outside this app live with no pane', () => {
    const [r] = mergeLive([past()], [live({ paneId: null })]);
    expect(r).toMatchObject({ live: true, paneId: null });
  });
});

describe('resumeCommandText', () => {
  it('is the command resumePlan runs', () => {
    expect(resumeCommandText(row())).toBe('claude --resume s1');
    expect(resumePlan(row(), null)).toMatchObject({ command: resumeCommandText(row()) });
  });

  it('is null for an id that is unsafe to type', () => {
    expect(resumeCommandText(row({ sessionId: 'x; rm -rf /' }))).toBeNull();
  });
});

describe('resumePlan', () => {
  it('focuses a live session bound to a pane', () => {
    expect(resumePlan(row({ live: true, paneId: 7 }), origin())).toEqual({ kind: 'focus', paneId: 7 });
  });

  it('types into an idle origin shell already in the session folder', () => {
    expect(resumePlan(row(), origin({ cwd: 'c:/src/app/' }))).toEqual({
      kind: 'typeHere',
      paneId: 3,
      command: 'claude --resume s1',
    });
  });

  it('opens a new pane when the origin is busy, bound to an agent, elsewhere, or absent', () => {
    const want = { kind: 'newPane', cwd: 'C:\\src\\app', command: 'claude --resume s1', fellBack: false };
    expect(resumePlan(row(), origin({ idle: false }))).toEqual(want);
    expect(resumePlan(row(), origin({ agentBound: true }))).toEqual(want);
    expect(resumePlan(row(), origin({ cwd: 'C:\\src\\other' }))).toEqual(want);
    expect(resumePlan(row(), null)).toEqual(want);
  });

  it('falls back to the repo root when the session folder is gone', () => {
    const r = row({ cwd: 'C:\\src\\app-wt\\gone', cwdExists: false, repoRoot: 'C:\\src\\app' });
    expect(resumePlan(r, origin({ cwd: 'C:\\src\\app-wt\\gone' }))).toEqual({
      kind: 'newPane',
      cwd: 'C:\\src\\app',
      command: 'claude --resume s1',
      fellBack: true,
    });
  });

  it('keeps the folder when it is gone and there is no repo to fall back to', () => {
    const r = row({ cwdExists: false, repoRoot: null });
    expect(resumePlan(r, null)).toMatchObject({ kind: 'newPane', cwd: 'C:\\src\\app', fellBack: false });
  });

  it('resumes a live session with no pane like a past one', () => {
    expect(resumePlan(row({ live: true, paneId: null }), null)).toMatchObject({ kind: 'newPane' });
  });

  it('passes the saved permission mode (Claude) and model (Copilot)', () => {
    expect(resumePlan(row({ permissionMode: 'plan' }), null)).toMatchObject({
      command: 'claude --resume s1 --permission-mode plan',
    });
    expect(resumePlan(row({ permissionMode: 'default' }), null)).toMatchObject({
      command: 'claude --resume s1',
    });
    expect(resumePlan(row({ agent: 'copilot', model: 'gpt-5' }), null)).toMatchObject({
      command: 'copilot --resume s1 --model gpt-5',
    });
    expect(resumePlan(row({ agent: 'codex', permissionMode: 'plan' }), null)).toMatchObject({
      command: 'codex resume s1',
    });
  });

  it('refuses a session id that is not safe to type into a shell', () => {
    expect(resumePlan(row({ sessionId: 'a; rm -rf /' }), null)).toBeNull();
  });
});

describe('modelOptions', () => {
  it('lists distinct real models, sorted, skipping unknown and placeholder ids', () => {
    const sessions = [
      past({ model: 'claude-sonnet-4-5' }),
      past({ model: 'claude-opus-4-1' }),
      past({ model: 'claude-sonnet-4-5' }),
      past({ model: null }),
      past({ model: '<synthetic>' }),
    ];
    expect(modelOptions(sessions)).toEqual(['claude-opus-4-1', 'claude-sonnet-4-5']);
  });
});
