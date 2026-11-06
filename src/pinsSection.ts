import './pinsSection.css';
import { renderPinRow, type PinRowCallbacks } from './pinRow';
import type { RepoInfo } from './repoFiles';
import type { Pin } from './repos';

export interface RepoPinState {
  pin: Pin;
  absolute: string;
  exists: boolean;
  /** From the parent's listing; picks the pin's icon. Absent means a file. */
  isDir?: boolean;
}

/** The focused pane's repo and its pins, which the Launch and Pins sections follow. */
export interface RepoState {
  repo: RepoInfo | null;
  pins: RepoPinState[];
}

export function folderName(path: string): string {
  const parts = path.split(/[/\\]+/).filter((p) => p !== '');
  return parts[parts.length - 1] ?? path;
}

/**
 * The dashboard's Pins section, the focused pane's repo's pins (docs/design/dashboard.md
 * section 4.6). The panel keeps it fixed between the top slot and the lower list rather than among
 * the elements.
 */
export class PinsSection {
  readonly el: HTMLElement;
  readonly head: HTMLElement;
  private readonly folder: HTMLElement;
  private readonly list: HTMLElement;

  constructor(private readonly callbacks: PinRowCallbacks) {
    this.el = document.createElement('div');
    this.el.className = 'dashboard-section repo-pins';
    this.head = document.createElement('h2');
    this.head.className = 'repo-pins-head';
    const label = document.createElement('span');
    label.textContent = 'Pins';
    this.folder = document.createElement('span');
    this.folder.className = 'repo-pins-folder';
    this.head.append(label, this.folder);
    this.list = document.createElement('div');
    this.list.className = 'dashboard-list';
    this.el.append(this.head, this.list);
  }

  update(state: RepoState): void {
    const { repo } = state;
    // The heading would introduce nothing; pinning from a Files pane brings it back.
    this.el.hidden = repo === null || state.pins.length === 0;
    if (!repo) {
      this.list.replaceChildren();
      return;
    }
    this.folder.textContent = ` · ${folderName(repo.root)}`;
    this.folder.title = repo.root;
    this.list.replaceChildren(
      ...state.pins.map((p, i) => {
        // The repo root itself is pinned as ".", which says nothing on its own.
        const name = p.pin.label ?? (p.pin.path === '.' ? folderName(p.absolute) : p.pin.path);
        return renderPinRow(p.pin, name, i, p.isDir ?? false, p.exists, p.absolute, this.callbacks);
      }),
    );
  }
}
