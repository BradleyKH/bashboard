import type { Session } from './sessions';
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

type DoneMark = SessionMark | CommandMark;

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
 * the command exited nonzero, and clears on the next command's start. Pure display state layered
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
