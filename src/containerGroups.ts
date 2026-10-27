import type { Container, ContainersSnapshot, Engine } from './containers';

export type GroupState = 'running' | 'partial' | 'stopped';

export interface ContainerGroup {
  /** Stable across snapshots: engine plus project, or engine plus container id. */
  key: string;
  name: string;
  engine: Engine;
  containers: Container[];
  state: GroupState;
}

export interface DashboardGroupRow {
  kind: 'group';
  name: string;
  state: GroupState;
  running: number;
  total: number;
  /** Show Start. */
  anyStopped: boolean;
  /** Show Stop. */
  anyRunning: boolean;
  /** Every member group's key, one per engine at most. */
  groupKeys: string[];
}

export interface DashboardUnavailableRow {
  kind: 'unavailable';
  engine: Engine;
}

export type DashboardContainerRow = DashboardGroupRow | DashboardUnavailableRow;

export function engineLabel(engine: Engine): string {
  return engine === 'docker' ? 'Docker' : 'Podman';
}

function stateOf(running: number, total: number): GroupState {
  if (running === 0) return 'stopped';
  return running === total ? 'running' : 'partial';
}

function byLabel(a: Container, b: Container): number {
  return (a.service ?? a.name).localeCompare(b.service ?? b.name) || a.name.localeCompare(b.name);
}

/** Groups by engine and Compose project; a container with no project is its own group. */
export function groupContainers(containers: Container[]): ContainerGroup[] {
  const byKey = new Map<string, ContainerGroup>();
  for (const c of containers) {
    const key = c.project ? `${c.engine}:project:${c.project}` : `${c.engine}:container:${c.id}`;
    let g = byKey.get(key);
    if (!g) {
      g = { key, name: c.project ?? c.name, engine: c.engine, containers: [], state: 'stopped' };
      byKey.set(key, g);
    }
    g.containers.push(c);
  }
  const groups = [...byKey.values()];
  for (const g of groups) {
    g.containers.sort(byLabel);
    const running = g.containers.filter((c) => c.state === 'running').length;
    g.state = stateOf(running, g.containers.length);
  }
  return groups.sort((a, b) => a.name.localeCompare(b.name) || a.engine.localeCompare(b.engine));
}

/** One row per group name (same-named groups on both engines merge), then a row per stopped engine. */
export function dashboardRows(snapshot: ContainersSnapshot): DashboardContainerRow[] {
  const merged = new Map<string, DashboardGroupRow>();
  for (const g of groupContainers(snapshot.containers)) {
    const running = g.containers.filter((c) => c.state === 'running').length;
    const total = g.containers.length;
    const row = merged.get(g.name);
    if (row) {
      row.running += running;
      row.total += total;
      row.groupKeys.push(g.key);
    } else {
      merged.set(g.name, {
        kind: 'group',
        name: g.name,
        state: 'stopped',
        running,
        total,
        anyStopped: false,
        anyRunning: false,
        groupKeys: [g.key],
      });
    }
  }
  const rows = [...merged.values()];
  for (const r of rows) {
    r.state = stateOf(r.running, r.total);
    r.anyRunning = r.running > 0;
    r.anyStopped = r.running < r.total;
  }
  const unavailable: DashboardUnavailableRow[] = snapshot.engines
    .filter((e) => !e.running)
    .map((e) => ({ kind: 'unavailable', engine: e.engine }));
  return [...rows, ...unavailable];
}
