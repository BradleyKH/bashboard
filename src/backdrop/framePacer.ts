/** Absorbs requestAnimationFrame jitter so a cap equal to the refresh rate never drops frames. */
const TOLERANCE_MS = 1;

/** Decides which requestAnimationFrame callbacks render under a `maxFps` cap (docs/design.md section 6.4). */
export class FramePacer {
  private intervalMs = 0;
  private nextAt = -Infinity;

  /** 0 means uncapped. */
  setMaxFps(maxFps: number): void {
    this.intervalMs = maxFps > 0 ? 1000 / maxFps : 0;
    this.reset();
  }

  /** Lets the next frame render immediately, e.g. after resuming. */
  reset(): void {
    this.nextAt = -Infinity;
  }

  shouldRender(timestampMs: number): boolean {
    if (this.intervalMs === 0) return true;
    if (timestampMs < this.nextAt - TOLERANCE_MS) return false;
    // Scheduling from the previous target rather than from now keeps the average rate at the cap
    // when it does not divide the refresh rate. After a stall, resync so it does not burst.
    this.nextAt += this.intervalMs;
    if (this.nextAt < timestampMs) this.nextAt = timestampMs + this.intervalMs;
    return true;
  }
}
