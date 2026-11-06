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

/**
 * A button beside the input that adds to the list (docs/design/dashboard.md section 4.6). `run`
 * acts at once; `name` turns the input into a name field, and Enter passes the name to `submit`.
 */
export type PickerAction =
  | { kind: 'run'; label: string; title: string; enabled(): boolean; run(): void }
  | {
      kind: 'name';
      label: string;
      title: string;
      placeholder: string;
      /** Whether saving `name` replaces an existing item, so the row can say so before Enter. */
      exists(name: string): boolean;
      submit(name: string): void;
    };

/** Returns the rows to show, in order, for the raw input value. */
export type PickerMatcher = (items: PickerItem[], query: string) => PickerItem[];

const substringMatcher: PickerMatcher = (items, query) => {
  const q = query.trim().toLowerCase();
  return items.filter(
    (it) => it.label.toLowerCase().includes(q) || (it.detail ?? '').toLowerCase().includes(q),
  );
};

/**
 * Filterable overlay for picking one item, such as a favorite (docs/design/keys.md section 4.5).
 */
export class Picker {
  private backdrop: HTMLElement | null = null;
  private input!: HTMLInputElement;
  private list!: HTMLElement;
  private actionButton: HTMLButtonElement | null = null;
  /** While naming, the filter text to restore when naming is cancelled; null while filtering. */
  private naming: { query: string; placeholder: string } | null = null;
  private items: PickerItem[] = [];
  private shown: PickerItem[] = [];
  private selected = 0;
  /** The button an anchored picker drops from, which takes focus back on dismiss if it had it. */
  private returnFocus: HTMLElement | null = null;

  private readonly matcher: PickerMatcher;
  private readonly action: PickerAction | null;

  constructor(
    private readonly callbacks: PickerCallbacks,
    opts: { matcher?: PickerMatcher; action?: PickerAction } = {},
  ) {
    this.matcher = opts.matcher ?? substringMatcher;
    this.action = opts.action ?? null;
  }

  isOpen(): boolean {
    return this.backdrop !== null;
  }

  /**
   * Centered over the window, or with `anchor` as a dropdown under that element (the dashboard's
   * top bar buttons).
   */
  open(items: PickerItem[], placeholder: string, anchor?: HTMLElement): void {
    if (this.backdrop) this.close();
    this.items = items;
    this.selected = 0;
    this.naming = null;
    this.returnFocus = anchor && document.activeElement === anchor ? anchor : null;

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

    this.actionButton = this.action ? this.buildActionButton(this.action) : null;
    if (this.actionButton) {
      const head = document.createElement('div');
      head.className = 'picker-head';
      head.append(this.input, this.actionButton);
      box.append(head, this.list);
    } else {
      box.append(this.input, this.list);
    }
    backdrop.append(box);
    document.body.append(backdrop);
    this.backdrop = backdrop;
    if (anchor) this.dropFrom(backdrop, box, anchor);
    this.syncAction();
    this.renderList();
    this.input.focus();
  }

  private buildActionButton(action: PickerAction): HTMLButtonElement {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'picker-action';
    btn.textContent = action.label;
    btn.title = action.title;
    // Keeps focus in the input for a mouse click; Tab still reaches the button.
    btn.addEventListener('mousedown', (e) => e.preventDefault());
    btn.addEventListener('click', () => {
      if (action.kind === 'run') {
        action.run();
        this.syncAction();
      } else {
        this.startNaming(action);
      }
      this.input.focus();
    });
    btn.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Escape') {
        e.preventDefault();
        this.dismiss();
      } else if (e.key === 'Tab') {
        // The button is the box's last stop, so Tab wraps to the input rather than leaving the box.
        e.preventDefault();
        this.input.focus();
      }
    });
    return btn;
  }

  /** Disabled while naming, and for `run` while there is nothing to add. */
  private syncAction(): void {
    const btn = this.actionButton;
    if (!btn || !this.action) return;
    btn.disabled = this.naming !== null || (this.action.kind === 'run' && !this.action.enabled());
  }

  private startNaming(action: Extract<PickerAction, { kind: 'name' }>): void {
    this.naming = { query: this.input.value, placeholder: this.input.placeholder };
    this.input.placeholder = action.placeholder;
    this.input.select();
    this.syncAction();
    this.renderList();
  }

  private stopNaming(query: string): void {
    if (!this.naming) return;
    this.input.placeholder = this.naming.placeholder;
    this.input.value = query;
    this.naming = null;
    this.selected = 0;
    this.syncAction();
    this.renderList();
  }

  /** Places the box under `anchor`, kept inside the window. */
  private dropFrom(backdrop: HTMLElement, box: HTMLElement, anchor: HTMLElement): void {
    backdrop.classList.add('anchored');
    const rect = anchor.getBoundingClientRect();
    const margin = 8;
    const width = Math.min(360, window.innerWidth - 2 * margin);
    const top = rect.bottom + 4;
    box.style.width = `${width}px`;
    box.style.left = `${Math.max(margin, Math.min(rect.left, window.innerWidth - width - margin))}px`;
    box.style.top = `${top}px`;
    box.style.maxHeight = `${Math.max(120, window.innerHeight - top - margin)}px`;
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
    this.syncAction();
    if (this.naming) return;
    this.renderList(false);
    this.list.scrollTop = scrollTop;
    this.list.querySelector('.selected')?.scrollIntoView({ block: 'nearest' });
  }

  close(): void {
    this.backdrop?.remove();
    this.backdrop = null;
    this.returnFocus = null;
    this.actionButton = null;
    this.naming = null;
  }

  private dismiss(): void {
    const back = this.returnFocus;
    this.close();
    // A peek that ended while the picker was open has taken the button off screen.
    if (back?.isConnected && back.getClientRects().length > 0) back.focus();
    else this.callbacks.onClose();
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
    if (this.naming) {
      this.onNamingKey(e);
      return;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      this.dismiss();
    } else if (e.key === 'Tab' && this.actionButton) {
      // The input and the button are the box's only stops; Tab never reaches the page behind it.
      e.preventDefault();
      if (!this.actionButton.disabled) this.actionButton.focus();
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

  private onNamingKey(e: KeyboardEvent): void {
    if (e.key === 'Escape') {
      e.preventDefault();
      this.stopNaming(this.naming?.query ?? '');
    } else if (e.key === 'Enter') {
      e.preventDefault();
      this.submitName();
    } else if (e.key === 'Tab') {
      e.preventDefault();
    }
  }

  private submitName(): void {
    const name = this.input.value.trim();
    if (!name || this.action?.kind !== 'name') return;
    this.action.submit(name);
    // The caller's setItems has listed the saved item; filtering to its name selects it.
    this.stopNaming(name);
  }

  /** While naming, one row previews what Enter does, so replacing an item is never a surprise. */
  private renderNamingRow(): void {
    const name = this.input.value.trim();
    const action = this.action;
    if (!name || action?.kind !== 'name') {
      const empty = document.createElement('div');
      empty.className = 'dashboard-empty';
      empty.textContent = 'Type a name and press Enter to save, or Escape to go back';
      this.list.replaceChildren(empty);
      return;
    }
    const replaces = action.exists(name);
    const row = document.createElement('div');
    row.className = 'picker-row selected';
    row.classList.toggle('picker-replace', replaces);
    const label = document.createElement('span');
    label.className = 'picker-label';
    label.textContent = replaces ? `Replace “${name}”` : `Save as “${name}”`;
    const hint = document.createElement('span');
    hint.className = 'picker-hint';
    hint.textContent = 'Enter';
    row.append(label, hint);
    row.addEventListener('mousedown', (e) => e.preventDefault());
    row.addEventListener('click', () => this.submitName());
    this.list.replaceChildren(row);
  }

  private renderList(rematch = true): void {
    if (this.naming) {
      this.renderNamingRow();
      return;
    }
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
