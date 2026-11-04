import { describe, expect, it } from 'vitest';
import { portMenuItems } from './portMenus';
import type { Listener } from './ports';
import {
  addressLabel,
  dashboardListeners,
  formatUptime,
  isExposed,
  listenerKey,
  listenerTooltip,
  newKeys,
  paneListeners,
  processLabel,
  stopConfirm,
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
    const { rows, others } = dashboardListeners([l({ port: 1 }), l({ port: 135, system: true }), l({ port: 2, own: true })]);
    expect(rows.map((r) => r.port)).toEqual([1]);
    expect(others).toBe(0);
  });

  it('puts pane-started ports first, then sorts by port', () => {
    const { rows } = dashboardListeners([l({ port: 9000 }), l({ port: 3000 }), l({ port: 8080, ptyId: 4 })]);
    expect(rows.map((r) => r.port)).toEqual([8080, 3000, 9000]);
  });

  it('lists dev programs and counts the other apps', () => {
    const { rows, others } = dashboardListeners([
      l({ port: 1, name: 'Spotify.exe' }),
      l({ port: 2, name: 'Splice.exe' }),
      l({ port: 3, name: 'myserver.exe', fromShell: true }),
      l({ port: 4, name: 'python.exe' }),
      l({ port: 5, name: 'weird.exe', ptyId: 1 }),
    ]);
    expect(rows.map((r) => r.port)).toEqual([5, 3, 4]);
    expect(others).toBe(2);
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
});

describe('addresses', () => {
  it('labels loopback, any, and specific binds', () => {
    expect(addressLabel(['127.0.0.1', '::1'])).toBe('localhost');
    expect(addressLabel(['0.0.0.0', '::'])).toBe('all interfaces');
    expect(addressLabel(['192.168.1.5'])).toBe('192.168.1.5');
  });

  it('flags anything beyond loopback as exposed', () => {
    expect(isExposed(['127.0.0.1', '::1'])).toBe(false);
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

  it('leaves out copies it has nothing for', () => {
    expect(labels({ command: '', cwd: null })).not.toContain('Copy command line');
    expect(labels({ command: '', cwd: null })).not.toContain('Copy folder');
  });

  it('never stops Bashboard itself', () => {
    const stop = portMenuItems(l({ own: true }), { onOpenUrl: noop, onCopy: noop, onStop: noop }).slice(-1)[0];
    expect(stop.kind === 'item' && stop.enabled).toBe(false);
  });
});
