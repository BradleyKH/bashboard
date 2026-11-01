import './filesList.css';
import { attachContextMenu } from './contextMenu';
import type { MenuEntry } from './contextMenuModel';
import { filterEntries, listKey, sortEntries, type FileEntry } from './filesModel';
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

  /** What an action on `entry` covers: the whole selection when the entry is in it. */
  private selectionFor(entry: FileEntry): FileEntry[] {
    return isMarked(this.sel, entry.name) ? this.selection() : [entry];
  }

  private visible(): FileEntry[] {
    return filterEntries(sortEntries(this.entries), this.filterValue);
  }

  private visibleNames(): string[] {
    return this.visible().map((v) => v.name);
  }

  private rowEl(entry: FileEntry): HTMLElement | null {
    return this.list.querySelector<HTMLElement>(`.file-row[data-name="${CSS.escape(entry.name)}"]`);
  }

  private onKeyDown(e: KeyboardEvent): void {
    if (e.altKey || e.metaKey) return;
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
