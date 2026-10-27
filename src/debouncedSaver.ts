/** Saves `snapshot()` once changes settle, skipping a save whose JSON matches the last one. */
export class DebouncedSaver<T> {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private lastJson: string | null = null;
  private inFlight: Promise<void> | null = null;

  constructor(
    private readonly snapshot: () => T,
    private readonly save: (data: T) => Promise<void>,
    private readonly delayMs: number,
  ) {}

  schedule(): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.flush().catch((e) => console.warn('save failed:', e));
    }, this.delayMs);
  }

  /** Saves now if anything changed, cancelling any pending save. */
  async flush(): Promise<void> {
    clearTimeout(this.timer);
    this.timer = undefined;
    const data = this.snapshot();
    const json = JSON.stringify(data);
    if (json === this.lastJson) return;
    const saving = this.save(data);
    this.inFlight = saving;
    try {
      await saving;
    } finally {
      if (this.inFlight === saving) this.inFlight = null;
    }
    // Recorded only after success, so a failed save is retried on the next change.
    this.lastJson = json;
  }

  /** Drops a pending save and resolves once any save already running has settled. */
  async cancel(): Promise<void> {
    clearTimeout(this.timer);
    this.timer = undefined;
    await this.inFlight?.catch(() => undefined);
  }
}
