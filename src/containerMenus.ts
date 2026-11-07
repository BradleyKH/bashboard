import type { Container, ContainerAction } from './containers';
import type { ContainerGroup, DashboardContainerRow } from './containerGroups';
import { isLoopbackUrl } from './localBrowserModel';
import { item, separator, type MenuEntry } from './contextMenuModel';

export interface ContainerGroupMenuHandlers {
  onAction: (action: ContainerAction) => void;
}

export interface ContainerRowMenuHandlers extends ContainerGroupMenuHandlers {
  onLogs: () => void;
  onShell: () => void;
  onOpenUrl: (url: string) => void;
  /** Opens a loopback URL in a Local Browser pane; omitted where none can open. */
  onOpenLocal?: (url: string) => void;
  onCopyName: (name: string) => void;
}

export interface ContainerSectionMenuHandlers {
  onStart: () => void;
  onStop: () => void;
  onOpenContainers: () => void;
}

/** Start, Stop, and Restart for a whole group, enabled as the header buttons are. */
export function containerGroupMenuItems(
  group: ContainerGroup,
  busy: boolean,
  handlers: ContainerGroupMenuHandlers,
): MenuEntry[] {
  return [
    item('Start', () => handlers.onAction('start'), { enabled: !(busy || group.state === 'running') }),
    item('Stop', () => handlers.onAction('stop'), { enabled: !(busy || group.state === 'stopped') }),
    item('Restart', () => handlers.onAction('restart'), { enabled: !busy }),
  ];
}

/** Actions for one container, then one Open item per published TCP port, then Copy name. */
export function containerRowMenuItems(
  container: Container,
  busy: boolean,
  handlers: ContainerRowMenuHandlers,
): MenuEntry[] {
  const running = container.state === 'running';
  const entries: MenuEntry[] = [
    item('Start', () => handlers.onAction('start'), { enabled: !(busy || running) }),
    item('Stop', () => handlers.onAction('stop'), { enabled: !(busy || !running) }),
    item('Restart', () => handlers.onAction('restart'), { enabled: !busy }),
    item('Logs', () => handlers.onLogs()),
    item('Shell', () => handlers.onShell(), { enabled: running }),
  ];
  const hostPorts: number[] = [];
  for (const p of container.ports) {
    // Only TCP ports can serve http, the same rule that links a port in the row.
    if (p.protocol === 'tcp' && !hostPorts.includes(p.host)) hostPorts.push(p.host);
  }
  if (hostPorts.length > 0) {
    entries.push(separator());
    for (const port of hostPorts) {
      const url = `http://localhost:${port}`;
      const openLocal = handlers.onOpenLocal;
      if (openLocal && isLoopbackUrl(url)) {
        entries.push(
          item(`Open localhost:${port} in Local Browser`, () => openLocal(url)),
          item(`Open localhost:${port} in system browser`, () => handlers.onOpenUrl(url)),
        );
      } else {
        entries.push(item(`Open localhost:${port}`, () => handlers.onOpenUrl(url)));
      }
    }
  }
  entries.push(separator(), item('Copy name', () => handlers.onCopyName(container.name)));
  return entries;
}

/** The dashboard Containers row: Start and Stop as the hover buttons show them, then Open Containers. */
export function containerSectionMenuItems(
  row: DashboardContainerRow,
  handlers: ContainerSectionMenuHandlers,
): MenuEntry[] {
  if (row.kind !== 'group') return [];
  const entries: MenuEntry[] = [];
  if (row.anyStopped) entries.push(item('Start', () => handlers.onStart()));
  if (row.anyRunning) entries.push(item('Stop', () => handlers.onStop()));
  if (entries.length > 0) entries.push(separator());
  entries.push(item('Open Containers', () => handlers.onOpenContainers()));
  return entries;
}
