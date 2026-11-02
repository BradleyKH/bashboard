import './filesPane.css';
import { attachContextMenu, closeContextMenu, isContextMenuOpenFor, openContextMenu } from './contextMenu';
import type { MenuEntry } from './contextMenuModel';
import { copyPath, copyText } from './copyText';
import { windowsPathText } from './displayPath';
import { openInEditor } from './editors';
import { samePath } from './favorites';
import { FilePreview } from './filePreview';
import {
  filePreviewMenuItems,
  fileRowMenuItems,
  folderMenuItems,
  type FileRowMenuHandlers,
  type MoveTarget,
} from './fileRowMenu';
import { FilesBreadcrumb } from './filesBreadcrumb';
import { FilesList } from './filesList';
import { openFolder } from './folderButton';
import {
  back,
  currentFolder,
  EMPTY_HISTORY,
  forward,
  parentWithin,
  visit,
  type FileEntry,
  type History,
} from './filesModel';
import { insertPathText, pinTarget } from './filesRouting';
import { lookup, type Action, type Keymap } from './keymap';
import type { CellSize } from './layout';
import { toFontFamily } from './pane';
import type { PaneView } from './paneView';
import { fsList, fsMove, fsUnwatch, fsWatch, repoRoot } from './repoFiles';
import type { Settings } from './settings';
import { textFieldOwns } from './textPaneKeys';
import { textZoom } from './textZoomStore';
import { showToast } from './toast';

export interface FilesPaneOptions {
  host: HTMLElement;
  paneId: string;
  settings: Settings;
  folder: string;
  /** The entry to select: a name in `folder`, or an absolute path whose parent is `folder`. */
  selected?: string | null;
  /** The repo root, when the caller already knows it; otherwise resolved with `repoRoot`. */
  root?: string;
  /** Start with the preview filling the pane (a restored pane whose `selected` is a file). */
  expanded?: boolean;
  keymap: () => Keymap;
  dispatch: (action: Action) => boolean;
  onFocus: () => void;
  /** The folder, selection, or root changed (title and saved state follow). */
  onChange: () => void;
  onOpenTerminalHere: (folder: string) => void;
  /** Insert path on rows: their absolute paths and this pane's root, to make them relative to. */
  onInsertPaths: (paths: string[], baseRoot: string) => void;
  /**
   * A row drag began; the workspace runs the path drag. `move` is set when every dragged entry is
   * a file, so a folder drop can move them out of `folder` through `movePaths`.
   */
  onPathDragStart?: (paths: string[], e: PointerEvent, move?: { paneId: string; folder: string }) => void;
  onPin: (absolute: string, isDir: boolean) => void;
  /** The breadcrumb's pin button on an already pinned folder; without it the button only pins. */
  onUnpin?: (absolute: string) => void;
  /** Absolute paths of the repo's pinned folders that exist. */
  getPinnedFolders: () => string[];
  onOpenInEditor?: (path: string) => void;
}

const MIN_SPLIT = 0.15;
const MAX_SPLIT = 0.85;

function errorText(err: unknown): string {
  if (typeof err === 'string') return err;
  if (err instanceof Error) return err.message;
  return String(err);
}

function baseName(p: string): string {
  const parts = p.split(/[\\/]+/).filter((s) => s !== '');
  return parts.length > 0 ? parts[parts.length - 1] : p;
}

function childPath(folder: string, name: string): string {
  const sep = folder.includes('\\') ? '\\' : '/';
  return /[\\/]$/.test(folder) ? `${folder}${name}` : `${folder}${sep}${name}`;
}

/**
 * The entry name a selection refers to: a bare name as is, an absolute path by its basename when
 * its parent is `folder`, else null.
 */
function selectionName(folder: string, select: string | null | undefined): string | null {
  if (!select) return null;
  if (!/[\\/]/.test(select)) return select;
  const parent = pinTarget(folder, select, false).folder;
  return samePath(parent, folder) ? baseName(select) : null;
}

/** A folder's files beside a preview of the selected one (docs/design.md section 4.12). */
export class FilesPane implements PaneView {
  readonly kind = 'files' as const;
  readonly paneId: string;
  private readonly opts: FilesPaneOptions;
  private readonly host: HTMLElement;
  private readonly body: HTMLElement;
  private readonly left: HTMLElement;
  private readonly divider: HTMLElement;
  private readonly right: HTMLElement;
  private readonly notice: HTMLElement;
  private readonly crumb: FilesBreadcrumb;
  private readonly list: FilesList;
  private readonly preview: FilePreview;
  private settings: Settings;
  private rootPath: string;
  private currentPath: string;
  private selectedName: string | null;
  private selectedModified: number | null = null;
  private history: History = EMPTY_HISTORY;
  private entries: FileEntry[] = [];
  private split = 0.4;
  /** The preview fills the pane, with the list, breadcrumb, and divider hidden. */
  private previewExpanded = false;
  /**
   * A followed markdown link replaces the focused view, dropping focus to the page; the next
   * shown preview takes it back so Esc still reaches the pane.
   */
  private refocusPreview = false;
  private watchId: number | null = null;
  /** Bumped on every folder change, so late listings and watch ids for an old folder are dropped. */
  private generation = 0;
  private disposed = false;
  private readonly listeners: Array<() => void> = [];

  constructor(opts: FilesPaneOptions) {
    this.opts = opts;
    this.host = opts.host;
    this.paneId = opts.paneId;
    this.settings = opts.settings;
    this.rootPath = opts.root ?? opts.folder;
    this.currentPath = opts.folder;
    this.selectedName = selectionName(opts.folder, opts.selected);

    this.host.style.display = 'flex';
    this.host.style.flexDirection = 'column';
    this.body = document.createElement('div');
    this.body.className = 'pane-body files-body';
    this.body.tabIndex = -1;

    this.left = document.createElement('div');
    this.left.className = 'files-left';
    this.crumb = new FilesBreadcrumb({
      onBack: () => this.goBack(),
      onForward: () => this.goForward(),
      onNavigate: (folder) => void this.navigate(folder, null, true),
      onOpenInExplorer: () => openFolder(this.currentPath),
      onOpenTerminalHere: () => opts.onOpenTerminalHere(this.currentPath),
      zoom: textZoom('filesList'),
      onZoom: (zoom) => this.left.style.setProperty('--files-zoom', String(zoom)),
      zoomWheelTarget: this.left,
      onTogglePin: () => this.togglePin(),
      folderMenu: () => this.folderMenu(),
    });
    this.list = new FilesList({
      onSelect: (entry) => this.selectEntry(entry),
      onActivate: (entry) => this.activate(entry),
      onUp: () => this.goUp(),
      onMenu: (entry, selection, anchor) => {
        if (isContextMenuOpenFor(anchor)) closeContextMenu();
        else {
          const target = anchor.closest<HTMLElement>('.file-row');
          openContextMenu(this.rowMenu(entry, selection), { anchorEl: anchor, align: 'right' }, { target });
        }
      },
      rowMenu: (entry, selection) => this.rowMenu(entry, selection),
      folderMenu: () => this.folderMenu(),
      onDragStart: (entries, e) => this.startRowDrag(entries, e),
    });
    this.notice = document.createElement('div');
    this.notice.className = 'files-notice';
    this.notice.hidden = true;
    this.left.append(this.crumb.el, this.list.el, this.notice);

    this.divider = document.createElement('div');
    this.divider.className = 'files-divider';
    this.right = document.createElement('div');
    this.right.className = 'files-right';
    this.preview = new FilePreview({
      host: this.right,
      settings: opts.settings,
      keymap: opts.keymap,
      dispatch: opts.dispatch,
      onOpenFile: (path) => {
        const t = pinTarget(this.rootPath, path, false);
        this.refocusPreview = this.hasFocus();
        void this.showFolder(t.folder, t.select);
      },
      onOpenInEditor: (path) => this.openInEditor(path),
      onToggleExpand: () => (this.previewExpanded ? this.showList(true) : this.setPreviewExpanded(true)),
      onShown: (expandable) => {
        const refocus = this.refocusPreview && document.activeElement === document.body;
        this.refocusPreview = false;
        if (!expandable && this.previewExpanded) this.showList(this.hasFocus() || refocus);
        else if (refocus) this.preview.focus();
      },
    });

    this.body.append(this.left, this.divider, this.right);
    this.host.appendChild(this.body);
    this.applySplit();
    // Restored expanded before the first listing, so the list does not flash; the navigation
    // rules show it again if the file is missing or not previewable.
    if (opts.expanded && this.selectedName !== null) {
      this.previewExpanded = true;
      this.body.classList.add('preview-expanded');
      this.preview.setExpanded(true);
    }

    this.listeners.push(attachContextMenu(this.preview.el, () => ({ entries: this.previewMenu() })));
    this.listen(this.host, 'focusin', () => opts.onFocus());
    this.listen(this.host, 'keydown', (e) => this.onKeyDown(e as KeyboardEvent));
    this.listen(this.divider, 'pointerdown', (e) => this.startDrag(e as PointerEvent));
    // Mouse back and forward buttons; WebView2 would otherwise navigate the page.
    for (const type of ['mousedown', 'auxclick']) {
      this.listen(this.host, type, (e) => {
        const b = (e as MouseEvent).button;
        if (b === 3 || b === 4) e.preventDefault();
      });
    }
    this.listen(this.host, 'mouseup', (e) => {
      const m = e as MouseEvent;
      if (m.button !== 3 && m.button !== 4) return;
      m.preventDefault();
      if (m.button === 3) this.goBack();
      else this.goForward();
    });

    if (opts.root === undefined) void this.resolveRoot(opts.folder);
    void this.navigate(opts.folder, opts.selected ?? null, true);
  }

  /** The folder shown (a saved folder that no longer exists stays here). */
  get folder(): string {
    return this.currentPath;
  }

  root(): string {
    return this.rootPath;
  }

  /** The folder's name, for the title strip. */
  title(): string {
    return baseName(this.currentPath);
  }

  /**
   * The `files` saved-pane fields; `selected` is the selected entry's name within `folder`, and
   * `expanded` whether the preview fills the pane.
   */
  saved(): { folder: string; selected: string | null; root: string; expanded: boolean } {
    return {
      folder: this.currentPath,
      selected: this.selectedName,
      root: this.rootPath,
      expanded: this.previewExpanded,
    };
  }

  /**
   * Shows a folder, recording it in history. `select` is an entry name in that folder, or an
   * absolute path whose parent is the folder; anything else selects nothing.
   */
  async showFolder(folder: string, select?: string | null): Promise<void> {
    // Showing a folder brings the list back; selecting a file keeps the preview expanded.
    if (this.previewExpanded && selectionName(folder, select) === null) this.showList(this.hasFocus());
    if (samePath(folder, this.currentPath) && this.notice.hidden) {
      const name = selectionName(folder, select);
      if (name === null) return;
      const entry = this.entries.find((e) => e.name === name);
      if (entry) {
        this.list.select(entry.name);
        this.selectEntry(entry);
        return;
      }
    }
    await this.navigate(folder, select ?? null, true);
  }

  /**
   * The folder a dragged file would move into at `el`: a folder row, a breadcrumb segment, or
   * elsewhere in the list for the folder shown. Null outside those, or while the preview fills
   * the pane.
   */
  moveTargetAt(el: Element): { folder: string; el: HTMLElement } | null {
    if (this.previewExpanded || !this.notice.hidden) return null;
    const seg = el.closest<HTMLElement>('.files-crumb-seg');
    if (seg?.dataset.path && this.crumb.el.contains(seg)) return { folder: seg.dataset.path, el: seg };
    const rows = this.list.el.querySelector<HTMLElement>('.files-list-rows');
    if (!rows?.contains(el)) return null;
    const dir = el.closest<HTMLElement>('.file-row.dir');
    if (dir?.dataset.name) return { folder: childPath(this.currentPath, dir.dataset.name), el: dir };
    return { folder: this.currentPath, el: rows };
  }

  /** Moves files into `toDir`, one at a time, toasting any that fail, then re-lists. */
  async movePaths(paths: string[], toDir: string): Promise<void> {
    // The preview's unsaved text goes to the file before it moves.
    if (this.preview.path !== null && paths.some((p) => samePath(p, this.preview.path!))) await this.flush();
    const failed: string[] = [];
    for (const p of paths) {
      try {
        await fsMove(p, toDir);
      } catch (e) {
        failed.push(`${baseName(p)}: ${errorText(e)}`);
      }
    }
    if (failed.length === 1) showToast(`Could not move ${failed[0]}`);
    else if (failed.length > 1) showToast(`Could not move ${failed.length} files; ${failed[0]}`);
    // The folder watch re-lists too; this makes the rows disappear without waiting for it.
    if (!this.disposed) await this.relist(this.generation);
  }

  /** The repo's pins changed; refreshes the breadcrumb's pin button. */
  pinsChanged(): void {
    this.renderCrumb();
  }

  /** Saves pending editor text. */
  async flush(): Promise<void> {
    try {
      await this.preview.flush();
    } catch (e) {
      showToast(`Could not save the file: ${errorText(e)}`);
    }
  }

  focus(): void {
    if (!this.notice.hidden) this.body.focus();
    else if (this.previewExpanded) this.preview.focus();
    else this.list.focus();
  }

  setExpanded(_expanded: boolean): void {}

  applySettings(settings: Settings): void {
    this.settings = settings;
    this.preview.applySettings(settings);
  }

  cellSize(): CellSize {
    const probe = document.createElement('span');
    probe.textContent = 'M'.repeat(10);
    probe.style.cssText = 'position: absolute; visibility: hidden; white-space: pre;';
    probe.style.fontFamily = toFontFamily(this.settings.font.family);
    probe.style.fontSize = `${this.settings.font.size}px`;
    this.body.appendChild(probe);
    const width = probe.getBoundingClientRect().width / 10;
    const probeHeight = probe.getBoundingClientRect().height;
    probe.remove();
    const row = this.list.el.querySelector<HTMLElement>('.file-row');
    const height = row?.offsetHeight || probeHeight || this.settings.font.size * 1.2;
    const rows = this.list.el.querySelector<HTMLElement>('.files-list-rows');
    // The rows have no height while the list is hidden behind an expanded preview.
    const inner = this.previewExpanded ? this.body.clientHeight : (rows?.clientHeight ?? this.body.clientHeight);
    return {
      width,
      height,
      // Everything outside the list's rows: borders, title strip, breadcrumb, filter.
      padX: Math.max(0, this.host.offsetWidth - this.body.clientWidth) + 1,
      padY: Math.max(0, this.host.offsetHeight - inner) + 1,
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.generation++;
    this.unwatch();
    this.preview.dispose();
    for (const off of this.listeners) off();
    this.listeners.length = 0;
    this.body.remove();
  }

  private async resolveRoot(folder: string): Promise<void> {
    try {
      const info = await repoRoot(folder);
      if (this.disposed) return;
      this.rootPath = info.root;
      this.renderCrumb();
      this.opts.onChange();
    } catch {
      // A folder that cannot be resolved stays its own root.
    }
  }

  private async navigate(folder: string, select: string | null, record: boolean): Promise<void> {
    const gen = ++this.generation;
    const focused = this.hasFocus();
    this.unwatch();
    const changed = !samePath(folder, this.currentPath);
    this.currentPath = folder;
    if (record) this.history = visit(this.history, folder);
    this.selectedName = selectionName(folder, select);
    this.selectedModified = null;
    this.entries = [];
    this.list.setFolder();
    this.renderCrumb();
    if (changed) this.opts.onChange();
    await this.preview.show(null);
    if (gen !== this.generation) return;

    let entries: FileEntry[];
    try {
      entries = await fsList(folder);
    } catch (e) {
      if (gen !== this.generation) return;
      this.showNotice(folder, e);
      return;
    }
    if (gen !== this.generation) return;
    this.hideNotice();
    this.entries = entries;
    this.list.setEntries(entries);
    this.startWatch(folder, gen);

    const entry = this.selectedName === null ? undefined : entries.find((e) => e.name === this.selectedName);
    if (this.previewExpanded && (!entry || entry.isDir)) {
      // Clearing the preview dropped its focus to the page; take it back unless it moved on.
      this.showList(this.hasFocus() || (focused && document.activeElement === document.body));
    }
    if (entry) {
      this.list.select(entry.name);
      this.selectEntry(entry);
    } else if (this.selectedName !== null) {
      this.selectedName = null;
      this.opts.onChange();
    }
  }

  private startWatch(folder: string, gen: number): void {
    fsWatch(folder, () => void this.relist(gen)).then(
      (id) => {
        if (gen === this.generation && !this.disposed) this.watchId = id;
        else void fsUnwatch(id).catch(() => {});
      },
      () => {},
    );
  }

  private unwatch(): void {
    if (this.watchId === null) return;
    const id = this.watchId;
    this.watchId = null;
    void fsUnwatch(id).catch(() => {});
  }

  private async relist(gen: number): Promise<void> {
    let entries: FileEntry[];
    try {
      entries = await fsList(this.currentPath);
    } catch (e) {
      if (gen !== this.generation) return;
      this.unwatch();
      this.showNotice(this.currentPath, e);
      return;
    }
    if (gen !== this.generation) return;
    this.entries = entries;
    this.list.setEntries(entries);
    if (this.selectedName === null) return;
    const entry = entries.find((e) => e.name === this.selectedName);
    if (!entry) {
      this.showList(this.hasFocus());
      this.selectedName = null;
      this.selectedModified = null;
      this.list.select(null);
      void this.preview.show(null);
      this.opts.onChange();
    } else if (!entry.isDir && this.selectedModified !== null && entry.modified !== this.selectedModified) {
      this.selectedModified = entry.modified;
      this.preview.diskChanged(entry.modified);
    }
  }

  private selectEntry(entry: FileEntry): void {
    const changed = entry.name !== this.selectedName;
    this.selectedName = entry.name;
    if (entry.isDir) {
      if (this.previewExpanded) this.showList(this.hasFocus());
      this.selectedModified = null;
      void this.preview.show(null);
    } else if (changed || this.preview.path === null) {
      this.selectedModified = entry.modified;
      void this.preview.show(childPath(this.currentPath, entry.name), entry.size);
    }
    if (changed) this.opts.onChange();
  }

  private activate(entry: FileEntry): void {
    const path = childPath(this.currentPath, entry.name);
    if (entry.isDir) void this.navigate(path, null, true);
    else this.openInEditor(path);
  }

  private goUp(): void {
    const parent = parentWithin(this.rootPath, this.currentPath);
    if (parent === null) return;
    void this.navigate(parent, baseName(this.currentPath), true);
  }

  private goBack(): void {
    const h = back(this.history);
    if (h === this.history) return;
    this.history = h;
    void this.navigate(currentFolder(h)!, null, false);
  }

  private goForward(): void {
    const h = forward(this.history);
    if (h === this.history) return;
    this.history = h;
    void this.navigate(currentFolder(h)!, null, false);
  }

  private isPinned(folder: string): boolean {
    return this.opts.getPinnedFolders().some((p) => samePath(p, folder));
  }

  private togglePin(folder = this.currentPath): void {
    if (this.isPinned(folder) && this.opts.onUnpin) this.opts.onUnpin(folder);
    else this.opts.onPin(folder, true);
  }

  private openInEditor(path: string): void {
    if (this.opts.onOpenInEditor) this.opts.onOpenInEditor(path);
    else void openInEditor(path);
  }

  private moveTargets(selection: readonly FileEntry[]): MoveTarget[] {
    const out: MoveTarget[] = [];
    const add = (path: string, label: string) => {
      if (samePath(path, this.currentPath)) return;
      if (out.some((t) => samePath(t.path, path))) return;
      out.push({ label, path });
    };
    for (const p of this.opts.getPinnedFolders()) {
      add(p, samePath(p, this.rootPath) ? baseName(p) : insertPathText(this.rootPath, p));
    }
    for (const e of this.entries) {
      if (e.isDir && !selection.some((x) => x.name === e.name)) add(childPath(this.currentPath, e.name), `${e.name}/`);
    }
    return out;
  }

  // Paths are fixed when a menu is built, so a choice acts on the folder the menu was opened in.
  private rowMenu(entry: FileEntry, selection: FileEntry[]): MenuEntry[] {
    const folder = this.currentPath;
    const pathOf = (e: FileEntry) => childPath(folder, e.name);
    const handlers: FileRowMenuHandlers = {
      openTerminalHere: (e) => this.opts.onOpenTerminalHere(pathOf(e)),
      openInEditor: (e) => this.openInEditor(pathOf(e)),
      copyPath: (es) => {
        if (es.length === 1) void copyPath(pathOf(es[0]));
        else void copyText(es.map((e) => windowsPathText(pathOf(e))).join('\n'), 'paths');
      },
      insertPath: (es) => this.opts.onInsertPaths(es.map(pathOf), this.rootPath),
      moveTo: (files, toDir) => void this.movePaths(files.map(pathOf), toDir),
      pin: (e) => this.opts.onPin(pathOf(e), e.isDir),
    };
    return fileRowMenuItems(entry, selection, this.moveTargets(selection), handlers);
  }

  private startRowDrag(entries: FileEntry[], e: PointerEvent): void {
    const paths = entries.map((x) => childPath(this.currentPath, x.name));
    const move = entries.every((x) => !x.isDir) ? { paneId: this.paneId, folder: this.currentPath } : undefined;
    this.opts.onPathDragStart?.(paths, e, move);
  }

  private folderMenu(): MenuEntry[] {
    const folder = this.currentPath;
    return folderMenuItems(
      { pinned: this.isPinned(folder) },
      {
        openTerminalHere: () => this.opts.onOpenTerminalHere(folder),
        openInExplorer: () => openFolder(folder),
        copyPath: () => void copyPath(folder),
        togglePin: () => this.togglePin(folder),
      },
    );
  }

  private previewMenu(): MenuEntry[] {
    const text = this.preview.selectedText();
    return filePreviewMenuItems(
      { hasSelection: text !== '', path: this.preview.path, canFind: this.preview.findable },
      {
        copy: () => void copyText(text, 'text'),
        find: () => void this.preview.openFind(),
        openInEditor: (path) => this.openInEditor(path),
        copyPath: (path) => void copyPath(path),
      },
    );
  }

  private showNotice(folder: string, err: unknown): void {
    if (this.previewExpanded) {
      const focused = this.hasFocus();
      this.showList(false);
      if (focused) this.body.focus();
    }
    this.entries = [];
    const head = document.createElement('div');
    head.className = 'files-notice-head';
    head.textContent = 'This folder could not be opened:';
    const path = document.createElement('div');
    path.className = 'files-notice-path';
    path.textContent = folder;
    const detail = document.createElement('div');
    detail.className = 'files-notice-detail';
    detail.textContent = errorText(err);
    this.notice.replaceChildren(head, path, detail);
    this.notice.hidden = false;
    this.body.classList.add('missing');
  }

  private hideNotice(): void {
    this.notice.hidden = true;
    this.notice.replaceChildren();
    this.body.classList.remove('missing');
  }

  private renderCrumb(): void {
    this.crumb.update({
      root: this.rootPath,
      folder: this.currentPath,
      history: this.history,
      pinned: this.isPinned(this.currentPath),
    });
  }

  private hasFocus(): boolean {
    return this.host.contains(document.activeElement);
  }

  /** Fills the pane with a text preview, hiding the list, breadcrumb, and divider. */
  private setPreviewExpanded(focus: boolean): void {
    if (this.previewExpanded || !this.preview.expandable) return;
    this.previewExpanded = true;
    this.body.classList.add('preview-expanded');
    this.preview.setExpanded(true);
    if (focus && this.hasFocus()) this.preview.focus();
    this.opts.onChange();
  }

  /**
   * Brings the list back beside the preview with the previewed entry selected. The divider
   * returns where it was, since `split` and the list's flex-basis are untouched while hidden.
   */
  private showList(focus: boolean): void {
    if (!this.previewExpanded) return;
    this.previewExpanded = false;
    this.body.classList.remove('preview-expanded');
    this.preview.setExpanded(false);
    this.opts.onChange();
    // Re-selecting scrolls the row into view, which did nothing while the list was hidden.
    this.list.select(this.selectedName);
    if (focus) this.list.focus();
  }

  private applySplit(): void {
    this.left.style.flexBasis = `${this.split * 100}%`;
  }

  private startDrag(e: PointerEvent): void {
    if (e.button !== 0) return;
    e.preventDefault();
    this.divider.setPointerCapture(e.pointerId);
    this.divider.classList.add('dragging');
    const move = (ev: PointerEvent) => {
      const r = this.body.getBoundingClientRect();
      if (r.width <= 0) return;
      this.split = Math.min(MAX_SPLIT, Math.max(MIN_SPLIT, (ev.clientX - r.left) / r.width));
      this.applySplit();
    };
    const up = () => {
      this.divider.classList.remove('dragging');
      this.divider.removeEventListener('pointermove', move);
      this.divider.removeEventListener('pointerup', up);
      this.divider.removeEventListener('pointercancel', up);
    };
    this.divider.addEventListener('pointermove', move);
    this.divider.addEventListener('pointerup', up);
    this.divider.addEventListener('pointercancel', up);
  }

  private onKeyDown(e: KeyboardEvent): void {
    const action = lookup(this.opts.keymap(), e);
    if (action?.type === 'find' && this.preview.openFind()) {
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    // An open find bar takes Esc first and stops it there.
    if (
      this.previewExpanded &&
      e.key === 'Escape' &&
      !e.ctrlKey &&
      !e.altKey &&
      !e.shiftKey &&
      !e.metaKey &&
      !e.defaultPrevented &&
      !e.isComposing &&
      this.preview.el.contains(e.target as Node)
    ) {
      this.showList(true);
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    // The preview's editors run the same lookup on their own keys.
    if (this.preview.el.contains(e.target as Node)) return;
    if (action && !textFieldOwns(action) && this.opts.dispatch(action)) {
      e.preventDefault();
      e.stopPropagation();
    }
  }

  private listen(target: EventTarget, type: string, fn: (e: Event) => void): void {
    target.addEventListener(type, fn);
    this.listeners.push(() => target.removeEventListener(type, fn));
  }
}
