import { programStatusReason, type ProgramStatusReport } from './programStatus';
import type { Session } from './sessions';

/**
 * 'done' is 'idle' after a Stop the user has not looked at yet (docs/design/data.md section 7).
 * 'failed' is display state beside it, set by a long shell command that exited nonzero.
 */
export type TerminalStatus = 'idle' | 'working' | 'waiting' | 'done' | 'failed';

/** The text shown with a `waiting` dot: the trimmed reason, or a generic one when it is blank. */
export function waitingText(reason: string | null | undefined): string {
  const trimmed = reason?.trim() ?? '';
  return trimmed === '' ? 'Waiting for you' : trimmed;
}

/** OSC 133 state a pane tracks: `seen` once any 133 marker arrived. */
export interface OscShellState {
  seen: boolean;
  running: boolean;
  changedAt: number;
}

/** Latest sweep verdict for the pane's pty, or null before the first sweep. */
export interface SweepState {
  busy: boolean;
  changedAt: number;
}

export interface ShellStatus {
  status: 'idle' | 'working';
  changedAt: number;
}

/** Shell-level status for a pane (docs/design/terminal.md section 4.8): OSC 133, then the sweep, then idle. */
export function shellStatus(
  osc: OscShellState,
  sweep: SweepState | null,
  openedAt: number,
): ShellStatus {
  if (osc.seen) {
    return { status: osc.running ? 'working' : 'idle', changedAt: osc.changedAt };
  }
  if (sweep) {
    return { status: sweep.busy ? 'working' : 'idle', changedAt: sweep.changedAt };
  }
  return { status: 'idle', changedAt: openedAt };
}

/**
 * What a program last reported through OSC 7501 (docs/design/sessions.md section 4.24).
 * `changedAt` moves when the state changes, `reportedAt` on every report.
 */
export interface ProgramStatusState {
  report: ProgramStatusReport;
  changedAt: number;
  reportedAt: number;
}

/** How long a bound session may stay unchanged before a program's working or blocked report wins. */
export const SESSION_QUIET_MS = 2 * 60 * 1000;

/**
 * Whether the program layer decides the status: no bound session or an `unknown` one, or one
 * whose hooks went quiet more than SESSION_QUIET_MS before a `working` or `blocked` report.
 */
export function programWins(session: Session | null, program: ProgramStatusState | null): boolean {
  if (!program) return false;
  if (!session || session.status === 'unknown') return true;
  const active = program.report.state === 'working' || program.report.state === 'blocked';
  return active && program.reportedAt - session.statusChangedAt > SESSION_QUIET_MS;
}

/** The program layer on its own: `blocked` is waiting, `done` is idle, `error` is failed. */
export function programStatus(program: ProgramStatusState): { status: TerminalStatus; changedAt: number } {
  const { changedAt } = program;
  switch (program.report.state) {
    case 'working':
      return { status: 'working', changedAt };
    case 'blocked':
      return { status: 'waiting', changedAt };
    case 'error':
      return { status: 'failed', changedAt };
    default:
      return { status: 'idle', changedAt };
  }
}

/** A bound session's status wins, then the program's own report, then the shell. */
export function terminalStatus(
  session: Session | null,
  shell: ShellStatus,
  program: ProgramStatusState | null = null,
): { status: TerminalStatus; changedAt: number } {
  if (programWins(session, program) && program) return programStatus(program);
  if (session) {
    switch (session.status) {
      case 'busy':
        return { status: 'working', changedAt: session.statusChangedAt };
      case 'idle':
        return { status: 'idle', changedAt: session.statusChangedAt };
      case 'waiting':
        return { status: 'waiting', changedAt: session.statusChangedAt };
    }
  }
  return { status: shell.status, changedAt: shell.changedAt };
}

/** The waiting line from whichever layer decides the status, as `waitingText` shows it. */
export function terminalWaitingText(session: Session | null, program: ProgramStatusState | null): string {
  if (programWins(session, program) && program) return waitingText(programStatusReason(program.report));
  return waitingText(session?.waitingReason);
}
