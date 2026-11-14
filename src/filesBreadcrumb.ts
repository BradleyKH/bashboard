import { attachContextMenu, closeContextMenu, isContextMenuOpenFor, openContextMenu } from './contextMenu';
import { item, type MenuEntry } from './contextMenuModel';
import {
  breadcrumb,
  canBack,
  canForward,
  DEFAULT_FILES_SORT,
  FILES_SORT_KEYS,
  sortKeyLabel,
  sortLabel,
  type FilesSort,
  type FilesSortKey,
  type History,
} from './filesModel';
import { filledPinIcon } from './pinIcon';
import { ZoomButtons } from './zoomButtons';

export interface FilesBreadcrumbOptions {
  onBack: () => void;
  onForward: () => void;
  onNavigate: (folder: string) => void;
  /** A key was picked from the sort button's menu. */
  onSort: (key: FilesSortKey) => void;
  /** The list's starting zoom level. */
  zoom: number;
  /** Applies the list's zoom level. */
  onZoom: (zoom: number) => void;
  /** Where Ctrl+wheel steps the list's zoom. */
  zoomWheelTarget: HTMLElement;
  /** Pins the folder, or unpins it when it is already pinned. */
  onTogglePin: () => void;
  /** The right-click menu for the current folder, shared by the trail and its buttons. */
  folderMenu: () => MenuEntry[];
}

export interface FilesBreadcrumbState {
  root: string;
  folder: string;
  history: History;
  pinned: boolean;
  sort: FilesSort;
}

/** Back and forward buttons, the path from the repo root, the sort button, the list's zoom buttons, and the pin button. */
export class FilesBreadcrumb {
  readonly el: HTMLElement;
  private readonly backBtn: HTMLButtonElement;
  private readonly forwardBtn: HTMLButtonElement;
  private readonly trail: HTMLElement;
  private readonly sortBtn: HTMLButtonElement;
  private readonly pinBtn: HTMLButtonElement;
  private sort: FilesSort = DEFAULT_FILES_SORT;

  constructor(private readonly opts: FilesBreadcrumbOptions) {
    this.el = document.createElement('div');
    this.el.className = 'files-crumb';
    this.backBtn = this.button('‹', 'Back', opts.onBack);
    this.forwardBtn = this.button('›', 'Forward', opts.onForward);
    this.trail = document.createElement('div');
    this.trail.className = 'files-crumb-trail';
    this.sortBtn = this.button('', 'Sort', () => this.toggleSortMenu());
    this.sortBtn.classList.add('files-crumb-sort');
    const zoom = new ZoomButtons('files-crumb-btn', 'filesList', opts.zoom, opts.onZoom, opts.zoomWheelTarget);
    this.pinBtn = this.button('', 'Pin this folder', opts.onTogglePin);
    this.pinBtn.classList.add('files-crumb-pin');
    this.pinBtn.append(filledPinIcon());
    this.el.append(this.backBtn, this.forwardBtn, this.trail, this.sortBtn, zoom.el, this.pinBtn);
    attachContextMenu(this.el, () => ({ entries: opts.folderMenu() }));
  }

  update(state: FilesBreadcrumbState): void {
    this.backBtn.disabled = !canBack(state.history);
    this.forwardBtn.disabled = !canForward(state.history);
    this.pinBtn.title = state.pinned ? 'Unpin this folder' : 'Pin this folder';
    this.pinBtn.classList.toggle('on', state.pinned);
    this.sort = state.sort;
    this.sortBtn.textContent = sortLabel(state.sort);

    const crumbs = breadcrumb(state.root, state.folder);
    this.trail.replaceChildren();
    crumbs.forEach((c, i) => {
      if (i > 0) {
        const sep = document.createElement('span');
        sep.className = 'files-crumb-sep';
        sep.textContent = '/';
        this.trail.append(sep);
      }
      const seg = document.createElement('button');
      seg.type = 'button';
      seg.className = 'files-crumb-seg';
      seg.textContent = c.name;
      seg.title = c.path;
      seg.dataset.path = c.path;
      if (i === crumbs.length - 1) seg.disabled = true;
      else seg.addEventListener('click', () => this.opts.onNavigate(c.path));
      this.trail.append(seg);
    });
    this.trail.scrollLeft = this.trail.scrollWidth;
  }

  /** Picking the active key flips its direction, so the menu shows that key's current arrow. */
  private toggleSortMenu(): void {
    if (isContextMenuOpenFor(this.sortBtn)) {
      closeContextMenu();
      return;
    }
    const entries = FILES_SORT_KEYS.map((key) =>
      item(key === this.sort.key ? sortLabel(this.sort) : sortKeyLabel(key), () => this.opts.onSort(key), {
        checked: key === this.sort.key,
      }),
    );
    openContextMenu(entries, { anchorEl: this.sortBtn, align: 'right' });
  }

  private button(label: string, title: string, onClick: () => void): HTMLButtonElement {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'files-crumb-btn';
    b.textContent = label;
    b.title = title;
    b.addEventListener('click', onClick);
    return b;
  }
}
