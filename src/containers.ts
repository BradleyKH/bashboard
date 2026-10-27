import { Channel, invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';

export type Engine = 'docker' | 'podman';

export type ContainerState =
  | 'running'
  | 'paused'
  | 'exited'
  | 'created'
  | 'restarting'
  | 'dead'
  | 'unknown';

export type ContainerAction = 'start' | 'stop' | 'restart';

export interface ContainerPort {
  host: number;
  container: number;
  protocol: string;
}

/** A container from either engine (docs/design.md section 7). */
export interface Container {
  engine: Engine;
  id: string;
  name: string;
  image: string;
  state: ContainerState;
  /** The engine's own text, e.g. "Up 3 hours". */
  statusText: string;
  ports: ContainerPort[];
  project: string | null;
  service: string | null;
}

/** An engine whose CLI exists; an engine with no CLI never appears. */
export interface EngineState {
  engine: Engine;
  running: boolean;
}

export interface ContainersSnapshot {
  engines: EngineState[];
  containers: Container[];
}

export interface ContainerStats {
  engine: Engine;
  id: string;
  cpuPercent: number | null;
  /** The engine's own usage text, e.g. "12.5MiB / 7.6GiB". */
  memUsage: string | null;
  memPercent: number | null;
}

export const EMPTY_SNAPSHOT: ContainersSnapshot = { engines: [], containers: [] };

export function listContainers(): Promise<ContainersSnapshot> {
  return invoke<ContainersSnapshot>('containers_list');
}

export function containerAction(engine: Engine, ids: string[], action: ContainerAction): Promise<void> {
  return invoke('containers_action', { engine, ids, action });
}

/** Streams `logs -f --tail 500` as raw bytes (stdout and stderr interleaved); resolves to the stream id. */
export function startLogs(engine: Engine, id: string, onBytes: (bytes: Uint8Array) => void): Promise<number> {
  const onData = new Channel<ArrayBuffer>();
  onData.onmessage = (bytes) => onBytes(new Uint8Array(bytes));
  return invoke<number>('containers_logs', { engine, id, onData });
}

export function stopLogs(streamId: number): Promise<void> {
  return invoke('containers_logs_stop', { streamId });
}

export function containerStats(engine: Engine, ids: string[]): Promise<ContainerStats[]> {
  return invoke<ContainerStats[]>('containers_stats', { engine, ids });
}

/** Resolves to a no-op unlisten outside Tauri, where `listen` rejects. */
export async function onContainersChanged(cb: (s: ContainersSnapshot) => void): Promise<UnlistenFn> {
  try {
    return await listen<ContainersSnapshot>('containers://changed', (e) => cb(e.payload));
  } catch {
    return () => {};
  }
}

/** The pty_spawn command for a shell inside a container (docs/design.md section 3.10). */
export function shellCommand(container: Pick<Container, 'engine' | 'id'>): string[] {
  return [
    // Docker Desktop puts an extension-less shell script named docker beside docker.exe, and the
    // pty would resolve the bare name to it.
    `${container.engine}.exe`,
    'exec',
    '-it',
    '--',
    container.id,
    'sh',
    '-c',
    'command -v bash >/dev/null && exec bash || exec sh',
  ];
}
