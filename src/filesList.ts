import './filesList.css';
import { attachContextMenu } from './contextMenu';
import type { MenuEntry } from './contextMenuModel';
import {
  DEFAULT_FILES_SORT,
  fileNameError,
  filterEntries,
  listKey,
  sortEntries,
  type FileEntry,
  type FilesSort,
} from './filesModel';
import { renderFileRow } from './fileRow';
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

export interface FilesListOptions {
  /** A click or a keyboard move put the cursor on an entry (the preview follows). */
  onSelect: (entry: FileEntry) => void;
  /** Double click or Enter: a folder opens, a file opens in the editor. */
  onActivate: (entry: FileEntry) => void;
  /** Backspace with no filter. */
  onUp: () => void;
  /**
   * The row's menu button was pressed; the caller opens the row's menu at the anchor.
   * `selection` is what the menu acts on: the selected entries when the row is one, else the row.
   */
  onMenu: (entry: FileEntry, selection: FileEntry[], anchor: HTMLElement) => void;
  /** A row's right-click menu. */
  rowMenu: (entry: FileEntry, selection: FileEntry[]) => MenuEntry[];
  /** The right-click menu of the empty area below the rows, for the current folder. */
  folderMenu: () => MenuEntry[];
  /** A row's body was dragged past the threshold; `entries` are the dragged selection. */
  onDragStart?: (entries: FileEntry[], e: PointerEvent) => void;
  /** Enter in a rename field with a new, valid name; resolves true when the rename went through. */
  onRename: (entry: FileEntry, newName: string) => Promise<boolean>;
}

/**
 * Sorted, filtered, keyboard-driven list of a folder's entries, with File Explorer's Ctrl and
 * Shift multi-selection (docs/design.md section 4.12).
 */
export class FilesList {
  readonly el: HTMLElement;
  private readonly filterBar: HTMLElement;
  private readonly filterText: HTMLElement;
  private readonly list: HTMLElement;
  private entries: FileEntry[] = [];
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
      const entry = row ? this.entries.find((x) => x.name === row.dataset.name) : undefined;
      if (!row || !entry) return { entries: this.opts.folderMenu() };
      // As in File Explorer, a right-click outside the selection selects just that row.
      if (!isMarked(this.sel, entry.name)) this.clicked(entry, {});
      return { entries: this.opts.rowMenu(entry, this.selectionFor(entry)), target: this.rowEl(entry) ?? row };
    });

    this.el.append(this.filterBar, this.list);
  }

  focus(): void {
    this.list.focus();
  }

  /** The folder changed: filter, selection, and entries clear; the caller sets them next. */
  setFolder(): void {
    this.filterValue = '';
    this.sel = EMPTY_SELECTION;
    this.entries = [];
    this.render();
  }

  /** Replaces the entries (a first listing or a watch refresh); the selection stays by name. */
  setEntries(entries: readonly FileEntry[]): void {
    this.entries = [...entries];
    this.sel = pruneSelection(
      this.sel,
      this.entries.map((e) => e.name),
    );
    this.render();
  }

  /** Reorders the rows; the selection and filter stay. */
  setSort(sort: FilesSort): void {
    this.sort = sort;
    this.render();
  }

  /** Selects one entry by name without firing `onSelect` (a restored selection); null clears it. */
  select(name: string | null): void {
    this.sel = single(name);
    this.render();
  }

  /** The cursor's entry, which the preview shows. */
  selected(): FileEntry | null {
    return this.entries.find((e) => e.name === this.sel.cursor) ?? null;
  }

  /** The selected entries that are visible, in list order. */
  selection(): FileEntry[] {
    return this.visible().filter((e) => isMarked(this.sel, e.name));
  }

  filter(): string {
    return this.filterValue;
  }

  /** Opens a name field on `entry`, or on the cursor's entry; F2 and the row menu's Rename. */
  startRename(entry: FileEntry | null = this.selected()): void {
    if (!entry || this.renaming !== null) return;
    this.sel = single(entry.name);
    this.paint();
    const label = this.rowEl(entry)?.querySelector<HTMLElement>('.file-row-name');
    if (!label) return;
    this.renaming = entry.name;
    label.replaceWith(this.renameField(entry));
  }

  /**
   * Enter renames; Escape or leaving the field cancels, as in the Git pane's branch rename, so a
   * stray click never renames something on disk.
   */
  private renameField(entry: FileEntry): HTMLInputElement {
    const from = entry.name;
    const input = document.createElement('input');
    input.className = 'file-rename-field';
    input.value = from;
    input.spellcheck = false;
    let done = false;
    const end = (renamed: string | null, focus: boolean): void => {
      this.renaming = null;
      if (renamed !== null) this.sel = single(renamed);
      this.paint();
      if (focus) this.focus();
      const now = renamed === null ? undefined : this.entries.find((e) => e.name === renamed);
      if (now) this.opts.onSelect(now);
    };
    input.addEventListener('input', () => {
      const to = input.value.trim();
      // A change of case alone names the same entry, so it is not a clash.
      const clash =
        to.toLowerCase() !== from.toLowerCase() && this.entries.some((e) => e.name.toLowerCase() === to.toLowerCase());
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
  private selectionFor(entry: FileEntry): FileEntry[] {
    return isMarked(this.sel, entry.name) ? this.selection() : [entry];
  }

  private visible(): FileEntry[] {
    return filterEntries(sortEntries(this.entries, this.sort), this.filterValue);
  }

  private visibleNames(): string[] {
    return this.visible().map((v) => v.name);
  }

  private rowEl(entry: FileEntry): HTMLElement | null {
    return this.list.querySelector<HTMLElement>(`.file-row[data-name="${CSS.escape(entry.name)}"]`);
  }

  private onKeyDown(e: KeyboardEvent): void {
    if (e.altKey || e.metaKey) return;
    if (e.key === 'F2' && !e.ctrlKey && !e.shiftKey) {
      e.preventDefault();
      e.stopPropagation();
      this.startRename();
      return;
    }
    if (e.ctrlKey) {
      if (!e.shiftKey && e.key.toLowerCase() === 'a') {
        e.preventDefault();
        e.stopPropagation();
        this.sel = selectAll(this.sel, this.visibleNames());
        this.render();
      }
      // Other chords belong to the pane's keymap handler, which runs as the event bubbles.
      return;
    }
    const names = this.visibleNames();
    const { state, effect } = listKey({ selected: this.sel.cursor, filter: this.filterValue }, e.key, names);
    const moved = state.selected !== this.sel.cursor;
    const filtered = state.filter !== this.filterValue;
    if (effect === 'none' && !moved && !filtered) return;
    e.preventDefault();
    if (filtered) {
      this.filterValue = state.filter;
      this.sel = pruneSelection(this.sel, this.visibleNames());
    }
    if (moved && state.selected !== null) {
      const extend = e.shiftKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown');
      this.sel = extend ? selectAt(this.sel, state.selected, { shift: true }, names) : single(state.selected);
    }
    this.render();
    const entry = this.selected();
    if (effect === 'preview' && entry) this.opts.onSelect(entry);
    else if (effect === 'open' && entry) this.opts.onActivate(entry);
    else if (effect === 'up') this.opts.onUp();
  }

  private clicked(entry: FileEntry, mods: SelectMods): void {
    this.sel = selectAt(this.sel, entry.name, mods, this.visibleNames());
    this.render();
    this.focus();
    this.opts.onSelect(entry);
  }

  private dragStarted(entry: FileEntry, e: PointerEvent): void {
    // Dragging a row outside the selection drags just that row, as File Explorer does.
    if (!isMarked(this.sel, entry.name)) this.clicked(entry, {});
    this.opts.onDragStart?.(this.selectionFor(entry), e);
  }

  private render(): void {
    if (this.renaming === null) this.paint();
  }

  private paint(): void {
    this.filterBar.hidden = this.filterValue === '';
    this.filterText.textContent = this.filterValue;
    const rows = this.visible().map((entry) =>
      renderFileRow(entry, {
        selected: isMarked(this.sel, entry.name),
        cursor: entry.name === this.sel.cursor,
        onSelect: (e) => this.clicked(entry, { shift: e.shiftKey, ctrl: e.ctrlKey }),
        onActivate: () => this.opts.onActivate(entry),
        onMenu: (anchor) => {
          if (!isMarked(this.sel, entry.name)) this.clicked(entry, {});
          this.opts.onMenu(entry, this.selectionFor(entry), this.rowEl(entry)?.querySelector<HTMLElement>('.file-row-menu') ?? anchor);
        },
        onDragStart: this.opts.onDragStart ? (e) => this.dragStarted(entry, e) : undefined,
      }),
    );
    this.list.replaceChildren(...rows);
    this.list.querySelector('.file-row.cursor')?.scrollIntoView({ block: 'nearest' });
  }
}
