import { describe, expect, it } from 'vitest';
import {
  externalSessions,
  formatAge,
  groupCardsByTab,
  isBusy,
  lastFolder,
  paneCards,
  type OtherCardInput,
  type TerminalCard,
  type TerminalCardInput,
} from './dashboardModel';
import { sessionHue } from './sessionHue';
import type { ShellStatus } from './terminalStatus';
import type { Session } from './sessions';

function session(over: Partial<Session> = {}): Session {
  return {
    sessionId: 's1',
    pid: 100,
    name: null,
    cwd: 'C:\\work',
    status: 'idle',
    statusChangedAt: 1000,
    startedAt: 500,
    version: null,
    paneId: null,
    ...over,
  };
}

function term(over: Partial<TerminalCardInput> = {}): TerminalCardInput {
  return { kind: 'terminal', paneId: 'p1', tabId: 't1', ptyId: 1, cwd: 'C:\\src\\app', profile: 'gitBash', focused: false,
    openedAt: 42,
    collapsed: false,
    shell: { status: 'idle', changedAt: 42 },
    attention: false,
    done: false,
    ...over,
  };
}

/** Cards for terminal-only input, narrowed so terminal fields are readable. */
function tcards(inputs: TerminalCardInput[], sessions: Session[]): TerminalCard[] {
  return paneCards(inputs, sessions) as TerminalCard[];
}

function pad(over: Partial<OtherCardInput> = {}): OtherCardInput {
  return {
    kind: 'scratch',
    paneId: 'v1',
    tabId: 't1',
    title: 'Notes',
    folder: null,
    focused: false,
    collapsed: false,
    openedAt: 1,
    confirmClose: false,
    ...over,
  };
}

describe('paneCards', () => {
  it('builds a card for a scratch pad with its kind, title, and no folder', () => {
    const [c] = paneCards([pad({ confirmClose: true, collapsed: true })], []);
    expect(c).toEqual({
      kind: 'scratch',
      paneId: 'v1',
      tabId: 't1',
      title: 'Notes',
      path: '',
      focused: false,
      collapsed: true,
      busy: true,
      attention: false,
    });
  });

  it('titles a container shell by the container name with no path', () => {
    const [c] = tcards([term({ containerName: 'web', cwd: 'C:\src\app' })], [session({ name: 'Fix', paneId: 1 })]);
    expect(c).toMatchObject({ title: 'web', path: '', containerName: 'web' });
    expect(tcards([term()], [])[0].containerName).toBeNull();
  });

  it('keeps a pad folder as the card path', () => {
    const [c] = paneCards([pad({ folder: '/home/work' })], []);
    expect(c.path).toBe('/home/work');
  });

  it('shows an idle terminal as done when a Stop is pending', () => {
    const [c] = tcards([term({ done: true })], [session({ status: 'idle', statusChangedAt: 700, paneId: 1 })]);
    expect(c).toMatchObject({ status: 'done', statusChangedAt: 700 });
    expect(tcards([term({ done: true })], [])[0].status).toBe('done');
  });

  it('does not let done override working or waiting', () => {
    const w = tcards([term({ done: true })], [session({ status: 'busy', paneId: 1 })])[0];
    expect(w.status).toBe('working');
    const a = tcards([term({ done: true })], [session({ status: 'waiting', paneId: 1 })])[0];
    expect(a.status).toBe('waiting');
  });

  it('binds a session by pty id and maps status', () => {
    const cards = tcards(
      [term()],
      [session({ sessionId: 'a', name: 'Fix bug', status: 'busy', statusChangedAt: 900, paneId: 1 })],
    );
    expect(cards[0]).toMatchObject({
      paneId: 'p1',
      title: 'Fix bug',
      path: 'C:\\src\\app',
      status: 'working',
      statusChangedAt: 900,
      sessionId: 'a',
      busy: true,
    });
  });

  it('maps waiting and idle, and unknown falls through to the shell status', () => {
    const working: ShellStatus = { status: 'working', changedAt: 60 };
    const t = [
      term({ ptyId: 1 }),
      term({ paneId: 'p2', ptyId: 2 }),
      term({ paneId: 'p3', ptyId: 3, shell: working }),
    ];
    const cards = tcards(t, [
      session({ sessionId: 'a', status: 'waiting', paneId: 1 }),
      session({ sessionId: 'b', status: 'idle', paneId: 2 }),
      session({ sessionId: 'c', status: 'unknown', rawStatus: 'zzz', paneId: 3 }),
    ]);
    expect(cards.map((c) => c.status)).toEqual(['waiting', 'idle', 'working']);
    expect(cards[2].statusChangedAt).toBe(60);
  });

  it('uses the shell status without a session', () => {
    const [c] = tcards([term({ shell: { status: 'working', changedAt: 55 } })], []);
    expect(c).toMatchObject({ status: 'working', statusChangedAt: 55 });
  });

  it('lets a bound session override the shell status', () => {
    const [c] = tcards(
      [term({ shell: { status: 'working', changedAt: 55 } })],
      [session({ status: 'idle', statusChangedAt: 900, paneId: 1 })],
    );
    expect(c).toMatchObject({ status: 'idle', statusChangedAt: 900 });
  });

  it('passes collapsed through', () => {
    const cards = tcards([term({ collapsed: true }), term({ paneId: 'p2' })], []);
    expect(cards.map((c) => c.collapsed)).toEqual([true, false]);
  });

  it('passes the profile through', () => {
    const cards = tcards([term({ profile: 'pwsh' }), term({ paneId: 'p2' })], []);
    expect(cards.map((c) => c.profile)).toEqual(['pwsh', 'gitBash']);
  });

  it('passes attention through', () => {
    const cards = tcards([term({ attention: true }), term({ paneId: 'p2' })], []);
    expect(cards.map((c) => c.attention)).toEqual([true, false]);
  });

  it('sets hue from the bound session and null when unbound', () => {
    const s = session({ name: 'Fix bug', paneId: 1 });
    const cards = tcards([term(), term({ paneId: 'p2', ptyId: 2 })], [s]);
    expect(cards[0].hue).toBe(sessionHue(s));
    expect(cards[1].hue).toBeNull();
  });

  it('prefers the most recently started session on the same pty', () => {
    const cards = tcards(
      [term()],
      [
        session({ sessionId: 'old', startedAt: 100, paneId: 1 }),
        session({ sessionId: 'new', startedAt: 300, paneId: 1 }),
        session({ sessionId: 'mid', startedAt: 200, paneId: 1 }),
      ],
    );
    expect(cards[0].sessionId).toBe('new');
  });

  it('falls back to the folder name and the shell status time when unbound', () => {
    const [c] = tcards([term({ shell: { status: 'idle', changedAt: 77 } })], [session({ paneId: 9 })]);
    expect(c).toMatchObject({ title: 'app', status: 'idle', statusChangedAt: 77, sessionId: null, busy: false });
  });

  it('uses the folder when the bound session has no name', () => {
    const [c] = tcards([term()], [session({ name: null, paneId: 1 })]);
    expect(c.title).toBe('app');
  });

  it('treats a null ptyId as unbound and a null cwd as ~ with empty path', () => {
    const [c] = tcards(
      [term({ ptyId: null, cwd: null })],
      [session({ paneId: null })],
    );
    expect(c).toMatchObject({ title: '~', path: '', sessionId: null, status: 'idle', statusChangedAt: 42 });
  });

  it('keeps input order and the focused flag', () => {
    const cards = tcards(
      [term({ paneId: 'p2', focused: true }), term({ paneId: 'p1' })],
      [],
    );
    expect(cards.map((c) => [c.paneId, c.focused])).toEqual([
      ['p2', true],
      ['p1', false],
    ]);
  });
});

describe('isBusy', () => {
  it('is true for a bound session or a running command', () => {
    expect(isBusy(term(), [session({ paneId: 1 })])).toBe(true);
    expect(isBusy(term({ shell: { status: 'working', changedAt: 1 } }), [])).toBe(true);
  });

  it('is false for an idle shell whose session is bound elsewhere', () => {
    expect(isBusy(term(), [session({ paneId: 2 })])).toBe(false);
    expect(isBusy(term({ ptyId: null }), [session({ paneId: 1 })])).toBe(false);
  });
});

describe('externalSessions', () => {
  it('keeps sessions with a null paneId or a pty not in this window', () => {
    const out = externalSessions(
      [
        session({ sessionId: 'bound', paneId: 1 }),
        session({ sessionId: 'null', paneId: null }),
        session({ sessionId: 'foreign', paneId: 99 }),
      ],
      [term({ ptyId: 1 }), term({ paneId: 'p2', ptyId: null })],
    );
    expect(out.map((s) => s.sessionId).sort()).toEqual(['foreign', 'null']);
  });

  it('sorts waiting, busy, idle, unknown, then newest status change first', () => {
    const out = externalSessions(
      [
        session({ sessionId: 'unk', status: 'unknown', statusChangedAt: 9 }),
        session({ sessionId: 'idleOld', status: 'idle', statusChangedAt: 1 }),
        session({ sessionId: 'busy', status: 'busy', statusChangedAt: 5 }),
        session({ sessionId: 'idleNew', status: 'idle', statusChangedAt: 8 }),
        session({ sessionId: 'wait', status: 'waiting', statusChangedAt: 2 }),
      ],
      [],
    );
    expect(out.map((s) => s.sessionId)).toEqual(['wait', 'busy', 'idleNew', 'idleOld', 'unk']);
  });

  it('ignores non-terminal panes', () => {
    const out = externalSessions(
      [session({ sessionId: 'a', paneId: 1 })],
      [pad(), term({ ptyId: null })],
    );
    expect(out.map((s) => s.sessionId)).toEqual(['a']);
  });

  it('does not mutate the input array', () => {
    const input = [
      session({ sessionId: 'a', status: 'idle' }),
      session({ sessionId: 'b', status: 'waiting' }),
    ];
    externalSessions(input, []);
    expect(input.map((s) => s.sessionId)).toEqual(['a', 'b']);
  });
});

describe('lastFolder', () => {
  it('handles backslash, trailing slashes, forward slashes, and drive roots', () => {
    expect(lastFolder('C:\\a\\b')).toBe('b');
    expect(lastFolder('C:\\a\\b\\')).toBe('b');
    expect(lastFolder('C:\\a\\b\\\\')).toBe('b');
    expect(lastFolder('/c/Users/me/repo')).toBe('repo');
    expect(lastFolder('/c/Users/me/repo/')).toBe('repo');
    expect(lastFolder('C:\\')).toBe('C:');
    expect(lastFolder('single')).toBe('single');
    expect(lastFolder('')).toBe('');
  });
});

describe('formatAge', () => {
  it('formats boundaries and floors', () => {
    expect(formatAge(0)).toBe('now');
    expect(formatAge(9999)).toBe('now');
    expect(formatAge(10000)).toBe('10s');
    expect(formatAge(45000)).toBe('45s');
    expect(formatAge(59999)).toBe('59s');
    expect(formatAge(60000)).toBe('1m');
    expect(formatAge(3 * 60000 + 59000)).toBe('3m');
    expect(formatAge(3600000)).toBe('1h');
    expect(formatAge(2 * 3600000 + 1)).toBe('2h');
    expect(formatAge(86400000)).toBe('1d');
    expect(formatAge(3 * 86400000)).toBe('3d');
  });
});

describe('groupCardsByTab', () => {
  const tab = (id: string, over: Partial<Parameters<typeof groupCardsByTab>[1][number]> = {}) => ({
    id,
    title: id,
    active: false,
    status: 'idle' as const,
    attention: false,
    ...over,
  });

  it('follows tab order and keeps card order within a group', () => {
    const cards = tcards(
      [
        term({ paneId: 'a', tabId: 't2' }),
        term({ paneId: 'b', tabId: 't1' }),
        term({ paneId: 'c', tabId: 't2' }),
      ],
      [],
    );
    const groups = groupCardsByTab(cards, [tab('t1'), tab('t2')]);
    expect(groups.map((g) => g.tabId)).toEqual(['t1', 't2']);
    expect(groups.map((g) => g.cards.map((c) => c.paneId))).toEqual([['b'], ['a', 'c']]);
    expect(groups.map((g) => g.count)).toEqual([1, 2]);
  });

  it('counts every pane kind in a group', () => {
    const cards = paneCards([term({ paneId: 'a' }), pad({ paneId: 'v1' }), pad({ paneId: 'v2' })], []);
    const [g] = groupCardsByTab(cards, [tab('t1')]);
    expect(g.count).toBe(3);
    expect(g.cards.map((c) => c.kind)).toEqual(['terminal', 'scratch', 'scratch']);
  });

  it('returns a single group for one tab', () => {
    const cards = tcards([term(), term({ paneId: 'p2' })], []);
    const groups = groupCardsByTab(cards, [tab('t1', { active: true })]);
    expect(groups).toHaveLength(1);
    expect(groups[0].cards).toHaveLength(2);
    expect(groups[0].active).toBe(true);
  });

  it('carries the tab combined status and attention', () => {
    const groups = groupCardsByTab(tcards([term()], []), [
      tab('t1', { status: 'waiting', attention: true }),
      tab('t2'),
    ]);
    expect(groups[0].status).toBe('waiting');
    expect(groups[0].attention).toBe(true);
    expect(groups[1].status).toBe('idle');
    expect(groups[1].cards).toEqual([]);
  });
});
