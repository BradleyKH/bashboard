import type { CliCommand } from './cli';
import { pinTarget, type FilesRequest } from './filesRouting';
import type { OpenPaneOptions } from './workspace';

/** The app actions `bb` commands run through; `main.ts` implements it over `Workspace`. */
export interface CliTarget {
  /** Pane id (`p<n>`) of the terminal running the given pty, or null when none. */
  terminalForPty(ptyId: number): string | null;
  /** Makes the pane's tab active and the pane the source of the next split. */
  anchorOn(paneId: string): void;
  showFiles(req: FilesRequest, opts: OpenPaneOptions): void;
  showGit(root: string, opts: OpenPaneOptions): void;
  showSearch(root: string, query: string, opts: OpenPaneOptions): void;
  openScratch(text: string, opts: OpenPaneOptions): void;
  /** A terminal in `cwd` of the default profile, typing `command` once its shell is ready. */
  openTerminal(cwd: string, command: string | undefined, opts: OpenPaneOptions): void;
  openInEditor(path: string, line?: number): void;
  /** The repo's Ship pane, or the Overview for null; shows an existing one or appends a tab. */
  openShip(root: string | null): void;
  openPorts(): void;
  openContainers(): void;
}

export function runCliCommand(cmd: CliCommand, target: CliTarget): void {
  const { action } = cmd;
  // These act app-wide, as their keys do, so they need no calling pane.
  switch (action.kind) {
    case 'edit':
      target.openInEditor(action.path, action.line ?? undefined);
      return;
    case 'ship':
      target.openShip(action.root ?? null);
      return;
    case 'ports':
      target.openPorts();
      return;
    case 'containers':
      target.openContainers();
      return;
  }

  const paneId = target.terminalForPty(cmd.ptyId);
  if (paneId === null) {
    console.warn(`bb: no pane for pty ${cmd.ptyId}; dropping ${action.kind}`);
    return;
  }
  target.anchorOn(paneId);
  const opts: OpenPaneOptions = cmd.tab ? { tab: true } : { collapsed: cmd.collapsed };

  switch (action.kind) {
    case 'open': {
      const { folder, select } = pinTarget(action.root, action.path, action.isDir);
      target.showFiles({ root: action.root, folder, select }, opts);
      break;
    }
    case 'git':
      target.showGit(action.root, opts);
      break;
    case 'search':
      target.showSearch(action.root, action.query ?? '', opts);
      break;
    case 'scratch':
      target.openScratch(action.text, opts);
      break;
    case 'term':
      target.openTerminal(action.cwd, action.command ?? undefined, opts);
      break;
  }
}
