export interface PickerItem {
  label: string;
  detail?: string;
  value: string;
}

export interface PickerCallbacks {
  /** Enter opens normally; Ctrl+Enter reports `collapsed`. */
  onOpen(value: string, opts: { collapsed: boolean }): void;
  /** Dismissed with Escape or an outside click; the caller refocuses the terminal. */
  onClose(): void;
}

/** Filterable overlay for picking one item, such as a favorite (docs/design.md section 4.5). */
export class Picker {
  private backdrop: HTMLElement | null = null;
  private input!: HTMLInputElement;
  private list!: HTMLElement;
  private items: PickerItem[] = [];
  private shown: PickerItem[] = [];
  private selected = 0;

  constructor(private readonly callbacks: PickerCallbacks) {}

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

  private renderList(): void {
    const q = this.input.value.trim().toLowerCase();
    this.shown = this.items.filter(
      (it) => it.label.toLowerCase().includes(q) || (it.detail ?? '').toLowerCase().includes(q),
    );
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
        row.addEventListener('mousedown', (e) => e.preventDefault());
        row.addEventListener('click', (e) => this.choose(i, e.ctrlKey));
        return row;
      }),
    );
    this.list.querySelector('.selected')?.scrollIntoView({ block: 'nearest' });
  }
}
