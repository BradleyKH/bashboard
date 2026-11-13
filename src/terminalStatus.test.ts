import { describe, expect, it } from 'vitest';
import type { Session, SessionStatus } from './sessions';
import type { ProgramState, ProgramStatusReport } from './programStatus';
import {
  SESSION_QUIET_MS,
  shellStatus,
  terminalStatus,
  terminalWaitingText,
  waitingText,
  type ProgramStatusState,
} from './terminalStatus';

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
    waitingReason: null,
    agent: 'claude',
  };
}

function program(state: ProgramState, at = 1000, over: Partial<ProgramStatusReport> = {}): ProgramStatusState {
  return { report: { state, ...over }, changedAt: at, reportedAt: at };
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

describe('waitingText', () => {
  it('trims the reason', () => {
    expect(waitingText('  Claude needs your permission to use Bash\t')).toBe(
      'Claude needs your permission to use Bash',
    );
  });

  it('falls back when the reason is missing or blank', () => {
    expect(waitingText(null)).toBe('Waiting for you');
    expect(waitingText(undefined)).toBe('Waiting for you');
    expect(waitingText('')).toBe('Waiting for you');
    expect(waitingText('   ')).toBe('Waiting for you');
  });
});

describe('terminalStatus with a program layer', () => {
  const shell = { status: 'working' as const, changedAt: 50 };

  it('uses the program status with no session, over the shell', () => {
    expect(terminalStatus(null, shell, program('idle'))).toEqual({ status: 'idle', changedAt: 1000 });
    expect(terminalStatus(null, shell, program('working'))).toEqual({ status: 'working', changedAt: 1000 });
    expect(terminalStatus(session('unknown'), shell, program('done'))).toEqual({ status: 'idle', changedAt: 1000 });
  });

  it('maps blocked to waiting and error to failed', () => {
    expect(terminalStatus(null, shell, program('blocked', 1000, { kind: 'permission' }))).toEqual({
      status: 'waiting',
      changedAt: 1000,
    });
    expect(terminalStatus(null, shell, program('error'))).toEqual({ status: 'failed', changedAt: 1000 });
  });

  it('lets a bound session win', () => {
    expect(terminalStatus(session('idle'), shell, program('working'))).toEqual({ status: 'idle', changedAt: 500 });
    expect(terminalStatus(session('busy'), shell, program('idle'))).toEqual({ status: 'working', changedAt: 500 });
  });

  it('lets a newer program working or blocked win over a session gone quiet', () => {
    const late = 500 + SESSION_QUIET_MS + 1;
    expect(terminalStatus(session('idle'), shell, program('working', late))).toEqual({
      status: 'working',
      changedAt: late,
    });
    expect(terminalStatus(session('idle'), shell, program('blocked', late)).status).toBe('waiting');
    // Exactly at the threshold the session still wins.
    expect(terminalStatus(session('idle'), shell, program('working', 500 + SESSION_QUIET_MS)).status).toBe('idle');
  });

  it('does not let a quiet session yield to a program idle or done', () => {
    const late = 500 + SESSION_QUIET_MS + 1;
    expect(terminalStatus(session('busy'), shell, program('idle', late))).toEqual({ status: 'working', changedAt: 500 });
    expect(terminalStatus(session('busy'), shell, program('done', late)).status).toBe('working');
  });

  it('judges quiet by the latest report, not the last state change', () => {
    const p = { ...program('working', 600), reportedAt: 500 + SESSION_QUIET_MS + 1 };
    expect(terminalStatus(session('idle'), shell, p)).toEqual({ status: 'working', changedAt: 600 });
  });
});

describe('terminalWaitingText', () => {
  const waitingSession = { ...session('waiting'), waitingReason: 'Claude needs your permission to use Bash' };

  it('reads the program message, then its kind, when the program decides', () => {
    expect(terminalWaitingText(null, program('blocked', 1000, { kind: 'permission', msg: 'Allow rm?' }))).toBe(
      'Allow rm?',
    );
    expect(terminalWaitingText(null, program('blocked', 1000, { kind: 'question' }))).toBe('Has a question');
    expect(terminalWaitingText(null, program('blocked'))).toBe('Waiting for you');
  });

  it('reads the session reason when the session decides', () => {
    expect(terminalWaitingText(waitingSession, program('blocked', 1000, { msg: 'other' }))).toBe(
      'Claude needs your permission to use Bash',
    );
    expect(terminalWaitingText(waitingSession, null)).toBe('Claude needs your permission to use Bash');
  });
});
