// Launch: the dashboard section's buttons, the top bar's + menu, and the openLaunch menu, each
// previewing where its pane would land (docs/design/dashboard.md section 4.6).
import { agentsDetected } from './agentApi';
import type { ContainersStore } from './containersStore';
import { openContextMenu } from './contextMenu';
import { isFolderless, launchLabel, launchMenuItems, type LaunchKind, type LocalLaunch } from './launchModel';
import { LaunchPreview } from './launchPreview';
import { listOllamaModels, pollModelServers } from './modelServersApi';
import type { RepoTracker } from './repoTracker';
import { showToast } from './toast';
import type { Workspace } from './workspace';
import { supports } from './platform';

export interface LaunchControllerDeps {
  repo: RepoTracker;
  workspace: () => Workspace;
  containers: ContainersStore;
  /** Every launch, before it runs; the tour waits for one. */
  onLaunch?: (kind: LaunchKind) => void;
}

export class LaunchController {
  private readonly launchPreview = new LaunchPreview();

  constructor(private readonly deps: LaunchControllerDeps) {}

  private launchRoot(): string | null {
    return this.deps.repo.currentRepo?.root ?? this.deps.repo.focusedFolder();
  }

  readonly preview = (kind: LaunchKind | null): void => {
    // A folderless kind lands the same way wherever it would open; launchTarget reads the root only
    // to find a Files or Git pane to reuse.
    const root = kind && isFolderless(kind) ? (this.launchRoot() ?? '') : this.launchRoot();
    if (!kind || root === null) {
      this.launchPreview.hide();
      return;
    }
    this.launchPreview.show(this.deps.workspace().launchTarget(kind, root), launchLabel(kind));
  };

  readonly launch = (kind: LaunchKind): void => {
    this.launchPreview.hide();
    this.deps.onLaunch?.(kind);
    if (isFolderless(kind)) {
      this.deps.workspace().openPane({ kind });
      return;
    }
    const root = this.launchRoot();
    if (root) this.deps.repo.openIn(kind, root);
    else showToast('No folder to open');
  };

  /** The local-model entries, or undefined unless Ollama answers, is on PATH, and has models. */
  private async localLaunch(): Promise<LocalLaunch | undefined> {
    try {
      const [agents, snap, installed] = await Promise.all([agentsDetected(), pollModelServers(), listOllamaModels()]);
      if (!snap.ollama || !snap.ollamaOnPath || agents.length === 0 || installed.length === 0) return undefined;
      return {
        agents,
        models: installed.map((m) => m.name),
        onRun: (command) => {
          this.launchPreview.hide();
          this.deps.workspace().openTerminalWithCommand(this.launchRoot() ?? undefined, command);
        },
      };
    } catch {
      return undefined;
    }
  }

  /**
   * Drops from `anchor`, or opens at the focused pane's top-left corner for the keyboard, which
   * keeps it clear of the preview's label in the middle of the new pane.
   */
  async openMenu(anchor?: HTMLElement): Promise<void> {
    const local = await this.localLaunch();
    const items = launchMenuItems(
      {
        isGit: this.deps.repo.currentRepo?.isGit ?? false,
        containers: this.deps.containers.available,
        localBrowser: supports('localBrowser'),
      },
      this.launch,
      this.preview,
      local,
    );
    const rect = anchor ? null : this.deps.workspace().focusedPaneRect();
    const at = anchor
      ? { anchorEl: anchor, align: 'right' as const }
      : rect
        ? { x: rect.x + 12, y: rect.y + 32 }
        : { x: window.innerWidth / 2, y: window.innerHeight / 3 };
    openContextMenu(items, at, { focusFirst: true, spotlight: true, onClose: () => this.launchPreview.hide() });
  }
}
