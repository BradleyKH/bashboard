import { selectionAfterRefresh } from './pickerSelection';

export interface PickerItem {
  label: string;
  detail?: string;
  value: string;
  /** Short note at the right of the row, such as a chord. */
  hint?: string;
  /** Group name shown at the right edge of the row. */
  category?: string;
}

export interface PickerCallbacks {
  /** Enter opens normally; Ctrl+Enter reports `collapsed`. */
  onOpen(value: string, opts: { collapsed: boolean }): void;
  /** Dismissed with Escape or an outside click; the caller refocuses the terminal. */
  onClose(): void;
}

/** Returns the rows to show, in order, for the raw input value. */
export type PickerMatcher = (items: PickerItem[], query: string) => PickerItem[];

const substringMatcher: PickerMatcher = (items, query) => {
  const q = query.trim().toLowerCase();
  return items.filter(
    (it) => it.label.toLowerCase().includes(q) || (it.detail ?? '').toLowerCase().includes(q),
  );
};

/** Filterable overlay for picking one item, such as a favorite (docs/design.md section 4.5). */
export class Picker {
  private backdrop: HTMLElement | null = null;
  private input!: HTMLInputElement;
  private list!: HTMLElement;
  private items: PickerItem[] = [];
  private shown: PickerItem[] = [];
  private selected = 0;

  private readonly matcher: PickerMatcher;

  constructor(
    private readonly callbacks: PickerCallbacks,
    opts: { matcher?: PickerMatcher } = {},
  ) {
    this.matcher = opts.matcher ?? substringMatcher;
  }

  isOpen(): boolean {
    return this.backdrop !== null;
  }

  open(items: PickerItem[], placeholder: string): void {
    if (this.backdrop) this.close();
    this.items = items;
    this.selected = 0;

    const backdrop = document.createElement('div');
    backdrop.className = 'picker-backdrop';
    backdrop.addEventListener('mousedown', (e) => {
      if (e.target === backdrop) {
        e.preventDefault();
        this.dismiss();
      }
    });

    const box = document.createElement('div');
    box.className = 'picker';

    this.input = document.createElement('input');
    this.input.type = 'text';
    this.input.className = 'picker-input';
    this.input.placeholder = placeholder;
    this.input.addEventListener('input', () => {
      this.selected = 0;
      this.renderList();
    });
    this.input.addEventListener('keydown', (e) => this.onKey(e));

    this.list = document.createElement('div');
    this.list.className = 'picker-list';

    box.append(this.input, this.list);
    backdrop.append(box);
    document.body.append(backdrop);
    this.backdrop = backdrop;
    this.renderList();
    this.input.focus();
  }

  /** Swaps the items under an open picker, keeping the query, the selected item (by value), and the scroll position. */
  setItems(items: PickerItem[]): void {
    if (!this.backdrop) return;
    const prevValue = this.shown[this.selected]?.value;
    const scrollTop = this.list.scrollTop;
    this.items = items;
    this.shown = this.matcher(this.items, this.input.value);
    this.selected = selectionAfterRefresh(
      prevValue,
      this.selected,
      this.shown.map((it) => it.value),
    );
    this.renderList(false);
    this.list.scrollTop = scrollTop;
    this.list.querySelector('.selected')?.scrollIntoView({ block: 'nearest' });
  }

  close(): void {
    this.backdrop?.remove();
    this.backdrop = null;
  }

  private dismiss(): void {
    this.close();
    this.callbacks.onClose();
  }

  private choose(index: number, collapsed: boolean): void {
    const item = this.shown[index];
    if (!item) return;
    // The opened terminal takes focus, so no onClose refocus.
    this.close();
    this.callbacks.onOpen(item.value, { collapsed });
  }

  private onKey(e: KeyboardEvent): void {
    // Keep keys away from any window-level shortcut handling.
    e.stopPropagation();
    if (e.key === 'Escape') {
      e.preventDefault();
      this.dismiss();
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (this.shown.length === 0) return;
      const step = e.key === 'ArrowDown' ? 1 : -1;
      this.selected = (this.selected + step + this.shown.length) % this.shown.length;
      this.renderList();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      this.choose(this.selected, e.ctrlKey);
    }
  }

  private renderList(rematch = true): void {
    if (rematch) this.shown = this.matcher(this.items, this.input.value);
    if (this.shown.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'dashboard-empty';
      empty.textContent = this.items.length === 0 ? 'Nothing to pick' : 'No matches';
      this.list.replaceChildren(empty);
      return;
    }
    this.list.replaceChildren(
      ...this.shown.map((it, i) => {
        const row = document.createElement('div');
        row.className = 'picker-row';
        row.classList.toggle('selected', i === this.selected);
        if (it.detail) row.title = it.detail;
        const label = document.createElement('span');
        label.className = 'picker-label';
        label.textContent = it.label;
        row.append(label);
        if (it.detail) {
          const detail = document.createElement('span');
          detail.className = 'picker-detail';
          detail.textContent = it.detail;
          row.append(detail);
        }
        if (it.hint) {
          const hint = document.createElement('span');
          hint.className = 'picker-hint';
          hint.textContent = it.hint;
          row.append(hint);
        }
        if (it.category) {
          const category = document.createElement('span');
          category.className = 'picker-category';
          category.textContent = it.category;
          row.append(category);
        }
        row.addEventListener('mousedown', (e) => e.preventDefault());
        row.addEventListener('click', (e) => this.choose(i, e.ctrlKey));
        return row;
      }),
    );
    this.list.querySelector('.selected')?.scrollIntoView({ block: 'nearest' });
  }
}
