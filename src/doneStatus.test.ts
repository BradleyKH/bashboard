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
