import { describe, expect, it } from 'vitest';
import type { Container } from './containers';
import { groupContainers } from './containerGroups';
import { renderKey, type RenderKeyInput } from './containersRenderKey';

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
    engines: [{ engine: 'docker', running: true }],
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
      renderKey(input([container()], { engines: [{ engine: 'docker', running: false }] })),
    ).not.toBe(renderKey(base));
    expect(renderKey(input([container()], { usageText: () => '' }))).not.toBe(renderKey(base));
  });
});
