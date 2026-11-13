import type { DialogTab } from './appDialogModel';
import type { PtyRef } from './savedWorkspace';
import type { AttentionCause } from './attention';
import type { DevtoolsState } from './browserPaneModel';
import type { ConfirmOptions } from './confirmDialog';
import type { ContainersStore } from './containersStore';
import type { PaneCardInput } from './dashboardModel';
import type { DockTarget } from './docking';
import type { FilesSort } from './filesModel';
import type { GitTab } from './gitBranchModel';
import type { DockZone, Rect } from './layout';
import type { OpenInHandler } from './openMenu';
import type { PaneKind } from './paneKinds';
import type { PortsStore } from './portsStore';
import type { SearchOptions } from './searchOptions';
import type { ShipTab } from './shipModel';
import type { ShellStatus, TerminalStatus } from './terminalStatus';
import type { Worktree } from './worktreeApi';

// The shapes Workspace exposes to its callers and shares with its helper modules; workspace.ts
// re-exports the public ones, so callers import them from there.

export type Edge = Exclude<DockZone, 'center'>;

export interface TerminalInfo {
  kind: 'terminal';
  paneId: string;
  tabId: string;
  /** Null until the spawn resolves and after the shell exits. */
  ptyId: number | null;
  cwd: string | null;
  /** Resolved shell profile id; the configured default until the spawn resolves. */
  profile: string;
  focused: boolean;
  /** Epoch ms. */
  openedAt: number;
  collapsed: boolean;
  shell: ShellStatus;
  attention: boolean;
  /** An unseen `Stop` or long command (docs/design/terminal.md section 4.8). */
  mark: { status: 'done' | 'failed'; at: number } | null;
}

/** One tab as the tab strip and dashboard show it (docs/design/workspace.md section 4.10). */
export interface TabInfo {
  id: string;
  /** The fixed name, else the focused pane's title. */
  title: string;
  /** Null while the title follows the focused pane. */
  name: string | null;
  active: boolean;
  paneCount: number;
  /** The most urgent of its terminals' statuses. */
  status: TerminalStatus;
  /** True while any of its terminals has attention. */
  attention: boolean;
  /** Its `waiting` terminals in pane order, for the tab's tooltip. */
  waiting: { title: string; reason: string }[];
}

export interface WorkspaceHooks {
  onToggleDashboard?: () => void;
  onFocusDashboard?: () => void;
  onOpenFavoritePicker?: () => void;
  onOpenLayoutPicker?: () => void;
  /** Design 4.6 Launch: the launch menu at the focused pane. */
  onOpenLaunchMenu?: () => void;
  onOpenPalette?: () => void;
  onOpenProfilePicker?: () => void;
  /** Opens the Help, Settings, Accounts, Shortcuts, CLI, and About dialog on the given tab. */
  onOpenDialog?: (tab: DialogTab) => void;
  /** Opens the dialog's Accounts tab, on `host`'s card when given, optionally with its token form open. */
  onOpenAccounts?: (host: string | null, opts?: { openTokenForm?: boolean; org?: string }) => void;
  onToggleBackdrop?: () => void;
  onToggleFullscreen?: () => void;
  /** Called whenever a pane's attention is newly raised (docs/design/sessions.md section 4.7). */
  onAttention?: (paneId: string, cause: AttentionCause) => void;
  /** Pointer position during a pane drag, `null` when it ends. */
  onDragHover?: (pos: { x: number; y: number } | null) => void;
  /**
   * The dashboard tab group under the point during a pane drag (docs/design/dashboard.md
   * section 4.6).
   */
  tabDropAt?: (x: number, y: number) => { tabId: string; rect: DOMRect } | null;
  /**
   * The tab strip's area past its last tab when the point is in it, where a dropped pane moves
   * into a new tab (docs/design/workspace.md section 4.10); null while the strip is hidden.
   */
  newTabDropAt?: (x: number, y: number) => DOMRect | null;
  /** Asks before closing a tab whose `busy` panes would lose work; true closes it. */
  onConfirmCloseTab?: (tabId: string, busy: PaneCardInput[]) => Promise<boolean>;
  /** Asks before Ctrl+W closes a scratch pad that has text; true closes it. */
  onConfirmClosePane?: (paneId: string) => Promise<boolean>;
  /** Asks before the kind menu replaces a busy terminal or a pad with text; true replaces it. */
  onConfirmReplace?: (paneId: string, kind: PaneKind) => Promise<boolean>;
  /** Shows a confirm dialog for a pane's own question (a Git pane's Undo last commit); true goes ahead. */
  onConfirm?: (options: ConfirmOptions) => Promise<boolean>;
  /**
   * A Files pane pinned a file or folder of the repo at `root` (docs/design/files.md section 4.12).
   */
  /** A terminal's title strip "+" or New pin: a command pin in `folder`, prefilled with the selection. */
  onNewCommandPin?: (folder: string | null, selection: string) => void;
  onPin?: (root: string, absolute: string, isDir: boolean) => void;
  onUnpin?: (root: string, absolute: string) => void;
  /** Absolute paths of the existing pinned folders of the repo at `root`. */
  getPinnedFolders?: (root: string) => string[];
  /** The Repo section's repo root, which a pane with no folder passes on when replaced (4.11). */
  getRepoFolder?: () => string | null;
  /**
   * The container snapshot every Containers pane shares (docs/design/containers.md section 4.16).
   */
  containers?: ContainersStore;
  /**
   * The listener list every Ports pane and the dashboard share (docs/design/containers.md
   * section 4.19).
   */
  ports?: PortsStore;
  /** A Git pane's worktree row opened its folder as another pane kind or in the editor. */
  onOpenIn?: OpenInHandler;
  /** Asks, then removes the worktree; resolves to a message to show inline, or null when removed or cancelled. */
  onDeleteWorktree?: (root: string, w: Worktree) => Promise<string | null>;
  /** A Git pane's "Compare with" choice; null goes back to automatic. */
  onSetPrimaryBranch?: (root: string, branch: string | null) => void;
}

/**
 * Where a launched pane would land (docs/design/dashboard.md section 4.6): a split of the focused
 * pane (`pane` is it now, `kept` and `added` its two halves after), an existing pane brought
 * forward, the whole pane area of an empty tab, or collapsed for want of room.
 */
export type LaunchTarget =
  | { kind: 'split'; pane: Rect; kept: Rect; added: Rect }
  | { kind: 'reuse'; pane: Rect }
  | { kind: 'fill'; area: Rect }
  | { kind: 'collapsed'; pane: Rect };

export interface OpenPaneOptions {
  collapsed?: boolean;
  dock?: DockTarget;
  /** Opens the pane as the only pane of a new tab; `collapsed` and `dock` then do nothing. */
  tab?: boolean;
}

export interface OpenTerminalOptions extends OpenPaneOptions {
  /** Shell profile id; omitted uses `shell.defaultProfile`. */
  profile?: string;
}

/** What to build for a new pane (docs/design/workspace.md section 4.11). */
export type PaneSpec =
  | {
      kind: 'terminal';
      cwd?: string;
      profile?: string;
      /** Runs in place of the profile's shell. */
      command?: string[];
      /** Typed into the shell, with Enter, once it is ready for input. */
      initialInput?: string;
      /** Pasted into the shell, without Enter, once it is ready for input. */
      initialPaste?: string;
      /** Marks a container shell (design 4.16), which is titled by it and never saved. */
      container?: { name: string };
      /** The saved terminal's scrollback id, kept so the next save reuses its file. */
      scrollbackId?: string;
      /** Saved scrollback to write before the shell starts (design 4.9). */
      replay?: Promise<string>;
      /** A running pty to reattach to; when it is gone, the pane starts a shell as usual. */
      attach?: PtyRef;
    }
  | { kind: 'scratch'; scratchId?: string; text?: string | Promise<string> }
  | {
      kind: 'files';
      folder: string;
      selected?: string | null;
      root?: string;
      expanded?: boolean;
      sort?: FilesSort;
    }
  | { kind: 'git'; root: string; tab?: GitTab }
  /** No `root` opens on the Overview. */
  | {
      kind: 'ship';
      root?: string;
      tab?: ShipTab;
      thisBranch?: boolean;
      thisBranchPulls?: boolean;
      allPulls?: boolean;
    }
  | { kind: 'search'; root: string; query?: string; options?: SearchOptions }
  | { kind: 'containers' }
  | { kind: 'ports' }
  /** No `url` opens the start page. */
  | { kind: 'browser'; url?: string | null; devtools?: Partial<DevtoolsState>; device?: string };
