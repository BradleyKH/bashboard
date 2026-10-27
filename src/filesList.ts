import './filesList.css';
import { filterEntries, listKey, sortEntries, type FileEntry } from './filesModel';
import { renderFileRow } from './fileRow';

export interface FilesListOptions {
  /** A click or a keyboard move selected an entry (the preview follows). */
  onSelect: (entry: FileEntry) => void;
  /** Double click or Enter: a folder opens, a file opens in the editor. */
  onActivate: (entry: FileEntry) => void;
  /** Backspace with no filter. */
  onUp: () => void;
  /** The row's menu button was pressed; the caller opens a `FileRowMenu` at the anchor. */
  onMenu: (entry: FileEntry, anchor: HTMLElement) => void;
}

/** Sorted, filtered, keyboard-driven list of a folder's entries (docs/design.md section 4.12). */
export class FilesList {
  readonly el: HTMLElement;
  private readonly filterBar: HTMLElement;
  private readonly filterText: HTMLElement;
  private readonly list: HTMLElement;
  private entries: FileEntry[] = [];
  private selectedName: string | null = null;
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
    this.list.addEventListener('keydown', (e) => this.onKeyDown(e));

    this.el.append(this.filterBar, this.list);
  }

  focus(): void {
    this.list.focus();
  }

  /** The folder changed: filter, selection, and entries clear; the caller sets them next. */
  setFolder(): void {
    this.filterValue = '';
    this.selectedName = null;
    this.entries = [];
    this.render();
  }

  /** Replaces the entries (a first listing or a watch refresh); the selection stays by name. */
  setEntries(entries: readonly FileEntry[]): void {
    this.entries = [...entries];
    this.render();
  }

  /** Selects by name without firing `onSelect` (a restored selection); null clears it. */
  select(name: string | null): void {
    this.selectedName = name;
    this.render();
  }

  selected(): FileEntry | null {
    return this.entries.find((e) => e.name === this.selectedName) ?? null;
  }

  filter(): string {
    return this.filterValue;
  }

  private visible(): FileEntry[] {
    return filterEntries(sortEntries(this.entries), this.filterValue);
  }

  private onKeyDown(e: KeyboardEvent): void {
    // Chords belong to the pane's keymap handler, which runs as the event bubbles.
    if (e.ctrlKey || e.altKey || e.metaKey) return;
    const names = this.visible().map((v) => v.name);
    const { state, effect } = listKey({ selected: this.selectedName, filter: this.filterValue }, e.key, names);
    const changed = state.selected !== this.selectedName || state.filter !== this.filterValue;
    if (effect === 'none' && !changed) return;
    e.preventDefault();
    this.selectedName = state.selected;
    this.filterValue = state.filter;
    this.render();
    const entry = this.selected();
    if (effect === 'preview' && entry) this.opts.onSelect(entry);
    else if (effect === 'open' && entry) this.opts.onActivate(entry);
    else if (effect === 'up') this.opts.onUp();
  }

  private clicked(entry: FileEntry): void {
    this.selectedName = entry.name;
    this.render();
    this.focus();
    this.opts.onSelect(entry);
  }

  private render(): void {
    this.filterBar.hidden = this.filterValue === '';
    this.filterText.textContent = this.filterValue;
    const rows = this.visible().map((entry) =>
      renderFileRow(entry, {
        selected: entry.name === this.selectedName,
        onSelect: () => this.clicked(entry),
        onActivate: () => this.opts.onActivate(entry),
        onMenu: (anchor) => this.opts.onMenu(entry, anchor),
      }),
    );
    this.list.replaceChildren(...rows);
    this.list.querySelector('.file-row.selected')?.scrollIntoView({ block: 'nearest' });
  }
}
