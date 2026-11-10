import './pinsSection.css';
import { renderGlobalPinRow, type GlobalPinRowCallbacks } from './globalPinRow';
import type { GlobalPin } from './globalPins';
import { globeIcon } from './globeIcon';
import { renderPinRow, type PinRowCallbacks } from './pinRow';
import type { RepoInfo } from './repoFiles';
import { isCommandPin, type Pin } from './repos';

export interface RepoPinState {
  pin: Pin;
  absolute: string;
  exists: boolean;
  /** From the parent's listing; picks the pin's icon. Absent means a file. */
  isDir?: boolean;
  /** A command pin whose terminal is running a command (docs/design/dashboard.md section 4.6). */
  running?: boolean;
}

export interface GlobalPinState {
  pin: GlobalPin;
  /** Its terminal for the current repo is running a command. */
  running: boolean;
}

export interface PinsSectionCallbacks extends PinRowCallbacks, GlobalPinRowCallbacks {
  /** The heading's "+": a new command pin in the focused pane's folder. */
  onNewPin(): void;
  /** The heading's globe toggled whether global pins list here. */
  onShowGlobalChange(shown: boolean): void;
}

/** The focused pane's repo and its pins, which the Launch and Pins sections follow, and the global pins. */
export interface RepoState {
  repo: RepoInfo | null;
  pins: RepoPinState[];
  globalPins: GlobalPinState[];
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
  private readonly globalButton: HTMLButtonElement;
  private showGlobal = true;
  private state: RepoState = { repo: null, pins: [], globalPins: [] };

  constructor(private readonly callbacks: PinsSectionCallbacks) {
    this.el = document.createElement('div');
    this.el.className = 'dashboard-section repo-pins';
    this.head = document.createElement('div');
    this.head.className = 'dashboard-section-head';
    const title = document.createElement('h2');
    title.className = 'repo-pins-head';
    const label = document.createElement('span');
    label.textContent = 'Pins';
    this.folder = document.createElement('span');
    this.folder.className = 'repo-pins-folder';
    title.append(label, this.folder);
    const add = document.createElement('button');
    add.type = 'button';
    add.className = 'favorite-add';
    add.textContent = '+';
    add.title = 'Pin a command';
    add.addEventListener('click', () => this.callbacks.onNewPin());
    this.globalButton = document.createElement('button');
    this.globalButton.type = 'button';
    this.globalButton.className = 'pins-global';
    this.globalButton.setAttribute('aria-label', 'Global pins');
    this.globalButton.append(globeIcon());
    this.globalButton.addEventListener('click', () => {
      this.setShowGlobal(!this.showGlobal);
      this.callbacks.onShowGlobalChange(this.showGlobal);
    });
    this.syncGlobalButton();
    this.head.append(title, this.globalButton, add);
    this.list = document.createElement('div');
    this.list.className = 'dashboard-list';
    this.el.append(this.head, this.list);
  }

  /** Applies the saved toggle without firing `onShowGlobalChange`. */
  setShowGlobal(shown: boolean): void {
    if (shown === this.showGlobal) return;
    this.showGlobal = shown;
    this.syncGlobalButton();
    this.update(this.state);
  }

  globalShown(): boolean {
    return this.showGlobal;
  }

  private syncGlobalButton(): void {
    this.globalButton.setAttribute('aria-pressed', String(this.showGlobal));
    this.globalButton.title = this.showGlobal
      ? 'Hide global pins (the top bar lists them)'
      : 'Show global pins here';
  }

  update(state: RepoState): void {
    this.state = state;
    const { repo } = state;
    // Shown with no pins too, since its "+" is a way to add the first one.
    this.el.hidden = repo === null;
    if (!repo) {
      this.list.replaceChildren();
      return;
    }
    this.folder.textContent = ` · ${folderName(repo.root)}`;
    this.folder.title = repo.root;
    const globals = this.showGlobal
      ? state.globalPins.map((g, i) => renderGlobalPinRow(g.pin, i, this.callbacks, g.running))
      : [];
    if (state.pins.length === 0 && globals.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'dashboard-empty';
      empty.textContent = 'Pin a command with +, or a file or folder from a Files pane';
      this.list.replaceChildren(empty);
      return;
    }
    this.list.replaceChildren(
      ...state.pins.map((p, i) => {
        // The repo root itself is pinned as ".", which says nothing on its own.
        const name =
          p.pin.label ?? (isCommandPin(p.pin) ? p.pin.command : p.pin.path === '.' ? folderName(p.absolute) : p.pin.path);
        return renderPinRow(p.pin, name, i, p.isDir ?? false, p.exists, p.absolute, this.callbacks, p.running);
      }),
      ...globals,
    );
  }
}
