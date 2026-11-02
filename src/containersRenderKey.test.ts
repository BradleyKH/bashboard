import { describe, expect, it } from 'vitest';
import type { Container } from './containers';
import { groupContainers } from './containerGroups';
import { engineBusyKey, renderKey, type RenderKeyInput } from './containersRenderKey';

function container(over: Partial<Container> = {}): Container {
  return {
    engine: 'docker',
    id: 'abc',
    name: 'web',
    image: 'nginx',
    state: 'running',
    statusText: 'Up 3 hours',
    ports: [{ host: 8080, container: 80, protocol: 'tcp' }],
    project: null,
    service: null,
    ...over,
  };
}

function input(containers: Container[], over: Partial<RenderKeyInput> = {}): RenderKeyInput {
  return {
    engines: [{ engine: 'docker', running: true, pending: null, canStart: false, canStop: false }],
    groups: groupContainers(containers),
    expandedGroups: new Set(['docker:container:abc']),
    busy: new Set(),
    logsKey: null,
    usageText: () => 'CPU 1.0%',
    ...over,
  };
}

describe('renderKey', () => {
  const base = input([container()]);

  it('ignores status text and usage numbers', () => {
    const next = input([container({ statusText: 'Up 4 hours' })], { usageText: () => 'CPU 9.9%' });
    expect(renderKey(next)).toBe(renderKey(base));
  });

  it('changes when a container state, set, or order changes', () => {
    expect(renderKey(input([container({ state: 'exited' })]))).not.toBe(renderKey(base));
    expect(renderKey(input([container(), container({ id: 'def', name: 'db' })]))).not.toBe(renderKey(base));
    const ab = input([container({ id: 'a', name: 'a' }), container({ id: 'b', name: 'b' })]);
    const ba = input([container({ id: 'b', name: 'b' }), container({ id: 'a', name: 'a' })]);
    ba.groups = [...ab.groups].reverse();
    expect(renderKey(ba)).not.toBe(renderKey(ab));
  });

  it('changes on expansion, busy, logs, engine state, and usage appearing', () => {
    expect(renderKey(input([container()], { expandedGroups: new Set() }))).not.toBe(renderKey(base));
    expect(renderKey(input([container()], { busy: new Set(['docker:container:abc']) }))).not.toBe(renderKey(base));
    expect(renderKey(input([container()], { logsKey: 'docker:abc' }))).not.toBe(renderKey(base));
    expect(
      renderKey(input([container()], { engines: [{ engine: 'docker', running: false, pending: null, canStart: false, canStop: false }] })),
    ).not.toBe(renderKey(base));
    expect(renderKey(input([container()], { usageText: () => '' }))).not.toBe(renderKey(base));
  });

  it('changes when an engine starts or stops, its controls change, or its own action is busy', () => {
    const docker = { engine: 'docker' as const, running: true, pending: null, canStart: false, canStop: false };
    for (const over of [{ pending: 'stopping' as const }, { canStart: true }, { canStop: true }]) {
      expect(renderKey(input([container()], { engines: [{ ...docker, ...over }] }))).not.toBe(renderKey(base));
    }
    expect(renderKey(input([container()], { busy: new Set([engineBusyKey('docker')]) }))).not.toBe(
      renderKey(base),
    );
  });
});
