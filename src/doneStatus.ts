import type { Session } from './sessions';
import type { TerminalStatus } from './terminalStatus';

interface DoneMark {
  sessionId: string;
  /** Epoch ms of the Stop hook. */
  at: number;
  /** Whether the roster has shown the session bound since the mark. */
  bound: boolean;
}

interface ResolvedStatus {
  status: TerminalStatus;
  changedAt: number;
}

/**
 * Tracks which terminals show `done` (docs/design.md section 4.8): a bound session's Stop that
 * arrived while the terminal was not being looked at. Pure display state layered over the
 * resolved status; it never reaches the roster or the backdrop.
 */
export class DoneTracker {
  private readonly marks = new Map<string, DoneMark>();

  /** Records a Stop for the pane's bound session unless the pane is being looked at. */
  mark(paneId: string, sessionId: string, at: number, seen: boolean): boolean {
    if (seen) return false;
    this.marks.set(paneId, { sessionId, at, bound: false });
    return true;
  }

  resolve(paneId: string, session: Session | null, base: ResolvedStatus): ResolvedStatus {
    const mark = this.marks.get(paneId);
    if (!mark) return base;
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
