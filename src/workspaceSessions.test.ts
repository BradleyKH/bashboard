import { describe, expect, it } from 'vitest';
import type { HookEvent, Session } from './sessions';
import { WorkspaceSessions, type SessionTerminal } from './workspaceSessions';

function session(over: Partial<Session> & { sessionId: string; paneId: number | null }): Session {
  return { startedAt: 1, name: '', waitingReason: null, ...over } as Session;
}

function term(ptyId: number | null): SessionTerminal {
  return { ptyId, oscState: () => ({ running: false }) as ReturnType<SessionTerminal['oscState']> };
}

function stop(over: Partial<HookEvent>): HookEvent {
  return {
    sessionId: 's1',
    hookEventName: 'Stop',
    cwd: null,
    message: null,
    notificationType: null,
    paneId: null,
    at: 100,
    ...over,
  };
}

describe('WorkspaceSessions.saved', () => {
  it('saves nothing for a terminal with no bound or restored session', () => {
    expect(new WorkspaceSessions().saved('p1', 7)).toEqual({ sessionId: null });
  });

  it('keeps the restored session until a live one binds, then drops it', () => {
    const s = new WorkspaceSessions();
    s.restore('p1', { sessionId: 'old', permissionMode: 'plan' });
    expect(s.saved('p1', 7)).toEqual({ sessionId: 'old', permissionMode: 'plan' });
    s.setSessions([session({ sessionId: 'new', paneId: 7 })]);
    s.settle('p1', 7);
    expect(s.saved('p1', 7).sessionId).toBe('new');
    s.setSessions([]);
    expect(s.saved('p1', 7)).toEqual({ sessionId: null });
  });

  it('keeps the newest Copilot model, else the one the pane was saved with', () => {
    const s = new WorkspaceSessions();
    s.restore('p1', { sessionId: 'c', agent: 'copilot', resumeModel: 'm1' });
    expect(s.saved('p1', null)).toEqual({ sessionId: 'c', agent: 'copilot', resumeModel: 'm1' });
    s.setModel('c', 'm2');
    s.setModel('c', null);
    expect(s.saved('p1', null).resumeModel).toBe('m2');
  });

  it('records no model for Claude sessions', () => {
    const s = new WorkspaceSessions();
    s.restore('p1', { sessionId: 'x', resumeModel: 'm1' });
    s.setModel('x', 'm2');
    expect(s.saved('p1', null)).toEqual({ sessionId: 'x' });
  });
});

describe('WorkspaceSessions.onHook', () => {
  it('ignores events other than Stop', () => {
    const s = new WorkspaceSessions();
    expect(s.onHook(stop({ hookEventName: 'Notification' }), 'p1', [], () => false)).toBeNull();
  });

  it('marks the pane running the pty while it is unseen, until cleared', () => {
    const s = new WorkspaceSessions();
    expect(s.onHook(stop({}), 'p1', [], () => false)).toBe('p1');
    expect(s.clearDone('p1')).toBe(true);
    expect(s.clearDone('p1')).toBe(false);
  });

  it('falls back to the terminal bound to the session', () => {
    const s = new WorkspaceSessions();
    s.setSessions([session({ sessionId: 's1', paneId: 9 })]);
    const terminals: [string, SessionTerminal][] = [
      ['p1', term(3)],
      ['p2', term(9)],
    ];
    expect(s.onHook(stop({}), null, terminals, () => false)).toBe('p2');
  });

  it('leaves a seen pane unmarked', () => {
    const s = new WorkspaceSessions();
    expect(s.onHook(stop({}), 'p1', [], () => true)).toBeNull();
  });
});

describe('WorkspaceSessions.applyActivity', () => {
  it('reports a change only when a pty flips', () => {
    const s = new WorkspaceSessions();
    expect(s.applyActivity([{ id: 1, busy: true }], 10)).toBe(true);
    expect(s.applyActivity([{ id: 1, busy: true }], 20)).toBe(false);
    expect(s.applyActivity([], 30)).toBe(true);
  });
});
