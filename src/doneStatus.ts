import type { Session } from './sessions';
import type { ProgramState } from './programStatus';
import type { TerminalStatus } from './terminalStatus';

interface SessionMark {
  kind: 'session';
  sessionId: string;
  /** Epoch ms of the Stop hook. */
  at: number;
  /** Whether the roster has shown the session bound since the mark. */
  bound: boolean;
  failed: false;
}

interface CommandMark {
  kind: 'command';
  /** Epoch ms of the OSC 133 `D` that ended the command. */
  at: number;
  failed: boolean;
}

interface ProgramMark {
  kind: 'program';
  /** Epoch ms of the OSC 7501 report that ended the work. */
  at: number;
  failed: boolean;
}

interface RunMark {
  kind: 'run';
  /** Epoch ms the bound CI run was seen finishing. */
  at: number;
  failed: boolean;
}

type DoneMark = SessionMark | CommandMark | ProgramMark | RunMark;

interface ResolvedStatus {
  status: TerminalStatus;
  changedAt: number;
}

export interface CommandEnd {
  durationMs: number;
  /** Null when the `D` carried no exit code. */
  exitCode: number | null;
  /** Epoch ms of the `D`. */
  at: number;
  seen: boolean;
  /** `terminal.doneAfterSeconds`; 0 or less turns command marks off. */
  minSeconds: number;
}

/** Exit code bash reports for a command interrupted with Ctrl+C. */
const INTERRUPTED = 130;

/**
 * Tracks which terminals show `done` or `failed` (docs/design/terminal.md section 4.8), from one
 * mark per pane, a newer mark of either kind replacing the old one. A `session` mark is a bound
 * session's Stop that arrived while the terminal was not being looked at; it shows `done`. A
 * `command` mark is a long shell command that finished unseen; it shows `done`, or `failed` when
 * the command exited nonzero, and clears on the next command's start. A `program` mark is an
 * OSC 7501 report moving from working or blocked to done or idle (`done`) or to error (`failed`)
 * while unseen, the hookless counterpart of a Stop. A `run` mark is a CI run bound to the pane
 * (docs/design/ship.md section 4.26) finishing unseen; it shows `done` or `failed` and, like a
 * program mark, yields to work that starts after it. Pure display state layered
 * over the resolved status; it never reaches the roster or the backdrop.
 */
export class DoneTracker {
  private readonly marks = new Map<string, DoneMark>();

  /** Records a Stop for the pane's bound session unless the pane is being looked at. */
  mark(paneId: string, sessionId: string, at: number, seen: boolean): boolean {
    if (seen) return false;
    this.marks.set(paneId, { kind: 'session', sessionId, at, bound: false, failed: false });
    return true;
  }

  /** Records a finished shell command (OSC 133 `D`) if it ran long enough and was not seen. */
  markCommand(paneId: string, end: CommandEnd): boolean {
    if (end.minSeconds <= 0 || end.durationMs < end.minSeconds * 1000) return false;
    if (end.exitCode === INTERRUPTED || end.seen) return false;
    const failed = end.exitCode !== null && end.exitCode !== 0;
    this.marks.set(paneId, { kind: 'command', at: end.at, failed });
    return true;
  }

  /** Records a program's own report (OSC 7501) finishing its work while the pane was not seen. */
  markProgram(paneId: string, prev: ProgramState | null, next: ProgramState | null, at: number, seen: boolean): boolean {
    if (seen || (prev !== 'working' && prev !== 'blocked')) return false;
    if (next !== 'done' && next !== 'idle' && next !== 'error') return false;
    this.marks.set(paneId, { kind: 'program', at, failed: next === 'error' });
    return true;
  }

  /** Records a bound CI run finishing while the pane was not seen. */
  markRun(paneId: string, failed: boolean, at: number, seen: boolean): boolean {
    if (seen) return false;
    this.marks.set(paneId, { kind: 'run', at, failed });
    return true;
  }

  /** Drops the pane's command mark when the next command starts (OSC 133 `C`). */
  commandStarted(paneId: string): boolean {
    if (this.marks.get(paneId)?.kind !== 'command') return false;
    return this.marks.delete(paneId);
  }

  resolve(paneId: string, session: Session | null, base: ResolvedStatus): ResolvedStatus {
    const mark = this.marks.get(paneId);
    if (!mark) return base;
    if (mark.kind === 'command') {
      // A bound session hides the mark rather than dropping it: when `claude` exits after a long
      // run, its `D` arrives before the roster drops the session, and it should still show once
      // the roster catches up.
      if (session) return base;
      return { status: mark.failed ? 'failed' : 'done', changedAt: mark.at };
    }
    if (mark.kind === 'program' || mark.kind === 'run') {
      // Work that started after the mark replaces it; anything quieter keeps it showing.
      if (base.status === 'working' || base.status === 'waiting') {
        if (base.changedAt > mark.at) this.marks.delete(paneId);
        return base;
      }
      return { status: mark.failed ? 'failed' : 'done', changedAt: mark.at };
    }
    // A null session before the roster has shown the binding is a first-ever hook that was the
    // Stop itself; after it, null means the session ended.
    if (session ? session.sessionId !== mark.sessionId : mark.bound) {
      this.marks.delete(paneId);
      return base;
    }
    if (session) mark.bound = true;
    if (base.status !== 'idle' && base.changedAt > mark.at) {
      this.marks.delete(paneId);
      return base;
    }
    // sessions://hook arrives before the roster refresh, so the base can still be the pre-Stop
    // status; keep the mark until the roster catches up. A later roster idle is the Stop
    // confirmed, not a new status, so it keeps the mark too.
    if (base.status === 'idle') return { status: 'done', changedAt: base.changedAt };
    return base;
  }

  clear(paneId: string): boolean {
    return this.marks.delete(paneId);
  }

  has(paneId: string): boolean {
    return this.marks.has(paneId);
  }

  forget(paneId: string): void {
    this.marks.delete(paneId);
  }
}
