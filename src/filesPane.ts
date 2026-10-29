import './filesPane.css';
import { openInEditor } from './editors';
import { samePath } from './favorites';
import { FilePreview } from './filePreview';
import { FileRowMenu, type FileRowMenuHandlers, type MoveTarget } from './fileRowMenu';
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
  keymap: () => Keymap;
  dispatch: (action: Action) => boolean;
  onFocus: () => void;
  /** The folder, selection, or root changed (title and saved state follow). */
  onChange: () => void;
  onOpenTerminalHere: (folder: string) => void;
  /** Text from `insertPathText`, for the tab's last focused terminal. */
  onInsertPath: (text: string) => void;
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
  private readonly menu = new FileRowMenu();
  private settings: Settings;
  private rootPath: string;
  private currentPath: string;
  private selectedName: string | null;
  private selectedModified: number | null = null;
  private history: History = EMPTY_HISTORY;
  private entries: FileEntry[] = [];
  private split = 0.4;
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
      zoom: opts.settings.textZoom.filesList,
      onZoom: (zoom) => this.left.style.setProperty('--files-zoom', String(zoom)),
      onTogglePin: () => this.togglePin(),
    });
    this.list = new FilesList({
      onSelect: (entry) => this.selectEntry(entry),
      onActivate: (entry) => this.activate(entry),
      onUp: () => this.goUp(),
      onMenu: (entry, anchor) => this.openMenu(entry, anchor),
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
        void this.showFolder(t.folder, t.select);
      },
      onOpenInEditor: (path) => this.openInEditor(path),
    });

    this.body.append(this.left, this.divider, this.right);
    this.host.appendChild(this.body);
    this.applySplit();

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

  /** The `files` saved-pane fields; `selected` is the selected entry's name within `folder`. */
  saved(): { folder: string; selected: string | null; root: string } {
    return { folder: this.currentPath, selected: this.selectedName, root: this.rootPath };
  }

  /**
   * Shows a folder, recording it in history. `select` is an entry name in that folder, or an
   * absolute path whose parent is the folder; anything else selects nothing.
   */
  async showFolder(folder: string, select?: string | null): Promise<void> {
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
    if (this.notice.hidden) this.list.focus();
    else this.body.focus();
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
    return {
      width,
      height,
      // Everything outside the list's rows: borders, title strip, breadcrumb, filter.
      padX: Math.max(0, this.host.offsetWidth - this.body.clientWidth) + 1,
      padY: Math.max(0, this.host.offsetHeight - (rows?.clientHeight ?? this.body.clientHeight)) + 1,
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.generation++;
    this.unwatch();
    this.menu.close();
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
    this.unwatch();
    this.menu.close();
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

  private togglePin(): void {
    if (this.isPinned(this.currentPath) && this.opts.onUnpin) this.opts.onUnpin(this.currentPath);
    else this.opts.onPin(this.currentPath, true);
  }

  private openInEditor(path: string): void {
    if (this.opts.onOpenInEditor) this.opts.onOpenInEditor(path);
    else void openInEditor(path);
  }

  private moveTargets(entry: FileEntry): MoveTarget[] {
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
      if (e.isDir && e.name !== entry.name) add(childPath(this.currentPath, e.name), `${e.name}/`);
    }
    return out;
  }

  private openMenu(entry: FileEntry, anchor: HTMLElement): void {
    const pathOf = (e: FileEntry) => childPath(this.currentPath, e.name);
    const handlers: FileRowMenuHandlers = {
      openTerminalHere: (e) => this.opts.onOpenTerminalHere(pathOf(e)),
      openInEditor: (e) => this.openInEditor(pathOf(e)),
      copyPath: (e) => {
        navigator.clipboard.writeText(pathOf(e)).catch((err) => showToast(`Could not copy: ${errorText(err)}`));
      },
      insertPath: (e) => this.opts.onInsertPath(insertPathText(this.rootPath, pathOf(e))),
      moveTo: (e, toDir) => void this.move(e, toDir),
      pin: (e) => this.opts.onPin(pathOf(e), e.isDir),
    };
    this.menu.open(anchor, entry, handlers, this.moveTargets(entry));
  }

  private async move(entry: FileEntry, toDir: string): Promise<void> {
    const wasSelected = entry.name === this.selectedName;
    if (wasSelected) await this.flush();
    try {
      await fsMove(childPath(this.currentPath, entry.name), toDir);
    } catch (e) {
      showToast(`Could not move ${entry.name}: ${errorText(e)}`);
      return;
    }
    // The folder watch re-lists too; this makes the row disappear without waiting for it.
    await this.relist(this.generation);
  }

  private showNotice(folder: string, err: unknown): void {
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
