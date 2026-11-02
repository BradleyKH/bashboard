import './repoSection.css';
import { openBranchMenu } from './branchMenu';
import { renderPinRow, type PinRowCallbacks } from './pinRow';
import type { RepoInfo } from './repoFiles';
import type { Pin } from './repos';
import { WorktreeList, type WorktreeCallbacks, type WorktreesState } from './worktreeList';

export type RepoOpenKind = 'terminal' | 'files' | 'git' | 'search' | 'editor';

export interface RepoSectionCallbacks extends PinRowCallbacks, WorktreeCallbacks {
  onOpenIn(kind: RepoOpenKind, root: string): void;
}

export interface RepoPinState {
  pin: Pin;
  absolute: string;
  exists: boolean;
  /** From the parent's listing; picks the pin's icon. Absent means a file. */
  isDir?: boolean;
}

export interface RepoSectionState {
  repo: RepoInfo | null;
  pins: RepoPinState[];
  /** Null hides the worktree list. */
  worktrees: WorktreesState | null;
}

function folderName(path: string): string {
  const parts = path.split(/[/\\]+/).filter((p) => p !== '');
  return parts[parts.length - 1] ?? path;
}

function openButton(label: string, title: string, run: () => void): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'repo-button';
  b.textContent = label;
  b.title = title;
  b.addEventListener('click', run);
  return b;
}

/** The dashboard's Repo section: the focused pane's repo, its open buttons, and its pins (docs/design.md section 4.6). */
export class RepoSection {
  readonly el: HTMLElement;
  readonly head: HTMLElement;
  private readonly name: HTMLElement;
  private readonly branch: HTMLElement;
  private readonly buttons: HTMLElement;
  private readonly list: HTMLElement;
  private readonly worktrees: WorktreeList;
  private readonly menuButton: HTMLButtonElement;
  private worktreesState: WorktreesState | null = null;

  constructor(private readonly callbacks: RepoSectionCallbacks) {
    this.el = document.createElement('section');
    this.el.className = 'dashboard-section repo-section';
    this.el.hidden = true;

    this.head = document.createElement('div');
    this.head.className = 'dashboard-section-head';
    const h = document.createElement('h2');
    this.name = document.createElement('span');
    this.name.className = 'repo-name';
    this.branch = document.createElement('span');
    this.branch.className = 'repo-branch';
    h.append(this.name, this.branch);
    this.menuButton = document.createElement('button');
    this.menuButton.type = 'button';
    this.menuButton.className = 'repo-menu-button';
    this.menuButton.textContent = '⋯';
    this.menuButton.title = 'Compare worktrees with...';
    this.menuButton.hidden = true;
    this.menuButton.addEventListener('click', () => this.openPrimaryMenu());
    this.head.append(h, this.menuButton);

    this.buttons = document.createElement('div');
    this.buttons.className = 'repo-buttons';
    this.list = document.createElement('div');
    this.list.className = 'dashboard-list';
    this.worktrees = new WorktreeList(callbacks);
    this.el.append(this.head, this.buttons, this.list, this.worktrees.el);
  }

  update(state: RepoSectionState): void {
    const { repo } = state;
    this.el.hidden = repo === null;
    this.worktreesState = repo ? state.worktrees : null;
    this.worktrees.update(this.worktreesState);
    this.menuButton.hidden = !this.worktrees.shown;
    if (!repo) {
      this.buttons.replaceChildren();
      this.list.replaceChildren();
      return;
    }
    this.name.textContent = folderName(repo.root);
    this.name.title = repo.root;
    this.branch.textContent = repo.isGit && repo.branch ? repo.branch : '';
    this.branch.hidden = !this.branch.textContent;

    // Only Git needs a git repo; ignore rules make Search useful in any folder.
    this.buttons.replaceChildren(
      openButton('Terminal', 'Open a terminal at the repo root', () => this.callbacks.onOpenIn('terminal', repo.root)),
      openButton('Files', 'Open Files at the repo root', () => this.callbacks.onOpenIn('files', repo.root)),
      ...(repo.isGit ? [openButton('Git', 'Open the Git pane for the repo', () => this.callbacks.onOpenIn('git', repo.root))] : []),
      openButton('Search', 'Open a code search for the repo', () => this.callbacks.onOpenIn('search', repo.root)),
      openButton('Editor', 'Open the repo in the editor', () => this.callbacks.onOpenIn('editor', repo.root)),
    );

    this.list.replaceChildren(
      ...state.pins.map((p, i) => {
        // The repo root itself is pinned as ".", which says nothing on its own.
        const name = p.pin.label ?? (p.pin.path === '.' ? folderName(p.absolute) : p.pin.path);
        return renderPinRow(p.pin, name, i, p.isDir ?? false, p.exists, p.absolute, this.callbacks);
      }),
    );
  }

  /** The header's "Compare worktrees with..." menu (docs/design.md section 4.6). */
  private openPrimaryMenu(): void {
    const state = this.worktreesState;
    if (!state) return;
    const { primary, localBranches } = state.list;
    const configured = primary.configured;
    const pick = (branch: string | null) => () => this.callbacks.onSetPrimaryBranch(state.root, branch);
    openBranchMenu(this.menuButton, [
      {
        label: !configured && primary.branch ? `Automatic (${primary.branch})` : 'Automatic',
        checked: !configured,
        onPick: pick(null),
      },
      ...localBranches.map((b) => ({ label: b, checked: b === configured, onPick: pick(b) })),
    ]);
  }
}
