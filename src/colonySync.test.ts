import { describe, expect, it } from 'vitest';
import { ColonySync } from './colonySync';
import { sessionHue } from './sessionHue';
import type { Session, SessionStatus } from './sessions';

function session(sessionId: string, status: SessionStatus): Session {
  return {
    sessionId,
    pid: 1,
    name: 'alpha',
    cwd: 'C:/work/alpha',
    status,
    statusChangedAt: 0,
    startedAt: 0,
    version: null,
    paneId: null,
  };
}

function setup() {
  const calls: unknown[][] = [];
  const colony = {
    ensure: (id: string, hue: number) => calls.push(['ensure', id, hue]),
    setMood: (id: string, mood: string) => calls.push(['setMood', id, mood]),
    release: (id: string) => calls.push(['release', id]),
  };
  return { calls, sync: new ColonySync(colony) };
}

describe('ColonySync', () => {
  it('ensures a new session with its hue, then sets its mood', () => {
    const { calls, sync } = setup();
    const s = session('a', 'busy');
    sync.update([s]);
    expect(calls).toEqual([
      ['ensure', 'a', sessionHue(s)],
      ['setMood', 'a', 'busy'],
    ]);
  });

  it('does not resend an unchanged mood, but sends a changed one', () => {
    const { calls, sync } = setup();
    sync.update([session('a', 'busy')]);
    calls.length = 0;
    sync.update([session('a', 'busy')]);
    expect(calls).toEqual([]);
    sync.update([session('a', 'waiting')]);
    expect(calls).toEqual([['setMood', 'a', 'waiting']]);
  });

  it('maps unknown to idle', () => {
    const { calls, sync } = setup();
    sync.update([session('a', 'unknown')]);
    expect(calls[1]).toEqual(['setMood', 'a', 'idle']);
  });

  it('releases a missing session exactly once', () => {
    const { calls, sync } = setup();
    sync.update([session('a', 'idle')]);
    calls.length = 0;
    sync.update([]);
    sync.update([]);
    expect(calls).toEqual([['release', 'a']]);
  });

  it('ensures a reappearing session again', () => {
    const { calls, sync } = setup();
    const s = session('a', 'idle');
    sync.update([s]);
    sync.update([]);
    calls.length = 0;
    sync.update([s]);
    expect(calls).toEqual([
      ['ensure', 'a', sessionHue(s)],
      ['setMood', 'a', 'idle'],
    ]);
  });
});
