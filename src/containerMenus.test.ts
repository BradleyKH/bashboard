import { describe, expect, it, vi } from 'vitest';
import type { Container } from './containers';
import type { ContainerGroup, DashboardContainerRow } from './containerGroups';
import type { MenuEntry, MenuItem } from './contextMenuModel';
import { containerGroupMenuItems, containerRowMenuItems, containerSectionMenuItems } from './containerMenus';

function ctr(over: Partial<Container> = {}): Container {
  return {
    engine: 'docker',
    id: 'abc',
    name: 'web',
    image: 'nginx',
    state: 'running',
    statusText: 'Up',
    ports: [],
    project: null,
    service: null,
    ...over,
  };
}

function items(entries: MenuEntry[]): MenuItem[] {
  return entries.filter((e): e is MenuItem => e.kind === 'item');
}
function find(entries: MenuEntry[], label: string): MenuItem {
  const m = items(entries).find((i) => i.label === label);
  if (!m) throw new Error(`no ${label}`);
  return m;
}
const enabled = (m: MenuItem): boolean => m.enabled !== false;

function group(state: ContainerGroup['state']): ContainerGroup {
  return { key: 'k', name: 'g', engine: 'docker', containers: [ctr()], state };
}

const rowHandlers = () => ({
  onAction: vi.fn(),
  onLogs: vi.fn(),
  onShell: vi.fn(),
  onOpenUrl: vi.fn(),
  onCopyName: vi.fn(),
});

describe('containerGroupMenuItems', () => {
  it('enables by state', () => {
    const h = { onAction: vi.fn() };
    const running = containerGroupMenuItems(group('running'), false, h);
    expect(items(running).map((i) => i.label)).toEqual(['Start', 'Stop', 'Restart']);
    expect(enabled(find(running, 'Start'))).toBe(false);
    expect(enabled(find(running, 'Stop'))).toBe(true);
    const stopped = containerGroupMenuItems(group('stopped'), false, h);
    expect(enabled(find(stopped, 'Start'))).toBe(true);
    expect(enabled(find(stopped, 'Stop'))).toBe(false);
    expect(enabled(find(containerGroupMenuItems(group('partial'), false, h), 'Stop'))).toBe(true);
  });

  it('disables everything while busy and passes the action', () => {
    const h = { onAction: vi.fn() };
    const busy = containerGroupMenuItems(group('partial'), true, h);
    expect(items(busy).every((i) => !enabled(i))).toBe(true);
    find(containerGroupMenuItems(group('partial'), false, h), 'Restart').run();
    expect(h.onAction).toHaveBeenCalledWith('restart');
  });
});

describe('containerRowMenuItems', () => {
  it('enables by state and busy', () => {
    const h = rowHandlers();
    const running = containerRowMenuItems(ctr(), false, h);
    expect(enabled(find(running, 'Start'))).toBe(false);
    expect(enabled(find(running, 'Stop'))).toBe(true);
    expect(enabled(find(running, 'Shell'))).toBe(true);
    const stopped = containerRowMenuItems(ctr({ state: 'exited' }), false, h);
    expect(enabled(find(stopped, 'Start'))).toBe(true);
    expect(enabled(find(stopped, 'Stop'))).toBe(false);
    expect(enabled(find(stopped, 'Shell'))).toBe(false);
    expect(enabled(find(stopped, 'Logs'))).toBe(true);
    const busy = containerRowMenuItems(ctr(), true, h);
    expect(enabled(find(busy, 'Restart'))).toBe(false);
    expect(enabled(find(busy, 'Logs'))).toBe(true);
  });

  it('offers one Open item per published TCP port, skipping UDP and duplicates', () => {
    const h = rowHandlers();
    const c = ctr({
      ports: [
        { host: 8080, container: 80, protocol: 'tcp' },
        { host: 8080, container: 81, protocol: 'tcp' },
        { host: 5353, container: 53, protocol: 'udp' },
        { host: 9000, container: 90, protocol: 'tcp' },
      ],
    });
    const entries = containerRowMenuItems(c, false, h);
    expect(items(entries).map((i) => i.label)).toEqual([
      'Start',
      'Stop',
      'Restart',
      'Logs',
      'Shell',
      'Open localhost:8080',
      'Open localhost:9000',
      'Copy name',
    ]);
    find(entries, 'Open localhost:9000').run();
    expect(h.onOpenUrl).toHaveBeenCalledWith('http://localhost:9000');
  });

  it('offers Local Browser and system browser per port when onOpenLocal is given', () => {
    const h = { ...rowHandlers(), onOpenLocal: vi.fn() };
    const c = ctr({ ports: [{ host: 8080, container: 80, protocol: 'tcp' }] });
    const entries = containerRowMenuItems(c, false, h);
    expect(items(entries).map((i) => i.label).slice(5, 7)).toEqual([
      'Open localhost:8080 in Local Browser',
      'Open localhost:8080 in system browser',
    ]);
    find(entries, 'Open localhost:8080 in Local Browser').run();
    expect(h.onOpenLocal).toHaveBeenCalledWith('http://localhost:8080');
    find(entries, 'Open localhost:8080 in system browser').run();
    expect(h.onOpenUrl).toHaveBeenCalledWith('http://localhost:8080');
  });

  it('calls handlers', () => {
    const h = rowHandlers();
    const entries = containerRowMenuItems(ctr({ name: 'web-1' }), false, h);
    find(entries, 'Stop').run();
    find(entries, 'Logs').run();
    find(entries, 'Shell').run();
    find(entries, 'Copy name').run();
    expect(h.onAction).toHaveBeenCalledWith('stop');
    expect(h.onLogs).toHaveBeenCalled();
    expect(h.onShell).toHaveBeenCalled();
    expect(h.onCopyName).toHaveBeenCalledWith('web-1');
  });
});

describe('containerSectionMenuItems', () => {
  const h = () => ({ onStart: vi.fn(), onStop: vi.fn(), onOpenContainers: vi.fn() });
  const row = (over: Record<string, unknown>): DashboardContainerRow => ({
    kind: 'group',
    name: 'g',
    state: 'partial',
    running: 1,
    total: 2,
    anyStopped: true,
    anyRunning: true,
    groupKeys: ['k'],
    ...over,
  });
  const labels = (r: DashboardContainerRow) => items(containerSectionMenuItems(r, h())).map((i) => i.label);

  it('shows Start and Stop by row state', () => {
    expect(labels(row({}))).toEqual(['Start', 'Stop', 'Open Containers']);
    expect(labels(row({ anyRunning: false }))).toEqual(['Start', 'Open Containers']);
    expect(labels(row({ anyStopped: false }))).toEqual(['Stop', 'Open Containers']);
  });

  it('has no menu for an unavailable engine and calls handlers', () => {
    const handlers = h();
    expect(containerSectionMenuItems({ kind: 'unavailable', engine: 'docker', canStart: true, pending: null }, handlers)).toEqual([]);
    const entries = containerSectionMenuItems(row({}), handlers);
    find(entries, 'Start').run();
    find(entries, 'Open Containers').run();
    expect(handlers.onStart).toHaveBeenCalled();
    expect(handlers.onOpenContainers).toHaveBeenCalled();
  });
});
