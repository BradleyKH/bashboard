import type { UnlistenFn } from '@tauri-apps/api/event';
import { claudeContext, claudeContextStop, onClaudeContext } from './claudeApi';
import type { ClaudeContext } from './claudeModel';

/**
 * Each Claude session's newest model and context, tracked from the core while enabled (docs/design.md
 * section 4.6). `onChange` fires after any context arrives or the set is cleared.
 */
export class ClaudeContexts {
  private readonly contexts = new Map<string, ClaudeContext>();
  private enabled = false;
  private unlisten: UnlistenFn | undefined;
  // Bumped on every stop so a late listen or snapshot from the old subscription is dropped.
  private epoch = 0;

  constructor(private readonly onChange: () => void) {}

  get(sessionId: string): ClaudeContext | undefined {
    return this.contexts.get(sessionId);
  }

  setEnabled(enabled: boolean): void {
    if (enabled === this.enabled) return;
    this.enabled = enabled;
    if (enabled) this.start();
    else this.stop();
  }

  private start(): void {
    const epoch = this.epoch;
    void onClaudeContext((ctx) => {
      this.contexts.set(ctx.sessionId, ctx);
      this.onChange();
    })
      .then((un) => {
        if (epoch === this.epoch) this.unlisten = un;
        else un();
      })
      .catch(() => {});
    // An event can land before the snapshot resolves; the snapshot must not overwrite it.
    void claudeContext()
      .then((all) => {
        if (epoch !== this.epoch) return;
        for (const ctx of all) if (!this.contexts.has(ctx.sessionId)) this.contexts.set(ctx.sessionId, ctx);
        this.onChange();
      })
      .catch(() => {});
  }

  // The core forgets its sessions on stop, so stale contexts are dropped here too.
  private stop(): void {
    this.epoch++;
    this.unlisten?.();
    this.unlisten = undefined;
    this.contexts.clear();
    this.onChange();
    void claudeContextStop().catch(() => {});
  }
}
