import { describe, expect, it } from 'vitest';
import { DoneTracker } from './doneStatus';
import type { Session } from './sessions';

function session(sessionId = 's1'): Session {
  return {
    sessionId,
    pid: 1,
    name: null,
    cwd: 'C:',
    status: 'idle',
    statusChangedAt: 0,
    startedAt: 0,
    version: null,
    paneId: 1,
    waitingReason: null,
    agent: 'claude',
  };
}

const idle = { status: 'idle' as const, changedAt: 1000 };

describe('DoneTracker', () => {
  it('does not mark while the pane is seen', () => {
    const d = new DoneTracker();
    expect(d.mark('a', 's1', 1000, true)).toBe(false);
    expect(d.has('a')).toBe(false);
    expect(d.resolve('a', session(), idle)).toEqual(idle);
  });

  it('marks while unseen and resolves idle to done keeping changedAt', () => {
    const d = new DoneTracker();
    expect(d.mark('a', 's1', 1000, false)).toBe(true);
    expect(d.resolve('a', session(), idle)).toEqual({ status: 'done', changedAt: 1000 });
  });

  it('keeps the mark while the roster still shows the pre-Stop status', () => {
    const d = new DoneTracker();
    d.mark('a', 's1', 2000, false);
    const stale = { status: 'working' as const, changedAt: 1500 };
    expect(d.resolve('a', session(), stale)).toEqual(stale);
    expect(d.has('a')).toBe(true);
    expect(d.resolve('a', session(), { status: 'idle', changedAt: 2100 })).toEqual({
      status: 'done',
      changedAt: 2100,
    });
  });

  it('drops the mark on a later working or waiting', () => {
    for (const status of ['working', 'waiting'] as const) {
      const d = new DoneTracker();
      d.mark('a', 's1', 2000, false);
      const later = { status, changedAt: 3000 };
      expect(d.resolve('a', session(), later)).toEqual(later);
      expect(d.has('a')).toBe(false);
      expect(d.resolve('a', session(), idle)).toEqual(idle);
    }
  });

  it('keeps the mark while the session is unbound, then drops it for a different session', () => {
    const d = new DoneTracker();
    d.mark('a', 's1', 1000, false);
    expect(d.resolve('a', null, idle)).toEqual({ status: 'done', changedAt: 1000 });
    expect(d.has('a')).toBe(true);
    expect(d.resolve('a', session('s1'), idle).status).toBe('done');
    expect(d.resolve('a', session('s2'), idle)).toEqual(idle);
    expect(d.has('a')).toBe(false);
  });

  it('drops the mark when its bound session ends', () => {
    const d = new DoneTracker();
    d.mark('a', 's1', 1000, false);
    expect(d.resolve('a', session('s1'), idle).status).toBe('done');
    expect(d.resolve('a', null, idle)).toEqual(idle);
    expect(d.has('a')).toBe(false);
  });

  it('drops an unbound mark once the base goes working or waiting after it', () => {
    const d = new DoneTracker();
    d.mark('a', 's1', 2000, false);
    const later = { status: 'working' as const, changedAt: 3000 };
    expect(d.resolve('a', null, later)).toEqual(later);
    expect(d.has('a')).toBe(false);
  });

  it('keeps the mark when a later roster idle arrives', () => {
    const d = new DoneTracker();
    d.mark('a', 's1', 1000, false);
    expect(d.resolve('a', session(), { status: 'idle', changedAt: 5000 }).status).toBe('done');
    expect(d.has('a')).toBe(true);
  });

  it('replaces an older mark with a newer one', () => {
    const d = new DoneTracker();
    d.mark('a', 's1', 1000, false);
    d.mark('a', 's1', 4000, false);
    const working = { status: 'working' as const, changedAt: 3000 };
    expect(d.resolve('a', session(), working)).toEqual(working);
    expect(d.has('a')).toBe(true);
  });

  it('clears and forgets', () => {
    const d = new DoneTracker();
    d.mark('a', 's1', 1000, false);
    expect(d.clear('a')).toBe(true);
    expect(d.clear('a')).toBe(false);
    d.mark('a', 's1', 1000, false);
    d.forget('a');
    expect(d.has('a')).toBe(false);
  });
});

describe('DoneTracker command marks', () => {
  const end = { durationMs: 30_000, exitCode: 0, at: 5000, seen: false, minSeconds: 30 };

  it('marks only at or past the threshold', () => {
    const d = new DoneTracker();
    expect(d.markCommand('a', { ...end, durationMs: 29_999 })).toBe(false);
    expect(d.has('a')).toBe(false);
    expect(d.markCommand('a', end)).toBe(true);
    expect(d.resolve('a', null, idle)).toEqual({ status: 'done', changedAt: 5000 });
  });

  it('maps exit codes to done, failed, or nothing', () => {
    const cases: [number | null, string | null][] = [
      [0, 'done'],
      [1, 'failed'],
      [130, null],
      [null, 'done'],
    ];
    for (const [exitCode, status] of cases) {
      const d = new DoneTracker();
      expect(d.markCommand('a', { ...end, exitCode })).toBe(status !== null);
      expect(d.resolve('a', null, idle)).toEqual(
        status ? { status, changedAt: 5000 } : idle,
      );
    }
  });

  it('never marks with the threshold off or while seen', () => {
    const d = new DoneTracker();
    expect(d.markCommand('a', { ...end, minSeconds: 0, durationMs: 1e9 })).toBe(false);
    expect(d.markCommand('a', { ...end, seen: true })).toBe(false);
    expect(d.has('a')).toBe(false);
  });

  it('clears on focus', () => {
    const d = new DoneTracker();
    d.markCommand('a', end);
    expect(d.clear('a')).toBe(true);
    expect(d.resolve('a', null, idle)).toEqual(idle);
  });

  it('clears on the next command start, which leaves a session mark alone', () => {
    const d = new DoneTracker();
    d.markCommand('a', end);
    expect(d.commandStarted('a')).toBe(true);
    expect(d.has('a')).toBe(false);
    expect(d.commandStarted('a')).toBe(false);
    d.mark('a', 's1', 1000, false);
    expect(d.commandStarted('a')).toBe(false);
    expect(d.has('a')).toBe(true);
  });

  it('is hidden while a session is bound and shows once it is gone', () => {
    const d = new DoneTracker();
    d.markCommand('a', { ...end, exitCode: 2 });
    const working = { status: 'working' as const, changedAt: 6000 };
    expect(d.resolve('a', session(), working)).toEqual(working);
    expect(d.resolve('a', session(), idle)).toEqual(idle);
    expect(d.has('a')).toBe(true);
    expect(d.resolve('a', null, idle)).toEqual({ status: 'failed', changedAt: 5000 });
  });

  it('is replaced by a newer command mark', () => {
    const d = new DoneTracker();
    d.markCommand('a', { ...end, exitCode: 1 });
    d.markCommand('a', { ...end, exitCode: 0, at: 9000 });
    expect(d.resolve('a', null, idle)).toEqual({ status: 'done', changedAt: 9000 });
  });

  it('is replaced by a session mark', () => {
    const d = new DoneTracker();
    d.markCommand('a', { ...end, exitCode: 1 });
    d.mark('a', 's1', 7000, false);
    expect(d.resolve('a', session(), idle)).toEqual({ status: 'done', changedAt: 1000 });
    expect(d.resolve('a', null, idle)).toEqual(idle);
    expect(d.has('a')).toBe(false);
  });
});

describe('DoneTracker run marks', () => {
  it('shows done or failed with the mark time until new work', () => {
    const d = new DoneTracker();
    expect(d.markRun('a', false, 1000, false)).toBe(true);
    expect(d.resolve('a', null, idle)).toEqual({ status: 'done', changedAt: 1000 });
    expect(d.markRun('b', true, 1000, false)).toBe(true);
    expect(d.resolve('b', null, idle)).toEqual({ status: 'failed', changedAt: 1000 });
    const later = { status: 'waiting' as const, changedAt: 2000 };
    expect(d.resolve('a', null, later)).toEqual(later);
    expect(d.has('a')).toBe(false);
  });

  it('does not mark while seen', () => {
    const d = new DoneTracker();
    expect(d.markRun('a', false, 1000, true)).toBe(false);
    expect(d.has('a')).toBe(false);
  });

  it('keeps the mark under stale work and shows over a bound session', () => {
    const d = new DoneTracker();
    d.markRun('a', false, 2000, false);
    const stale = { status: 'working' as const, changedAt: 1500 };
    expect(d.resolve('a', null, stale)).toEqual(stale);
    expect(d.has('a')).toBe(true);
    expect(d.resolve('a', session(), idle)).toEqual({ status: 'done', changedAt: 2000 });
  });

  it('survives the next command start and clears on focus', () => {
    const d = new DoneTracker();
    d.markRun('a', true, 1000, false);
    expect(d.commandStarted('a')).toBe(false);
    expect(d.has('a')).toBe(true);
    expect(d.clear('a')).toBe(true);
  });

  it('is replaced by a newer mark of another kind', () => {
    const d = new DoneTracker();
    d.markRun('a', true, 1000, false);
    d.markCommand('a', { durationMs: 30_000, exitCode: 0, at: 5000, seen: false, minSeconds: 30 });
    expect(d.resolve('a', null, idle)).toEqual({ status: 'done', changedAt: 5000 });
  });
});

describe('DoneTracker program marks', () => {
  it('marks a working-to-done report while unseen, showing done until new work', () => {
    const d = new DoneTracker();
    expect(d.markProgram('a', 'working', 'done', 1000, false)).toBe(true);
    expect(d.resolve('a', null, idle)).toEqual({ status: 'done', changedAt: 1000 });
    const later = { status: 'working' as const, changedAt: 2000 };
    expect(d.resolve('a', null, later)).toEqual(later);
    expect(d.has('a')).toBe(false);
  });

  it('marks blocked-to-idle, and error as failed', () => {
    const d = new DoneTracker();
    expect(d.markProgram('a', 'blocked', 'idle', 1000, false)).toBe(true);
    expect(d.resolve('a', null, idle).status).toBe('done');
    expect(d.markProgram('b', 'working', 'error', 1000, false)).toBe(true);
    expect(d.resolve('b', null, { status: 'failed', changedAt: 1000 })).toEqual({ status: 'failed', changedAt: 1000 });
  });

  it('does not mark when seen, or when no work was under way', () => {
    const d = new DoneTracker();
    expect(d.markProgram('a', 'working', 'done', 1000, true)).toBe(false);
    expect(d.markProgram('a', 'idle', 'done', 1000, false)).toBe(false);
    expect(d.markProgram('a', null, 'done', 1000, false)).toBe(false);
    expect(d.markProgram('a', 'working', 'blocked', 1000, false)).toBe(false);
    expect(d.markProgram('a', 'working', null, 1000, false)).toBe(false);
    expect(d.has('a')).toBe(false);
  });

  it('keeps the mark under stale work and clears when seen', () => {
    const d = new DoneTracker();
    d.markProgram('a', 'working', 'done', 2000, false);
    const stale = { status: 'working' as const, changedAt: 1500 };
    expect(d.resolve('a', null, stale)).toEqual(stale);
    expect(d.has('a')).toBe(true);
    expect(d.clear('a')).toBe(true);
  });
});
