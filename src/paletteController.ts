// The command palette's inputs and handlers, including the focused repo's worktrees, which load
// each time the palette opens.
import type { AppState } from './appState';
import { CommandPalette } from './commandPalette';
import { lastFolder, paneCards } from './dashboardModel';
import type { FavoritesLayouts } from './favoritesLayouts';
import type { RepoTracker } from './repoTracker';
import { showToast } from './toast';
import { gitWorktrees, type Worktree } from './worktreeApi';
import { WorktreeNewDialog } from './worktreeNewDialog';
import { openNewWorktree } from './worktreeNewFlow';
import type { Workspace } from './workspace';

export interface PaletteControllerDeps {
  state: AppState;
  workspace: () => Workspace;
  repo: RepoTracker;
  favorites: FavoritesLayouts;
  focusTerminal: () => void;
  focusCard: (paneId: string) => void;
  checkForUpdatesNow: () => void;
}

export class PaletteController {
  private readonly palette: CommandPalette;
  /** The focused repo's worktrees, loaded when the palette opens; null until then. */
  private worktreeList: Worktree[] | null = null;
  private readonly newWorktreeDialog = new WorktreeNewDialog();

  constructor(private readonly deps: PaletteControllerDeps) {
    const { state, workspace, repo, favorites, focusTerminal } = deps;
    this.palette = new CommandPalette({
      input: () => ({
        panes: paneCards(workspace().panes(), state.sessions),
        tabs: workspace().tabs(),
        favorites: state.favorites,
        layouts: state.layouts.map((l) => ({ name: l.name, paneCount: l.tab.panes.length })),
        pins: repo.pins,
        globalPins: state.globalPins,
        worktrees: this.worktrees(),
        keybindings: state.settings.keybindings,
      }),
      refocus: focusTerminal,
      focusPane: deps.focusCard,
      switchTab: (tabId) => workspace().switchTab(tabId),
      openFavorite: favorites.openFolder,
      openLayout: favorites.openLayout,
      openPin: repo.openPin,
      runGlobalPin: repo.runGlobalPin,
      openWorktree: (path, opts) => {
        workspace().openTerminal(path, { collapsed: opts.collapsed });
        focusTerminal();
      },
      runAction: (a) => workspace().runAction(a),
      runCommand: (command) => {
        if (command === 'checkForUpdates') deps.checkForUpdatesNow();
        else if (command === 'openContainers') workspace().openContainers();
        else if (command === 'openPorts') workspace().openPorts();
        else if (command === 'openShip') workspace().openShip(null);
        else if (command === 'newWorktree') void this.newWorktree();
      },
    });
  }

  /**
   * New worktree... (docs/design/git.md section 4.27): branches from the focused pane's folder and
   * opens the new pane beside that pane.
   */
  private async newWorktree(): Promise<void> {
    const { workspace, repo } = this.deps;
    const anchorPaneId = workspace().panes().find((p) => p.focused)?.paneId ?? null;
    const folder = repo.focusedFolder();
    const isGit = folder === null ? false : await repo.cachedRepoRoot(folder).then((r) => r.isGit, () => false);
    const result = await this.newWorktreeDialog.open({ folder, isGit });
    if (!result) return;
    // `bb` prints these in its pane; from the palette a toast is the only place they can show.
    const notes = result.created.warnings;
    if (notes.length > 0) showToast(notes.join('; '), 10000);
    await openNewWorktree(workspace(), { ...result, anchorPaneId });
  }

  /** The focused repo's worktrees for the palette; it lists none for fewer than two. */
  private worktrees(): { path: string; name: string; branch: string }[] {
    const list = this.worktreeList;
    if (!list || list.length < 2) return [];
    return list.map((w) => ({
      path: w.path,
      name: lastFolder(w.path) || w.path,
      branch: w.branch ?? w.head?.slice(0, 7) ?? '',
    }));
  }

  /** The palette opens at once; its worktree items arrive when the load finishes. */
  open(): void {
    this.worktreeList = null;
    this.palette.open();
    const repo = this.deps.repo.currentRepo;
    const root = repo?.isGit ? repo.root : null;
    if (!root) return;
    gitWorktrees(root).then(
      (list) => {
        this.worktreeList = list.worktrees;
        this.palette.refresh();
      },
      // The palette just lists no worktrees.
      () => {},
    );
  }
}
