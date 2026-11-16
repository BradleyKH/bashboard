import './filesList.css';
import { attachContextMenu } from './contextMenu';
import type { MenuEntry } from './contextMenuModel';
import { DEFAULT_FILES_SORT, fileNameError, listKey, type FileEntry, type FilesSort } from './filesModel';
import {
  childKey,
  collapse,
  isWithin,
  listedKeys,
  parentKey,
  pruneOpen,
  treeArrow,
  visibleItems,
  type FileItem,
  type FilesView,
  type TreeState,
} from './filesTreeModel';
import { renderFileRow } from './fileRow';
import { loadingNote } from './loadingNote';
import { nameKey } from './pathCompare';
import {
  EMPTY_SELECTION,
  isMarked,
  pruneSelection,
  selectAll,
  selectAt,
  single,
  type FileSelection,
  type SelectMods,
} from './fileSelection';
import { platformOs, primaryHeld, primaryOnly } from './platform';

export interface FilesListOptions {
  /** A click or a keyboard move put the cursor on an entry (the preview follows). */
  onSelect: (entry: FileItem) => void;
  /** Double click or Enter: a folder opens (or toggles in the tree), a file opens in the editor. */
  onActivate: (entry: FileItem) => void;
  /** A tree folder's chevron, Right, or Left asked to expand (`open`) or collapse it. */
  onToggle: (entry: FileItem, open: boolean) => void;
  /** Backspace with no filter. */
  onUp: () => void;
  /**
   * The row's menu button was pressed; the caller opens the row's menu at the anchor.
   * `selection` is what the menu acts on: the selected entries when the row is one, else the row.
   */
  onMenu: (entry: FileItem, selection: FileItem[], anchor: HTMLElement) => void;
  /** A row's right-click menu. */
  rowMenu: (entry: FileItem, selection: FileItem[]) => MenuEntry[];
  /** The right-click menu of the empty area below the rows, for the current folder. */
  folderMenu: () => MenuEntry[];
  /** A row's body was dragged past the threshold; `entries` are the dragged selection. */
  onDragStart?: (entries: FileItem[], e: PointerEvent) => void;
  /** Enter in a rename field with a new, valid name; resolves true when the rename went through. */
  onRename: (entry: FileItem, newName: string) => Promise<boolean>;
  /** Ctrl+X and Ctrl+C (Cmd on macOS) on the selection. */
  onCut: (entries: FileItem[]) => void;
  onCopy: (entries: FileItem[]) => void;
  /** Ctrl+V: paste into the folder holding the cursor's row, or the folder shown. */
  onPaste: () => void;
  /** Delete (Cmd+Backspace on macOS) on the selection. */
  onDelete: (entries: FileItem[]) => void;
  /** Whether a row was cut and not yet pasted, which draws it dimmed. */
  isCut: (entry: FileItem) => boolean;
}

/**
 * Sorted, filtered, keyboard-driven list of a folder's entries, or of the tree below it, with File
 * Explorer's Ctrl and Shift multi-selection (docs/design/files.md section 4.12). Rows go by key,
 * their path below the folder shown (`filesTreeModel.ts`).
 */
export class FilesList {
  readonly el: HTMLElement;
  private readonly filterBar: HTMLElement;
  private readonly filterText: HTMLElement;
  private readonly list: HTMLElement;
  /** Each listed folder's entries by key, '' being the folder shown. */
  private children = new Map<string, readonly FileEntry[]>();
  private open = new Set<string>();
  private view: FilesView = 'folder';
  private sel: FileSelection = EMPTY_SELECTION;
  private filterValue = '';
  private sort: FilesSort = DEFAULT_FILES_SORT;
  /** The entry whose name field is open; renders wait for it, as they would drop what was typed. */
  private renaming: string | null = null;

  constructor(private readonly opts: FilesListOptions) {
    this.el = document.createElement('div');
    this.el.className = 'files-list';

    this.filterBar = document.createElement('div');
    this.filterBar.className = 'files-filter';
    this.filterBar.hidden = true;
    this.filterText = document.createElement('span');
    this.filterText.className = 'files-filter-text';
    const clear = document.createElement('button');
    clear.type = 'button';
    clear.className = 'files-filter-clear';
    clear.textContent = '×';
    clear.title = 'Clear filter';
    clear.addEventListener('click', () => {
      this.filterValue = '';
      this.render();
      this.focus();
    });
    this.filterBar.append(this.filterText, clear);

    this.list = document.createElement('div');
    this.list.className = 'files-list-rows';
    this.list.tabIndex = 0;
    this.list.setAttribute('role', 'listbox');
    this.list.setAttribute('aria-multiselectable', 'true');
    this.list.addEventListener('keydown', (e) => this.onKeyDown(e));
    // The list, not a row, holds focus, so the Menu key and Shift+F10 act on the cursor's row.
    attachContextMenu(this.list, (e, keyboard) => {
      const row = keyboard
        ? this.list.querySelector<HTMLElement>('.file-row.cursor')
        : e.target instanceof Element
          ? e.target.closest<HTMLElement>('.file-row')
          : null;
      const entry = row?.dataset.key === undefined ? null : this.item(row.dataset.key);
      if (!row || !entry) return { entries: this.opts.folderMenu() };
      // As in File Explorer, a right-click outside the selection selects just that row.
      if (!isMarked(this.sel, entry.key)) this.clicked(entry, {});
      return { entries: this.opts.rowMenu(entry, this.selectionFor(entry)), target: this.rowEl(entry) ?? row };
    });

    this.el.append(this.filterBar, this.list);
  }

  focus(): void {
    this.list.focus();
  }

  /** The folder changed: filter, selection, entries, and expanded folders clear; the caller sets them next. */
  setFolder(): void {
    this.filterValue = '';
    this.sel = EMPTY_SELECTION;
    this.children = new Map();
    this.open = new Set();
    this.render();
  }

  /** Replaces the folder shown's entries (a first listing or a watch refresh); the selection stays by key. */
  setEntries(entries: readonly FileEntry[]): void {
    this.setChildren('', entries);
  }

  /**
   * Replaces one listed folder's entries. Expanded folders that vanished close, and the selection
   * keeps what still lists.
   */
  setChildren(key: string, entries: readonly FileEntry[]): void {
    this.children.set(key, [...entries]);
    this.open = pruneOpen(this.state());
    for (const k of [...this.children.keys()]) if (k !== '' && !this.open.has(k) && k !== key) this.children.delete(k);
    this.sel = pruneSelection(this.sel, listedKeys(this.state(), this.view));
    this.render();
  }

  /** Expands a folder whose entries `setChildren` has given. */
  expand(key: string): void {
    if (!this.children.has(key)) return;
    this.open = pruneOpen({ children: this.children, open: new Set([...this.open, key]) });
    this.render();
  }

  /**
   * Collapses a folder and those inside it, forgetting their entries; a cursor inside moves to
   * the folder, which `onSelect` reports. Returns the folder keys that closed.
   */
  collapse(key: string): string[] {
    const closed = [...this.open].filter((k) => isWithin(k, key));
    this.open = collapse(this.open, key);
    for (const k of [...this.children.keys()]) if (k !== '' && isWithin(k, key)) this.children.delete(k);
    const cursorInside = this.sel.cursor !== null && this.sel.cursor !== key && isWithin(this.sel.cursor, key);
    if (cursorInside) this.sel = single(key);
    else this.sel = pruneSelection(this.sel, listedKeys(this.state(), this.view));
    this.render();
    const folder = this.item(key);
    if (cursorInside && folder) this.opts.onSelect(folder);
    return closed;
  }

  /** The expanded folders, outermost first. */
  openKeys(): string[] {
    return [...this.open].sort((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b));
  }

  /** Whether a folder's entries are listed; '' is the folder shown. */
  isListed(key: string): boolean {
    return this.children.has(key);
  }

  /** A listed folder's entries, or undefined when it is not listed. */
  childrenOf(key: string): readonly FileEntry[] | undefined {
    return this.children.get(key);
  }

  /** The listed row with this key, whether or not the filter shows it. */
  item(key: string): FileItem | null {
    const folder = parentKey(key);
    const name = folder === '' ? key : key.slice(folder.length + 1);
    const entry = this.children.get(folder)?.find((e) => e.name === name);
    if (!entry) return null;
    if (folder !== '' && (this.view === 'folder' || !this.open.has(folder))) return null;
    const depth = key.split('/').length - 1;
    return { ...entry, key, depth, open: this.view === 'tree' && entry.isDir && this.open.has(key) && this.children.has(key) };
  }

  /** Switches between the folder's entries and the tree; the caller lists what the view needs. */
  setView(view: FilesView): void {
    this.view = view;
    if (view === 'folder') {
      this.open = new Set();
      for (const k of [...this.children.keys()]) if (k !== '') this.children.delete(k);
    }
    this.sel = pruneSelection(this.sel, listedKeys(this.state(), this.view));
    this.render();
  }

  /** Reorders the rows; the selection and filter stay. */
  setSort(sort: FilesSort): void {
    this.sort = sort;
    this.render();
  }

  /** Redraws the rows, keeping the selection; the cut marks changed. */
  repaint(): void {
    this.render();
  }

  /**
   * Selects the keyed entries that are listed, the first one as the cursor, without firing
   * `onSelect`; what a paste created.
   */
  selectKeys(keys: readonly string[]): void {
    const listed = this.visibleKeys().filter((k) => keys.includes(k));
    if (listed.length === 0) return;
    this.sel = { cursor: listed[0], anchor: listed[0], marked: listed };
    this.render();
  }

  /** Selects one entry by key without firing `onSelect` (a restored selection); null clears it. */
  select(key: string | null): void {
    this.sel = single(key);
    this.render();
  }

  /** The cursor's entry, which the preview shows. */
  selected(): FileItem | null {
    return this.sel.cursor === null ? null : this.item(this.sel.cursor);
  }

  /** The selected entries that are visible, in list order. */
  selection(): FileItem[] {
    return this.visible().filter((e) => isMarked(this.sel, e.key));
  }

  filter(): string {
    return this.filterValue;
  }

  /** Opens a name field on `entry`, or on the cursor's entry; F2 and the row menu's Rename. */
  startRename(entry: FileItem | null = this.selected()): void {
    if (!entry || this.renaming !== null) return;
    this.sel = single(entry.key);
    this.paint();
    const label = this.rowEl(entry)?.querySelector<HTMLElement>('.file-row-name');
    if (!label) return;
    this.renaming = entry.key;
    label.replaceWith(this.renameField(entry));
  }

  /**
   * Enter renames; Escape or leaving the field cancels, as in the Git pane's branch rename, so a
   * stray click never renames something on disk.
   */
  private renameField(entry: FileItem): HTMLInputElement {
    const from = entry.name;
    const folder = parentKey(entry.key);
    const siblings = this.children.get(folder) ?? [];
    const input = document.createElement('input');
    input.className = 'file-rename-field';
    input.value = from;
    input.spellcheck = false;
    let done = false;
    const end = (renamed: string | null, focus: boolean): void => {
      this.renaming = null;
      const key = renamed === null ? null : childKey(folder, renamed);
      if (key !== null) this.sel = single(key);
      this.paint();
      if (focus) this.focus();
      const now = key === null ? null : this.item(key);
      if (now) this.opts.onSelect(now);
    };
    input.addEventListener('input', () => {
      const to = input.value.trim();
      // Where the OS folds case, a change of case alone names the same entry, so it is not a clash.
      const clash = nameKey(to) !== nameKey(from) && siblings.some((e) => nameKey(e.name) === nameKey(to));
      const err = to === from ? null : (fileNameError(to) ?? (clash ? `${to} already exists` : null));
      input.classList.toggle('invalid', err !== null);
      input.title = err ?? '';
    });
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Escape') {
        e.preventDefault();
        done = true;
        end(null, true);
      } else if (e.key === 'Enter') {
        e.preventDefault();
        const to = input.value.trim();
        if (to === from) {
          done = true;
          end(null, true);
          return;
        }
        if (input.classList.contains('invalid') || to === '') return;
        done = true;
        input.readOnly = true;
        void this.opts.onRename(entry, to).then((ok) => end(ok ? to : null, true));
      }
    });
    input.addEventListener('blur', () => {
      if (done) return;
      done = true;
      end(null, false);
    });
    // The row's own handlers select, open, and drag; inside the field these place the caret.
    for (const type of ['click', 'dblclick', 'pointerdown', 'mousedown']) {
      input.addEventListener(type, (e) => e.stopPropagation());
    }
    queueMicrotask(() => {
      input.focus();
      // As in File Explorer, a file's name is selected up to its extension.
      const dot = entry.isDir ? -1 : from.lastIndexOf('.');
      input.setSelectionRange(0, dot > 0 ? dot : from.length);
    });
    return input;
  }

  /** What an action on `entry` covers: the whole selection when the entry is in it. */
  private selectionFor(entry: FileItem): FileItem[] {
    return isMarked(this.sel, entry.key) ? this.selection() : [entry];
  }

  private state(): TreeState {
    return { children: this.children, open: this.open };
  }

  private visible(): FileItem[] {
    return visibleItems(this.state(), this.view, this.sort, this.filterValue);
  }

  private visibleKeys(): string[] {
    return this.visible().map((v) => v.key);
  }

  private rowEl(entry: FileItem): HTMLElement | null {
    return this.list.querySelector<HTMLElement>(`.file-row[data-key="${CSS.escape(entry.key)}"]`);
  }

  private onKeyDown(e: KeyboardEvent): void {
    if (e.altKey) return;
    if (e.key === 'F2' && !e.ctrlKey && !e.metaKey && !e.shiftKey) {
      e.preventDefault();
      e.stopPropagation();
      this.startRename();
      return;
    }
    // Finder's Move to Trash is Cmd+Backspace; a Mac keyboard's Delete key sends Backspace.
    const deleteKey =
      platformOs() === 'macos'
        ? e.key === 'Backspace' && primaryOnly(e) && !e.shiftKey
        : e.key === 'Delete' && !e.ctrlKey && !e.metaKey && !e.shiftKey;
    if (deleteKey) {
      e.preventDefault();
      e.stopPropagation();
      const sel = this.selection();
      if (sel.length > 0) this.opts.onDelete(sel);
      return;
    }
    if (e.ctrlKey || e.metaKey) {
      const key = primaryOnly(e) && !e.shiftKey ? e.key.toLowerCase() : '';
      if (key === 'a') {
        e.preventDefault();
        e.stopPropagation();
        this.sel = selectAll(this.sel, this.visibleKeys());
        this.render();
      } else if (key === 'x' || key === 'c' || key === 'v') {
        e.preventDefault();
        e.stopPropagation();
        const sel = this.selection();
        if (key === 'v') this.opts.onPaste();
        else if (sel.length > 0) (key === 'x' ? this.opts.onCut : this.opts.onCopy)(sel);
      }
      // Other chords belong to the pane's keymap handler, which runs as the event bubbles.
      return;
    }
    if (this.view === 'tree' && (e.key === 'ArrowLeft' || e.key === 'ArrowRight') && !e.shiftKey) {
      const items = this.visible();
      const move = treeArrow(items, this.sel.cursor, e.key);
      if (move === null) return;
      e.preventDefault();
      const item = items.find((i) => i.key === move.key);
      if (!item) return;
      if (move.kind === 'cursor') {
        this.sel = single(item.key);
        this.render();
        this.opts.onSelect(item);
      } else this.opts.onToggle(item, move.kind === 'expand');
      return;
    }
    const keys = this.visibleKeys();
    const { state, effect } = listKey({ selected: this.sel.cursor, filter: this.filterValue }, e.key, keys);
    const moved = state.selected !== this.sel.cursor;
    const filtered = state.filter !== this.filterValue;
    if (effect === 'none' && !moved && !filtered) return;
    e.preventDefault();
    if (filtered) {
      this.filterValue = state.filter;
      this.sel = pruneSelection(this.sel, this.visibleKeys());
    }
    if (moved && state.selected !== null) {
      const extend = e.shiftKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown');
      this.sel = extend ? selectAt(this.sel, state.selected, { shift: true }, keys) : single(state.selected);
    }
    this.render();
    const entry = this.selected();
    if (effect === 'preview' && entry) this.opts.onSelect(entry);
    else if (effect === 'open' && entry) this.opts.onActivate(entry);
    else if (effect === 'up') this.opts.onUp();
  }

  private clicked(entry: FileItem, mods: SelectMods): void {
    this.sel = selectAt(this.sel, entry.key, mods, this.visibleKeys());
    this.render();
    this.focus();
    this.opts.onSelect(entry);
  }

  private dragStarted(entry: FileItem, e: PointerEvent): void {
    // Dragging a row outside the selection drags just that row, as File Explorer does.
    if (!isMarked(this.sel, entry.key)) this.clicked(entry, {});
    this.opts.onDragStart?.(this.selectionFor(entry), e);
  }

  private render(): void {
    if (this.renaming === null) this.paint();
  }

  private note(text: string): HTMLElement {
    const el = document.createElement('div');
    el.className = 'files-list-note';
    el.textContent = text;
    return el;
  }

  private paint(): void {
    this.filterBar.hidden = this.filterValue === '';
    this.filterText.textContent = this.filterValue;
    const rows = this.visible().map((entry) =>
      renderFileRow(entry, {
        tree: this.view === 'tree',
        selected: isMarked(this.sel, entry.key),
        cursor: entry.key === this.sel.cursor,
        cut: this.opts.isCut(entry),
        onSelect: (e) => this.clicked(entry, { shift: e.shiftKey, ctrl: primaryHeld(e) }),
        onActivate: () => this.opts.onActivate(entry),
        onToggle: () => this.opts.onToggle(entry, !entry.open),
        onMenu: (anchor) => {
          if (!isMarked(this.sel, entry.key)) this.clicked(entry, {});
          this.opts.onMenu(entry, this.selectionFor(entry), this.rowEl(entry)?.querySelector<HTMLElement>('.file-row-menu') ?? anchor);
        },
        onDragStart: this.opts.onDragStart ? (e) => this.dragStarted(entry, e) : undefined,
      }),
    );
    if (rows.length > 0) this.list.replaceChildren(...rows);
    else if (!this.children.has('')) this.list.replaceChildren(loadingNote('Loading...', { delayed: true, className: 'files-list-note' }));
    else if (this.filterValue === '') this.list.replaceChildren(this.note('This folder is empty.'));
    else this.list.replaceChildren();
    this.list.querySelector('.file-row.cursor')?.scrollIntoView({ block: 'nearest' });
  }
}
