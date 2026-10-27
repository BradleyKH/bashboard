import { AttentionTracker, type AttentionCause } from './attention';
import type { TerminalStatus } from './terminalStatus';

export interface PaneAttentionHooks {
  /** The pane is the focused, expanded pane and the document has focus. */
  isSeen: (paneId: string) => boolean;
  host: (paneId: string) => HTMLElement | undefined;
  onRaised: (paneId: string, cause: AttentionCause) => void;
}

/**
 * Applies the attention tracker to pane hosts (docs/design.md section 4.7). Each method returns
 * true when attention changed, so the workspace knows to notify its listeners.
 */
export class PaneAttention {
  private readonly tracker = new AttentionTracker();

  constructor(private readonly hooks: PaneAttentionHooks) {}

  observe(paneId: string, status: TerminalStatus): boolean {
    if (!this.tracker.observe(paneId, status, this.hooks.isSeen(paneId))) return false;
    this.raised(paneId, 'waiting');
    return true;
  }

  bell(paneId: string): boolean {
    if (!this.tracker.raise(paneId, this.hooks.isSeen(paneId))) return false;
    this.raised(paneId, 'bell');
    return true;
  }

  /** Clears the pane's attention when it is seen. */
  clearIfSeen(paneId: string): boolean {
    if (!paneId || !this.tracker.has(paneId) || !this.hooks.isSeen(paneId)) return false;
    this.tracker.clear(paneId);
    this.hooks.host(paneId)?.classList.remove('attention');
    return true;
  }

  has(paneId: string): boolean {
    return this.tracker.has(paneId);
  }

  forget(paneId: string): void {
    this.tracker.forget(paneId);
  }

  private raised(paneId: string, cause: AttentionCause): void {
    this.hooks.host(paneId)?.classList.add('attention');
    this.hooks.onRaised(paneId, cause);
  }
}
