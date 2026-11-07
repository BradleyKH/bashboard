import { item, separator, type MenuEntry } from './contextMenuModel';
import type { Listener } from './ports';
import { isLoopbackUrl } from './localBrowserModel';
import { canStop, localUrl, processLabel } from './portsModel';

export interface PortMenuHandlers {
  onOpenUrl: (url: string) => void;
  /** Opens a loopback http URL in a Local Browser pane; omitted where none can open. */
  onOpenLocal?: (url: string) => void;
  onCopy: (text: string, what: string) => void;
  /** Focuses the pane that started it; omitted when none did. */
  onGoToPane?: () => void;
  /** Opens the Ports tab on this row; omitted inside the Ports pane itself. */
  onOpenPorts?: () => void;
  onStop: () => void;
}

/** The menu on a port row, in the dashboard and in the Ports pane alike. */
export function portMenuItems(l: Listener, handlers: PortMenuHandlers): MenuEntry[] {
  const url = localUrl(l);
  const entries: MenuEntry[] = [];
  if (handlers.onOpenLocal && isLoopbackUrl(url)) {
    const openLocal = handlers.onOpenLocal;
    entries.push(
      item('Open in Local Browser', () => openLocal(url)),
      item('Open in system browser', () => handlers.onOpenUrl(url)),
    );
  } else {
    entries.push(item(`Open localhost:${l.port}`, () => handlers.onOpenUrl(url)));
  }
  if (handlers.onGoToPane) entries.push(item('Go to pane', handlers.onGoToPane));
  if (handlers.onOpenPorts) entries.push(item('Show in Ports', handlers.onOpenPorts));
  entries.push(separator(), item('Copy URL', () => handlers.onCopy(url, 'URL')));
  if (l.command) entries.push(item('Copy command line', () => handlers.onCopy(l.command, 'command line')));
  if (l.cwd) entries.push(item('Copy folder', () => handlers.onCopy(l.cwd!, 'folder')));
  entries.push(item('Copy PID', () => handlers.onCopy(String(l.pid), 'PID')));
  entries.push(
    separator(),
    item(`Stop ${processLabel(l.name)}…`, handlers.onStop, { enabled: canStop(l) }),
  );
  return entries;
}
