import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ContainersSnapshot } from './containers';

const api = vi.hoisted(() => ({
  listContainers: vi.fn(),
  onContainersChanged: vi.fn(),
}));

vi.mock('./containers', () => ({
  EMPTY_SNAPSHOT: { engines: [], containers: [] },
  listContainers: api.listContainers,
  onContainersChanged: api.onContainersChanged,
}));

const { ContainersStore } = await import('./containersStore');

const docker: ContainersSnapshot = {
  engines: [{ engine: 'docker', running: true, canStart: false, pending: null }],
  containers: [],
} as unknown as ContainersSnapshot;

describe('ContainersStore.ready', () => {
  beforeEach(() => {
    api.listContainers.mockReset();
    api.onContainersChanged.mockReset().mockResolvedValue(() => {});
  });

  it('is false until the first snapshot arrives', async () => {
    let resolve!: (s: ContainersSnapshot) => void;
    api.listContainers.mockReturnValue(new Promise((r) => (resolve = r)));
    const store = new ContainersStore();
    const started = store.start();
    expect(store.ready).toBe(false);
    resolve(docker);
    await started;
    expect(store.ready).toBe(true);
    expect(store.available).toBe(true);
  });

  it('turns ready and notifies when the first read fails', async () => {
    api.listContainers.mockRejectedValue(new Error('no core'));
    const store = new ContainersStore();
    const seen = vi.fn();
    store.subscribe(seen);
    await store.start();
    expect(store.ready).toBe(true);
    expect(store.available).toBe(false);
    expect(seen).toHaveBeenCalledTimes(1);
  });
});
