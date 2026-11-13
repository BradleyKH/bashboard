import { describe, expect, it, vi } from 'vitest';
import { portMenuItems } from './portMenus';
import type { Listener } from './ports';
import {
  addressLabel,
  dashboardListeners,
  exposureLabel,
  formatUptime,
  isExposed,
  listenerKey,
  listenerTooltip,
  newKeys,
  nextPortSort,
  paneListeners,
  processLabel,
  stopConfirm,
  type PortSort,
} from './portsModel';

function l(over: Partial<Listener> = {}): Listener {
  return {
    port: 5173,
    addresses: ['127.0.0.1'],
    pid: 100,
    startedAt: 1_000,
    name: 'node.exe',
    command: 'node vite.js',
    cwd: 'C:\\repo',
    ptyId: null,
    fromShell: false,
    system: false,
    own: false,
    ...over,
  };
}

describe('dashboardListeners', () => {
  it('drops services and Bashboard itself', () => {
    const { rows, others } = dashboardListeners([l({ port: 1 }), l({ port: 135, system: true }), l({ port: 2, own: true })], 10);
    expect(rows.map((r) => r.port)).toEqual([1]);
    expect(others).toBe(0);
  });

  it('puts pane-started ports first, then sorts by port', () => {
    const { rows } = dashboardListeners([l({ port: 9000 }), l({ port: 3000 }), l({ port: 8080, ptyId: 4 })], 10);
    expect(rows.map((r) => r.port)).toEqual([8080, 3000, 9000]);
  });

  it('lists local model servers as dev runtimes', () => {
    const { rows, others } = dashboardListeners([
      l({ port: 11434, name: 'ollama.exe' }),
      l({ port: 11435, name: 'ollama app.exe' }),
      l({ port: 1234, name: 'LM Studio.exe' }),
      l({ port: 1235, name: 'lms.exe' }),
      l({ port: 8080, name: 'llama-server.exe' }),
    ], 10);
    expect(rows.map((r) => r.port)).toEqual([1234, 1235, 8080, 11434, 11435]);
    expect(others).toBe(0);
  });

  it('lists dev programs and counts the other apps', () => {
    const { rows, others } = dashboardListeners([
      l({ port: 1, name: 'Spotify.exe' }),
      l({ port: 2, name: 'Splice.exe' }),
      l({ port: 3, name: 'myserver.exe', fromShell: true }),
      l({ port: 4, name: 'python.exe' }),
      l({ port: 5, name: 'weird.exe', ptyId: 1 }),
    ], 10);
    expect(rows.map((r) => r.port)).toEqual([5, 3, 4]);
    expect(others).toBe(2);
  });

  it('lists at most maxRows and counts the rest, keeping pane-started ports', () => {
    const many = Array.from({ length: 12 }, (_, i) => l({ port: 3000 + i, name: 'node.exe' }));
    const { rows, more, others } = dashboardListeners([...many, l({ port: 9999, name: 'node.exe', ptyId: 2 })], 10);
    expect(rows).toHaveLength(10);
    expect(rows[0].port).toBe(9999);
    expect(more).toBe(3);
    expect(others).toBe(0);
    expect(dashboardListeners(many.slice(0, 10), 10).more).toBe(0);
    expect(dashboardListeners(many, 3)).toMatchObject({ more: 9 });
    expect(dashboardListeners(many, 3).rows.map((r) => r.port)).toEqual([3000, 3001, 3002]);
  });
});

describe('paneListeners', () => {
  const list = [l({ port: 3000 }), l({ port: 135, system: true, name: 'svchost.exe', command: '' }), l({ port: 1420, ptyId: 2 })];
  const owner = (x: Listener) => (x.ptyId === 2 ? 'bashboard' : null);

  it('hides services unless asked', () => {
    expect(paneListeners(list, { showSystem: false, paneOnly: false, text: '' }, owner).map((r) => r.port)).toEqual([1420, 3000]);
    expect(paneListeners(list, { showSystem: true, paneOnly: false, text: '' }, owner).map((r) => r.port)).toEqual([135, 1420, 3000]);
  });

  it('filters on port, program, and owning pane', () => {
    expect(paneListeners(list, { showSystem: true, paneOnly: false, text: '135' }, owner).map((r) => r.port)).toEqual([135]);
    expect(paneListeners(list, { showSystem: true, paneOnly: false, text: 'SVCHOST' }, owner).map((r) => r.port)).toEqual([135]);
    expect(paneListeners(list, { showSystem: true, paneOnly: false, text: 'bashb' }, owner).map((r) => r.port)).toEqual([1420]);
  });

  it('keeps only pane-started rows when asked', () => {
    expect(paneListeners(list, { showSystem: true, paneOnly: true, text: '' }, owner).map((r) => r.port)).toEqual([1420]);
  });

  it('sorts on the chosen column, either way', () => {
    const all = { showSystem: true, paneOnly: false, text: '' };
    const ports = (sort: PortSort) => paneListeners(list, all, owner, sort).map((r) => r.port);
    expect(ports({ column: 'port', desc: true })).toEqual([3000, 1420, 135]);
    expect(ports({ column: 'program', desc: false })).toEqual([1420, 3000, 135]);
    expect(ports({ column: 'program', desc: true })).toEqual([135, 1420, 3000]);
  });

  it('keeps rows with no pane last when sorting by pane', () => {
    const all = { showSystem: true, paneOnly: false, text: '' };
    expect(paneListeners(list, all, owner, { column: 'pane', desc: false }).map((r) => r.port)).toEqual([1420, 135, 3000]);
    expect(paneListeners(list, all, owner, { column: 'pane', desc: true }).map((r) => r.port)).toEqual([1420, 135, 3000]);
  });

  it('sorts uptime shortest first', () => {
    const rows = [l({ port: 1, startedAt: 100 }), l({ port: 2, startedAt: 300 }), l({ port: 3, startedAt: 200 })];
    const all = { showSystem: true, paneOnly: false, text: '' };
    expect(paneListeners(rows, all, () => null, { column: 'up', desc: false }).map((r) => r.port)).toEqual([2, 3, 1]);
  });
});

describe('nextPortSort', () => {
  it('flips the same column and starts a new one ascending', () => {
    expect(nextPortSort({ column: 'port', desc: false }, 'port')).toEqual({ column: 'port', desc: true });
    expect(nextPortSort({ column: 'port', desc: true }, 'port')).toEqual({ column: 'port', desc: false });
    expect(nextPortSort({ column: 'port', desc: true }, 'pid')).toEqual({ column: 'pid', desc: false });
  });
});

describe('addresses', () => {
  it('labels loopback, any, and specific binds', () => {
    expect(addressLabel(['127.0.0.1', '::1'])).toBe('localhost');
    expect(addressLabel(['0.0.0.0', '::'])).toBe('all interfaces');
    expect(addressLabel(['192.168.1.5'])).toBe('192.168.1.5');
  });

  it('flags anything beyond loopback as exposed', () => {
    expect(isExposed(['127.0.0.1', '::1'])).toBe(false);
    expect(exposureLabel(['127.0.0.1'])).toBe('Local only');
    expect(exposureLabel(['0.0.0.0'])).toBe('Reachable from other machines');
    expect(isExposed(['0.0.0.0'])).toBe(true);
  });
});

describe('formatting', () => {
  it('strips .exe from process names', () => {
    expect(processLabel('node.exe')).toBe('node');
    expect(processLabel('Python.EXE')).toBe('Python');
    expect(processLabel('')).toBe('unknown');
  });

  it('formats uptime in the largest two units', () => {
    expect(formatUptime(1_045, 1_000)).toBe('45s');
    expect(formatUptime(1_000 + 12 * 60, 1_000)).toBe('12m');
    expect(formatUptime(1_000 + 3 * 3600 + 5 * 60, 1_000)).toBe('3h 5m');
    expect(formatUptime(1_000 + 2 * 3600, 1_000)).toBe('2h');
    expect(formatUptime(1_000 + 2 * 86400 + 4 * 3600, 1_000)).toBe('2d 4h');
    expect(formatUptime(5, 0)).toBe('-');
  });

  it('tooltips name the owner or say there is none', () => {
    expect(listenerTooltip(l(), 'api', 1_060)).toContain('Started from api');
    expect(listenerTooltip(l(), null, 1_060)).toContain('Not started from a pane');
  });
});

describe('newKeys', () => {
  it('flashes nothing on the first snapshot, then only new listeners', () => {
    const a = l({ port: 1 });
    const b = l({ port: 2 });
    expect(newKeys(null, [a, b]).size).toBe(0);
    expect([...newKeys(new Set([listenerKey(a)]), [a, b])]).toEqual([listenerKey(b)]);
  });

  it('treats a reused pid as a new listener', () => {
    expect(listenerKey(l({ startedAt: 1 }))).not.toBe(listenerKey(l({ startedAt: 2 })));
  });
});

describe('stopConfirm', () => {
  it('names the process, port, and where it came from', () => {
    const o = stopConfirm(l(), 'api');
    expect(o.title).toBe('Stop node?');
    expect(o.body.join(' ')).toContain('port 5173');
    expect(o.body.join(' ')).toContain('started from api');
  });
});

describe('portMenuItems', () => {
  const noop = () => {};
  const labels = (over: Partial<Listener>, extra: { goTo?: boolean; open?: boolean } = {}) =>
    portMenuItems(l(over), {
      onOpenUrl: noop,
      onCopy: noop,
      onStop: noop,
      onGoToPane: extra.goTo ? noop : undefined,
      onOpenPorts: extra.open ? noop : undefined,
    }).map((e) => (e.kind === 'item' ? e.label : '-'));

  it('offers opening, copying, and stopping', () => {
    expect(labels({}, { goTo: true, open: true })).toEqual([
      'Open localhost:5173',
      'Go to pane',
      'Show in Ports',
      '-',
      'Copy URL',
      'Copy command line',
      'Copy folder',
      'Copy PID',
      '-',
      'Stop node…',
    ]);
  });

  it('offers Local Browser first, then the system browser, when onOpenLocal is given', () => {
    const onOpenLocal = vi.fn();
    const onOpenUrl = vi.fn();
    const entries = portMenuItems(l({}), { onOpenUrl, onOpenLocal, onCopy: noop, onStop: noop });
    const [first, second] = entries;
    expect(first.kind === 'item' && first.label).toBe('Open in Local Browser');
    expect(second.kind === 'item' && second.label).toBe('Open in system browser');
    if (first.kind === 'item') first.run();
    expect(onOpenLocal).toHaveBeenCalledWith('http://localhost:5173');
    if (second.kind === 'item') second.run();
    expect(onOpenUrl).toHaveBeenCalledWith('http://localhost:5173');
  });

  it('leaves out copies it has nothing for', () => {
    expect(labels({ command: '', cwd: null })).not.toContain('Copy command line');
    expect(labels({ command: '', cwd: null })).not.toContain('Copy folder');
  });

  it('never stops Bashboard itself', () => {
    const stop = portMenuItems(l({ own: true }), { onOpenUrl: noop, onCopy: noop, onStop: noop }).slice(-1)[0];
    expect(stop.kind === 'item' && stop.enabled).toBe(false);
  });
});
