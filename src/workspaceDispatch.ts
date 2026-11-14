import { openInEditor } from './editors';
import type { FindBar } from './findBar';
import type { FilesRequest } from './filesRouting';
import { DEFAULT_FONT_SIZE, stepFontSize } from './fontSize';
import type { Action } from './keymap';
import type { Direction } from './layout';
import type { TerminalPane } from './pane';
import { repoRoot } from './repoFiles';
import { initialQuery } from './searchModel';
import { nextTab, tabAt } from './tabs';
import type { TabStore } from './tabStore';
import { showToast } from './toast';
import type { SearchOptions } from './searchOptions';
import type { Edge, OpenPaneOptions, PaneSpec, WorkspaceHooks } from './workspaceTypes';

/** The workspace operations that bound actions run. */
export interface DispatchContext {
  readonly store: TabStore;
  readonly hooks: WorkspaceHooks;
  readonly hosts: ReadonlyMap<string, HTMLElement>;
  readonly findBar: FindBar;
  terminal(id: string): TerminalPane | undefined;
  /** The focused pane's folder, else that of the active tab's most recent terminal. */
  folderForNew(): string | undefined;
  fontSize(): number;
  setFontSize(size: number): void;
  cycleScrim(): void;
  toggleBackgroundTabs(): void;
  split(side: Edge | 'auto'): void;
  requestClosePane(id: string): Promise<void>;
  collapsePane(id: string): void;
  toggleZoom(): void;
  moveFocus(direction: Direction): void;
  resizePane(direction: Direction): void;
  newTab(): void;
  openPane(spec: PaneSpec, opts?: OpenPaneOptions): void;
  showFiles(req: FilesRequest, opts?: OpenPaneOptions): void;
  showGit(root: string, opts?: OpenPaneOptions): void;
  showSearch(root: string, query?: string, opts?: OpenPaneOptions, options?: SearchOptions): void;
  switchTab(id: string): void;
  nextAttention(): void;
  requestCloseTab(id: string): Promise<void>;
}

/**
 * Runs a keybinding action against the workspace (docs/design/keys.md section 4.5). Every bound
 * workspace action is swallowed, even with no effect, so it never leaks to bash; false means the
 * action is not a workspace action.
 */
export function dispatchAction(ctx: DispatchContext, action: Action): boolean {
  switch (action.type) {
    case 'splitRight':
      ctx.split('right');
      return true;
    case 'splitDown':
      ctx.split('bottom');
      return true;
    case 'splitLeft':
      ctx.split('left');
      return true;
    case 'splitUp':
      ctx.split('top');
      return true;
    case 'splitAuto':
      ctx.split('auto');
      return true;
    case 'closePane': {
      // Disposing the pane from inside its own key handler leaves xterm mid-event.
      const id = ctx.store.focusedId;
      queueMicrotask(() => void ctx.requestClosePane(id));
      return true;
    }
    case 'collapsePane': {
      // Detaching the host from inside its own key handler leaves xterm mid-event.
      const id = ctx.store.focusedId;
      queueMicrotask(() => ctx.collapsePane(id));
      return true;
    }
    case 'togglePaneZoom':
      // Rendering detaches hosts, which leaves xterm mid-event inside its own key handler.
      queueMicrotask(() => ctx.toggleZoom());
      return true;
    case 'moveFocus':
      ctx.moveFocus(action.direction);
      return true;
    case 'resizePane':
      ctx.resizePane(action.direction);
      return true;
    case 'cycleScrim':
      ctx.cycleScrim();
      return true;
    case 'toggleBackgroundTabs':
      ctx.toggleBackgroundTabs();
      return true;
    case 'increaseFontSize':
      ctx.setFontSize(stepFontSize(ctx.fontSize(), 1));
      return true;
    case 'decreaseFontSize':
      ctx.setFontSize(stepFontSize(ctx.fontSize(), -1));
      return true;
    case 'resetFontSize':
      ctx.setFontSize(DEFAULT_FONT_SIZE);
      return true;
    case 'toggleDashboard':
      ctx.hooks.onToggleDashboard?.();
      return true;
    case 'focusDashboard':
      ctx.hooks.onFocusDashboard?.();
      return true;
    case 'openFavorite':
      ctx.hooks.onOpenFavoritePicker?.();
      return true;
    case 'openLayout':
      ctx.hooks.onOpenLayoutPicker?.();
      return true;
    case 'openLaunch':
      ctx.hooks.onOpenLaunchMenu?.();
      return true;
    case 'openPalette':
      ctx.hooks.onOpenPalette?.();
      return true;
    case 'splitWithProfile':
      ctx.hooks.onOpenProfilePicker?.();
      return true;
    case 'showHelp':
      ctx.hooks.onOpenDialog?.('help');
      return true;
    case 'openSettings':
      ctx.hooks.onOpenDialog?.('settings');
      return true;
    case 'showAccounts':
      ctx.hooks.onOpenDialog?.('accounts');
      return true;
    case 'showShortcuts':
      ctx.hooks.onOpenDialog?.('shortcuts');
      return true;
    case 'showCli':
      ctx.hooks.onOpenDialog?.('cli');
      return true;
    case 'showAbout':
      ctx.hooks.onOpenDialog?.('about');
      return true;
    case 'toggleBackdrop':
      ctx.hooks.onToggleBackdrop?.();
      return true;
    case 'toggleFullscreen':
      ctx.hooks.onToggleFullscreen?.();
      return true;
    case 'newTab':
      // Detaching the focused host from inside its own key handler leaves xterm mid-event.
      queueMicrotask(() => ctx.newTab());
      return true;
    case 'newScratch':
      // Re-rendering from inside the focused pane's key handler leaves xterm mid-event.
      queueMicrotask(() => ctx.openPane({ kind: 'scratch' }));
      return true;
    case 'openFiles':
      queueMicrotask(() => void openFilesForFocused(ctx));
      return true;
    case 'openGit':
      queueMicrotask(() => void openGitForFocused(ctx));
      return true;
    case 'openSearch': {
      // Read now: the selection can be gone by the time a queued task runs.
      const query = initialQuery(ctx.terminal(ctx.store.focusedId)?.selection() ?? '');
      queueMicrotask(() => void openSearchForFocused(ctx, query));
      return true;
    }
    case 'openEditor':
      void openEditorForFocused(ctx);
      return true;
    case 'nextTab':
    case 'prevTab': {
      const id = nextTab(ctx.store.state, action.type === 'nextTab' ? 1 : -1).activeId;
      queueMicrotask(() => ctx.switchTab(id));
      return true;
    }
    case 'switchToTab':
    case 'switchToLastTab': {
      const tab = tabAt(ctx.store.state, action.type === 'switchToTab' ? action.index : 9);
      if (tab) queueMicrotask(() => ctx.switchTab(tab.id));
      return true;
    }
    case 'nextAttention':
      // Switching tabs detaches the focused host, which must not happen inside its key handler.
      queueMicrotask(() => ctx.nextAttention());
      return true;
    case 'closeTab': {
      const id = ctx.store.activeId;
      queueMicrotask(() => void ctx.requestCloseTab(id));
      return true;
    }
    case 'find': {
      const pane = ctx.terminal(ctx.store.focusedId);
      const host = ctx.hosts.get(ctx.store.focusedId);
      if (pane && host) ctx.findBar.open(pane, host);
      return true;
    }
    // Terminal key handling owns these; non-terminal panes pass them here and act on false.
    case 'copy':
    case 'paste':
    case 'sendInput':
      return false;
    // Only a code preview acts on it (its pane handles the key first). Unhandled, the default
    // Ctrl+G reaches the shell, where Claude Code opens the prompt in an editor.
    case 'goToLine':
      return false;
    default: {
      // A registry action with no case above fails tsc here.
      const unhandled: never = action;
      return unhandled;
    }
  }
}

/** The folder the Open actions start from, toasting when there is none. */
function folderToOpen(ctx: DispatchContext): string | undefined {
  const folder = ctx.folderForNew() ?? ctx.hooks.getRepoFolder?.() ?? undefined;
  if (!folder) showToast('No folder to open');
  return folder;
}

/** Ctrl+Shift+E: a Files pane at the root of the focused pane's repo. */
async function openFilesForFocused(ctx: DispatchContext): Promise<void> {
  const folder = folderToOpen(ctx);
  if (!folder) return;
  try {
    const { root } = await repoRoot(folder);
    ctx.showFiles({ root, folder: root });
  } catch (err) {
    showToast(`Could not open ${folder}: ${String(err)}`);
  }
}

/** Ctrl+Shift+G: a Git pane for the focused pane's repo (design 4.11, 4.13). */
async function openGitForFocused(ctx: DispatchContext): Promise<void> {
  const folder = folderToOpen(ctx);
  if (!folder) return;
  try {
    const { root, isGit } = await repoRoot(folder);
    if (!isGit) {
      showToast(`${folder} is not in a git repo`);
      return;
    }
    ctx.showGit(root);
  } catch (err) {
    showToast(`Could not open ${folder}: ${String(err)}`);
  }
}

/** Ctrl+Shift+H: a Search pane for the focused pane's repo, or its folder outside any repo (design 4.14). */
async function openSearchForFocused(ctx: DispatchContext, query: string): Promise<void> {
  const folder = folderToOpen(ctx);
  if (!folder) return;
  try {
    const { root } = await repoRoot(folder);
    ctx.showSearch(root, query);
  } catch (err) {
    showToast(`Could not open ${folder}: ${String(err)}`);
  }
}

/** Ctrl+Shift+X: the focused pane's repo in the preferred editor, or its folder outside any repo (design 3.12). */
async function openEditorForFocused(ctx: DispatchContext): Promise<void> {
  const folder = folderToOpen(ctx);
  if (!folder) return;
  try {
    const { root } = await repoRoot(folder);
    await openInEditor(root);
  } catch (err) {
    showToast(`Could not open ${folder}: ${String(err)}`);
  }
}
