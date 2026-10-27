import type { TerminalStatus } from './terminalStatus';

export type AttentionCause = 'waiting' | 'bell';

/** Tracks which panes are asking for the user (docs/design.md section 4.7). */
export class AttentionTracker {
  private readonly raised = new Set<string>();
  private readonly lastStatus = new Map<string, TerminalStatus>();

  /**
   * Records a pane's latest status. Entering 'waiting' (from any other status, or on the
   * pane's first observation) raises attention unless `seen`. Returns true when attention was
   * newly raised by this call.
   */
  observe(paneId: string, status: TerminalStatus, seen: boolean): boolean {
    const previous = this.lastStatus.get(paneId);
    this.lastStatus.set(paneId, status);
    if (status !== 'waiting' || previous === 'waiting') return false;
    return this.raise(paneId, seen);
  }

  /** Raises attention (the bell) unless `seen`; true when newly raised. */
  raise(paneId: string, seen: boolean): boolean {
    if (seen || this.raised.has(paneId)) return false;
    this.raised.add(paneId);
    return true;
  }

  /** True when attention was set and is now cleared. */
  clear(paneId: string): boolean {
    return this.raised.delete(paneId);
  }

  has(paneId: string): boolean {
    return this.raised.has(paneId);
  }

  forget(paneId: string): void {
    this.raised.delete(paneId);
    this.lastStatus.delete(paneId);
  }
}
