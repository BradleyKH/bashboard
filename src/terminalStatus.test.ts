import { describe, expect, it } from 'vitest';
import type { Session, SessionStatus } from './sessions';
import { shellStatus, terminalStatus } from './terminalStatus';

function session(status: SessionStatus): Session {
  return {
    sessionId: 's',
    pid: 1,
    name: null,
    cwd: 'C:',
    status,
    statusChangedAt: 500,
    startedAt: 0,
    version: null,
    paneId: 1,
  };
}

const notSeen = { seen: false, running: false, changedAt: 0 };

describe('shellStatus', () => {
  it('uses OSC 133 once seen, even against the sweep', () => {
    const osc = { seen: true, running: false, changedAt: 200 };
    expect(shellStatus(osc, { busy: true, changedAt: 300 }, 100)).toEqual({
      status: 'idle',
      changedAt: 200,
    });
    expect(shellStatus({ ...osc, running: true }, null, 100)).toEqual({
      status: 'working',
      changedAt: 200,
    });
  });

  it('falls back to the sweep when OSC 133 was never seen', () => {
    expect(shellStatus(notSeen, { busy: true, changedAt: 300 }, 100)).toEqual({
      status: 'working',
      changedAt: 300,
    });
    expect(shellStatus(notSeen, { busy: false, changedAt: 310 }, 100)).toEqual({
      status: 'idle',
      changedAt: 310,
    });
  });

  it('defaults to idle since the pane opened', () => {
    expect(shellStatus(notSeen, null, 100)).toEqual({ status: 'idle', changedAt: 100 });
  });
});

describe('terminalStatus', () => {
  const shell = { status: 'working' as const, changedAt: 50 };

  it('maps session statuses with the session timestamp', () => {
    expect(terminalStatus(session('busy'), { status: 'idle', changedAt: 50 })).toEqual({
      status: 'working',
      changedAt: 500,
    });
    expect(terminalStatus(session('idle'), shell)).toEqual({ status: 'idle', changedAt: 500 });
    expect(terminalStatus(session('waiting'), shell)).toEqual({
      status: 'waiting',
      changedAt: 500,
    });
  });

  it('falls through to the shell for unknown or no session', () => {
    expect(terminalStatus(session('unknown'), shell)).toEqual({ status: 'working', changedAt: 50 });
    expect(terminalStatus(null, shell)).toEqual({ status: 'working', changedAt: 50 });
  });

  it('never yields done; only the done tracker does', () => {
    for (const s of ['busy', 'idle', 'waiting', 'unknown'] as const) {
      expect(terminalStatus(session(s), shell).status).not.toBe('done');
    }
    expect(terminalStatus(null, { status: 'idle', changedAt: 1 }).status).not.toBe('done');
  });
});
