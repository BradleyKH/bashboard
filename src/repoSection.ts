import './repoSection.css';
import { setHintedTitle } from './keyHints';
import { renderPinRow, type PinRowCallbacks } from './pinRow';
import type { RepoInfo } from './repoFiles';
import type { Pin } from './repos';

export type RepoOpenKind = 'terminal' | 'files' | 'git' | 'search' | 'editor';

export interface RepoSectionCallbacks extends PinRowCallbacks {
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
}

function folderName(path: string): string {
  const parts = path.split(/[/\\]+/).filter((p) => p !== '');
  return parts[parts.length - 1] ?? path;
}

/** `action` is the keymap action that opens the same pane at the same root, if one does. */
function openButton(label: string, title: string, run: () => void, action?: string): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'repo-button';
  b.textContent = label;
  if (action) setHintedTitle(b, title, action);
  else b.title = title;
  b.addEventListener('click', run);
  return b;
}

/**
 * The dashboard's Folder section, the focused pane's repo and its open buttons, and the Pins
 * section with that repo's pins (docs/design.md section 4.6). The panel places them apart: Folder
 * is a draggable element, and Pins sits fixed between the top slot and the lower list.
 */
export class RepoSection {
  readonly el: HTMLElement;
  readonly head: HTMLElement;
  readonly pins: HTMLElement;
  readonly pinsHead: HTMLElement;
  private readonly name: HTMLElement;
  private readonly branch: HTMLElement;
  private readonly buttons: HTMLElement;
  private readonly list: HTMLElement;
  private readonly pinsFolder: HTMLElement;

  constructor(private readonly callbacks: RepoSectionCallbacks) {
    this.el = document.createElement('section');
    this.el.className = 'dashboard-section repo-section';
    this.el.hidden = true;

    // The branch is in the header, so a collapsed section still says where the pane is.
    this.head = document.createElement('div');
    this.head.className = 'dashboard-section-head repo-head';
    const h = document.createElement('h2');
    h.textContent = 'Folder';
    this.name = document.createElement('span');
    this.name.className = 'repo-name';
    this.branch = document.createElement('span');
    this.branch.className = 'repo-branch';
    this.head.append(h, this.name, this.branch);

    this.buttons = document.createElement('div');
    this.buttons.className = 'repo-buttons';

    this.pins = document.createElement('div');
    this.pins.className = 'dashboard-section repo-pins';
    this.pinsHead = document.createElement('h2');
    this.pinsHead.className = 'repo-pins-head';
    const pinsLabel = document.createElement('span');
    pinsLabel.textContent = 'Pins';
    this.pinsFolder = document.createElement('span');
    this.pinsFolder.className = 'repo-pins-folder';
    this.pinsHead.append(pinsLabel, this.pinsFolder);
    this.list = document.createElement('div');
    this.list.className = 'dashboard-list';
    this.pins.append(this.pinsHead, this.list);
    this.el.append(this.head, this.buttons);
  }

  /**
   * Names the pins' folder in their heading when Folder is not right above to say it; the CSS
   * drops the name rather than wrap the heading when it does not fit.
   */
  setPinsFolderShown(shown: boolean): void {
    this.pinsFolder.hidden = !shown;
  }

  update(state: RepoSectionState): void {
    const { repo } = state;
    this.el.hidden = repo === null;
    // The heading would introduce nothing; pinning from a Files pane brings it back.
    this.pins.hidden = repo === null || state.pins.length === 0;
    if (!repo) {
      this.buttons.replaceChildren();
      this.list.replaceChildren();
      return;
    }
    this.name.textContent = folderName(repo.root);
    this.name.title = repo.root;
    this.pinsFolder.textContent = ` · ${this.name.textContent}`;
    this.pinsFolder.title = repo.root;
    this.branch.textContent = repo.isGit && repo.branch ? repo.branch : '';
    this.branch.hidden = !this.branch.textContent;

    // Only Git needs a git repo; ignore rules make Search useful in any folder. Terminal names no
    // keys: splitAuto opens at the focused pane's folder, which can be below the repo root.
    this.buttons.replaceChildren(
      openButton('Terminal', 'Open a terminal at the repo root', () => this.callbacks.onOpenIn('terminal', repo.root)),
      openButton('Files', 'Open Files at the repo root', () => this.callbacks.onOpenIn('files', repo.root), 'openFiles'),
      ...(repo.isGit ? [openButton('Git', 'Open the Git pane for the repo', () => this.callbacks.onOpenIn('git', repo.root), 'openGit')] : []),
      openButton('Search', 'Open a code search for the repo', () => this.callbacks.onOpenIn('search', repo.root), 'openSearch'),
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
}
