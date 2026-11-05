import { pollModelServers, type ModelServersSnapshot } from './modelServersApi';

const POLL_MS = 5000;

/**
 * The latest model-server snapshot for the dashboard's Local AI models section and the Panes card.
 * Like PortsStore it polls only while some consumer wants it, and the next demand polls at once.
 * An unreachable core leaves the snapshot as it was.
 */
export class LocalModelsStore {
  private snap: ModelServersSnapshot | null = null;
  private readonly subscribers = new Set<(s: ModelServersSnapshot) => void>();
  private readonly wanted = new Set<string>();
  private timer: ReturnType<typeof setInterval> | undefined;
  private inFlight = false;

  /** Null until the first poll answers. */
  current(): ModelServersSnapshot | null {
    return this.snap;
  }

  /** Does not call back immediately. */
  subscribe(cb: (s: ModelServersSnapshot) => void): () => void {
    this.subscribers.add(cb);
    return () => this.subscribers.delete(cb);
  }

  /** Each consumer turns its own `key` on and off; polling runs while any key is on. */
  setWanted(key: string, wanted: boolean): void {
    const was = this.wanted.size > 0;
    if (wanted) this.wanted.add(key);
    else this.wanted.delete(key);
    const now = this.wanted.size > 0;
    if (now === was) return;
    if (now) {
      void this.refresh();
      this.timer = setInterval(() => void this.refresh(), POLL_MS);
    } else if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  async refresh(): Promise<void> {
    if (this.inFlight) return;
    this.inFlight = true;
    try {
      const next = await pollModelServers();
      this.snap = next;
      for (const cb of [...this.subscribers]) cb(next);
    } catch {
      // No core (a browser-only run).
    } finally {
      this.inFlight = false;
    }
  }
}
