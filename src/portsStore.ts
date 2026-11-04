import { listPorts, type Listener } from './ports';

const POLL_MS = 3000;

/**
 * The latest listener list, shared by the dashboard's Ports section and every Ports pane. It
 * polls only while some consumer wants it (an expanded pane, a section on screen), and the next
 * demand polls at once so nothing shown is older than one interval.
 */
export class PortsStore {
  private list: Listener[] = [];
  private loaded = false;
  private readonly subscribers = new Set<(list: Listener[]) => void>();
  private readonly wanted = new Set<string>();
  private timer: ReturnType<typeof setInterval> | undefined;
  private inFlight = false;

  current(): Listener[] {
    return this.list;
  }

  /** False until the first poll answers. */
  get ready(): boolean {
    return this.loaded;
  }

  /** Does not call back immediately. */
  subscribe(cb: (list: Listener[]) => void): () => void {
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

  /** Polls now, as after a stop, rather than waiting out the interval. */
  async refresh(): Promise<void> {
    if (this.inFlight) return;
    this.inFlight = true;
    try {
      const next = await listPorts();
      this.loaded = true;
      this.list = next;
      for (const cb of [...this.subscribers]) cb(next);
    } catch {
      // No core (a browser-only run); the list stays as it was.
    } finally {
      this.inFlight = false;
    }
  }
}
