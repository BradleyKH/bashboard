import { ContainersPane } from './containersPane';
import type { OtherCardInput } from './dashboardModel';
import { FilesPane } from './filesPane';
import type { ProviderKind } from './forgeApi';
import { GitPane } from './gitPane';
import { LocalBrowserPane } from './localBrowserPane';
import { TerminalPane } from './pane';
import type { PaneView } from './paneView';
import { PortsPane } from './portsPane';
import { ScratchPane } from './scratchPane';
import { SearchPane } from './searchPane';
import { ShipPane } from './shipPane';

// What the dashboard, tab strip, and Accounts tab read off panes of each kind other than a
// terminal, whose title and card come from its session (docs/design/workspace.md section 4.11).

/** The fields every pane's card shares, which the workspace knows and the pane does not. */
export type CardCommon = Pick<OtherCardInput, 'paneId' | 'tabId' | 'focused' | 'openedAt' | 'collapsed'>;

/** The card input of a pane of any kind but terminal, or null for a terminal. */
export function viewCardInput(pane: PaneView, common: CardCommon): OtherCardInput | null {
  if (pane instanceof ScratchPane) {
    return { ...common, kind: 'scratch', title: pane.title(), folder: null, confirmClose: !pane.isEmpty() };
  }
  if (pane instanceof FilesPane) {
    return { ...common, kind: 'files', title: pane.title(), folder: pane.folder, root: pane.root(), confirmClose: false };
  }
  if (pane instanceof GitPane) {
    return { ...common, kind: 'git', title: pane.title(), folder: pane.root(), confirmClose: false };
  }
  if (pane instanceof ShipPane) {
    return { ...common, kind: 'ship', title: pane.title(), folder: pane.folder, confirmClose: false };
  }
  if (pane instanceof SearchPane) {
    return { ...common, kind: 'search', title: pane.title(), folder: pane.root(), confirmClose: false };
  }
  if (pane instanceof ContainersPane) {
    return { ...common, kind: 'containers', title: pane.title(), folder: null, confirmClose: false };
  }
  if (pane instanceof PortsPane) {
    return { ...common, kind: 'ports', title: pane.title(), folder: null, confirmClose: false };
  }
  if (pane instanceof LocalBrowserPane) {
    return { ...common, kind: 'browser', title: pane.title(), folder: null, confirmClose: false };
  }
  return null;
}

/** The title a pane of any kind but terminal gives itself, or null for a terminal or no pane. */
export function viewTitle(pane: PaneView | undefined): string | null {
  if (
    pane instanceof ScratchPane ||
    pane instanceof FilesPane ||
    pane instanceof GitPane ||
    pane instanceof ShipPane ||
    pane instanceof SearchPane ||
    pane instanceof ContainersPane ||
    pane instanceof PortsPane ||
    pane instanceof LocalBrowserPane
  ) {
    return pane.title();
  }
  return null;
}

/**
 * What the Accounts tab treats as known repos, across every tab: the host of each resolved Ship
 * pane's repo, and the working folder of each terminal (the core reads those folders' remotes).
 */
export function knownForgeSources(panes: Iterable<PaneView>): {
  hosts: { provider: ProviderKind; host: string }[];
  dirs: string[];
  repos: string[];
} {
  const hosts: { provider: ProviderKind; host: string }[] = [];
  const dirs: string[] = [];
  const repos: string[] = [];
  for (const pane of panes) {
    if (pane instanceof ShipPane) {
      const known = pane.knownHost();
      if (known) hosts.push(known);
      const id = pane.knownRepoId();
      if (id) repos.push(id);
    } else if (pane instanceof TerminalPane && pane.cwd) {
      dirs.push(pane.cwd);
    }
  }
  return { hosts, dirs, repos };
}
