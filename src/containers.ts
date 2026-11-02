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

export type EngineLifecycle = 'starting' | 'stopping';

/** An engine whose CLI exists; an engine with no CLI never appears. */
export interface EngineState {
  engine: Engine;
  running: boolean;
  /** A start or stop the app has in flight. */
  pending: EngineLifecycle | null;
  /** Whether the app knows how to start this engine (Docker Desktop or a Podman machine). */
  canStart: boolean;
  /** Whether the app knows how to stop it; an older Docker Desktop can only be started. */
  canStop: boolean;
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

/** Resolves once the engine answers, after the snapshot has already shown it starting. */
export function startEngine(engine: Engine): Promise<void> {
  return invoke('containers_engine_start', { engine });
}

/** Stops Docker Desktop or the Podman machine, and with it every container on the engine. */
export function stopEngine(engine: Engine): Promise<void> {
  return invoke('containers_engine_stop', { engine });
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
