export interface PollGate {
  enabled: boolean;
  expanded: boolean;
  onScreen: boolean;
  windowShown: boolean;
}

export function shouldPoll(g: PollGate): boolean {
  return g.enabled && g.expanded && g.onScreen && g.windowShown;
}

/**
 * Runs `tick` on an interval only while every gate field is true (docs/design/dashboard.md
 * section 4.6's polling rule): a disabled, collapsed, off-screen, or hidden section costs nothing,
 * and the next start ticks at once so the data is never staler than one interval after it
 * reappears.
 */
export class PollTimer {
  private gate: PollGate = { enabled: false, expanded: false, onScreen: false, windowShown: true };
  private handle: ReturnType<typeof setInterval> | undefined;

  constructor(
    private readonly intervalMs: number,
    private readonly tick: () => void,
  ) {}

  setGate(partial: Partial<PollGate>): void {
    const wasPolling = shouldPoll(this.gate);
    this.gate = { ...this.gate, ...partial };
    const polling = shouldPoll(this.gate);
    if (polling === wasPolling) return;
    if (polling) {
      this.tick();
      this.handle = setInterval(this.tick, this.intervalMs);
    } else if (this.handle !== undefined) {
      clearInterval(this.handle);
      this.handle = undefined;
    }
  }
}
