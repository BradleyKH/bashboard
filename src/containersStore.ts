import { EMPTY_SNAPSHOT, listContainers, onContainersChanged, type ContainersSnapshot } from './containers';

/** The latest container snapshot, shared by the Containers panes and the dashboard section. */
export class ContainersStore {
  private snapshot: ContainersSnapshot = EMPTY_SNAPSHOT;
  private loaded = false;
  private readonly subscribers = new Set<(s: ContainersSnapshot) => void>();

  /** Loads the first snapshot and follows `containers://changed`; never throws outside Tauri. */
  async start(): Promise<void> {
    await onContainersChanged((s) => this.set(s));
    try {
      this.set(await listContainers());
    } catch {
      // No core (browser-only run) or no engine; the snapshot stays empty.
      if (!this.loaded) this.set(this.snapshot);
    }
  }

  current(): ContainersSnapshot {
    return this.snapshot;
  }

  /** False until the first snapshot (or the failure to read one) is in. */
  get ready(): boolean {
    return this.loaded;
  }

  /** True when at least one engine's CLI exists. */
  get available(): boolean {
    return this.snapshot.engines.length > 0;
  }

  /** Does not call back immediately. */
  subscribe(cb: (s: ContainersSnapshot) => void): () => void {
    this.subscribers.add(cb);
    return () => this.subscribers.delete(cb);
  }

  private set(s: ContainersSnapshot): void {
    this.snapshot = s;
    this.loaded = true;
    for (const cb of [...this.subscribers]) cb(s);
  }
}
