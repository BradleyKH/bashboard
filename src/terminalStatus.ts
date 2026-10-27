import type { Session } from './sessions';

/** 'done' is 'idle' after a Stop the user has not looked at yet (docs/design.md section 7). */
export type TerminalStatus = 'idle' | 'working' | 'waiting' | 'done';

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

/** Shell-level status for a pane (docs/design.md section 4.8): OSC 133, then the sweep, then idle. */
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

/** A bound session's status wins; `unknown` or no session falls through to the shell. */
export function terminalStatus(
  session: Session | null,
  shell: ShellStatus,
): { status: TerminalStatus; changedAt: number } {
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
