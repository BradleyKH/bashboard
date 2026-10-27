import { describe, expect, it } from 'vitest';
import type { Container, ContainersSnapshot } from './containers';
import { shellCommand } from './containers';
import { dashboardRows, engineLabel, groupContainers } from './containerGroups';

function c(over: Partial<Container> & { id: string }): Container {
  return {
    engine: 'docker',
    name: over.id,
    image: 'img',
    state: 'running',
    statusText: '',
    ports: [],
    project: null,
    service: null,
    ...over,
  };
}

describe('groupContainers', () => {
  it('groups by engine and project, sorting members by service', () => {
    const groups = groupContainers([
      c({ id: '1', name: 'p-web-1', project: 'p', service: 'web' }),
      c({ id: '2', name: 'p-cache-1', project: 'p', service: 'cache' }),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].key).toBe('docker:project:p');
    expect(groups[0].containers.map((x) => x.service)).toEqual(['cache', 'web']);
  });

  it('keeps the same project on two engines as separate groups', () => {
    const groups = groupContainers([
      c({ id: '1', project: 'p' }),
      c({ id: '2', project: 'p', engine: 'podman' }),
    ]);
    expect(groups.map((g) => g.key)).toEqual(['docker:project:p', 'podman:project:p']);
  });

  it('makes an ungrouped container its own group named after it', () => {
    const [g] = groupContainers([c({ id: 'abc', name: 'solo' })]);
    expect(g.name).toBe('solo');
    expect(g.key).toBe('docker:container:abc');
  });

  it('derives running, partial, and stopped', () => {
    const state = (states: Container['state'][]) =>
      groupContainers(states.map((s, i) => c({ id: String(i), project: 'p', state: s })))[0].state;
    expect(state(['running', 'running'])).toBe('running');
    expect(state(['running', 'exited'])).toBe('partial');
    expect(state(['exited', 'paused'])).toBe('stopped');
  });

  it('sorts groups by name', () => {
    const groups = groupContainers([c({ id: '1', name: 'zeta' }), c({ id: '2', name: 'alpha' })]);
    expect(groups.map((g) => g.name)).toEqual(['alpha', 'zeta']);
  });
});

describe('dashboardRows', () => {
  it('merges same-named groups across engines with a combined count', () => {
    const snapshot: ContainersSnapshot = {
      engines: [
        { engine: 'docker', running: true },
        { engine: 'podman', running: true },
      ],
      containers: [
        c({ id: '1', project: 'p', state: 'running' }),
        c({ id: '2', project: 'p', state: 'exited', engine: 'podman' }),
      ],
    };
    expect(dashboardRows(snapshot)).toEqual([
      {
        kind: 'group',
        name: 'p',
        state: 'partial',
        running: 1,
        total: 2,
        anyStopped: true,
        anyRunning: true,
        groupKeys: ['docker:project:p', 'podman:project:p'],
      },
    ]);
  });

  it('shows Start only for a stopped group and Stop only for a running one', () => {
    const rows = dashboardRows({
      engines: [{ engine: 'docker', running: true }],
      containers: [c({ id: '1', name: 'a', state: 'exited' }), c({ id: '2', name: 'b' })],
    });
    expect(rows[0]).toMatchObject({ name: 'a', anyStopped: true, anyRunning: false });
    expect(rows[1]).toMatchObject({ name: 'b', anyStopped: false, anyRunning: true });
  });

  it('adds an unavailable row for an engine that is not running', () => {
    const rows = dashboardRows({
      engines: [
        { engine: 'docker', running: true },
        { engine: 'podman', running: false },
      ],
      containers: [],
    });
    expect(rows).toEqual([{ kind: 'unavailable', engine: 'podman' }]);
  });
});

describe('engineLabel and shellCommand', () => {
  it('labels engines', () => {
    expect(engineLabel('docker')).toBe('Docker');
    expect(engineLabel('podman')).toBe('Podman');
  });

  it('builds the exec command', () => {
    expect(shellCommand({ engine: 'podman', id: 'abc' })).toEqual([
      'podman.exe',
      'exec',
      '-it',
      '--',
      'abc',
      'sh',
      '-c',
      'command -v bash >/dev/null && exec bash || exec sh',
    ]);
  });
});
