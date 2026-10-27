import type { NamedLayout } from './layouts';
import { renderLayoutRow } from './layoutRow';

export interface LayoutsCallbacks {
  onOpenLayout(name: string): void;
  /** Save the current arrangement under this name (the section has already confirmed any overwrite). */
  onSaveLayout(name: string): void;
  onRenameLayout(index: number, name: string): void;
  onRemoveLayout(index: number): void;
}

/** The dashboard's Layouts section: saved arrangements, with an inline name prompt for saving. */
export class LayoutsSection {
  readonly el: HTMLElement;
  readonly head: HTMLElement;
  private readonly list: HTMLElement;
  private readonly prompt: HTMLElement;
  private layouts: NamedLayout[] = [];

  constructor(private readonly callbacks: LayoutsCallbacks) {
    this.el = document.createElement('section');
    this.el.className = 'dashboard-section layouts-section';

    const head = document.createElement('div');
    this.head = head;
    head.className = 'dashboard-section-head';
    const h = document.createElement('h2');
    h.textContent = 'Layouts';
    const add = document.createElement('button');
    add.type = 'button';
    add.className = 'favorite-add';
    add.textContent = '+';
    add.title = 'Save the current panes as a layout';
    add.addEventListener('click', () => this.showNameInput());
    head.append(h, add);

    this.prompt = document.createElement('div');
    this.prompt.className = 'layout-prompt';
    this.prompt.hidden = true;

    this.list = document.createElement('div');
    this.list.className = 'dashboard-list';
    this.el.append(head, this.prompt, this.list);
  }

  update(layouts: NamedLayout[]): void {
    this.layouts = layouts;
    if (layouts.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'dashboard-empty';
      empty.textContent = 'Save the current panes as a layout';
      this.list.replaceChildren(empty);
      return;
    }
    this.list.replaceChildren(...layouts.map((l, i) => renderLayoutRow(l, i, this.callbacks)));
  }

  private hidePrompt(): void {
    this.prompt.hidden = true;
    this.prompt.replaceChildren();
  }

  private showNameInput(): void {
    if (!this.prompt.hidden && this.prompt.querySelector('input')) {
      this.prompt.querySelector('input')!.focus();
      return;
    }
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'favorite-rename';
    input.placeholder = 'Layout name';
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Escape') this.hidePrompt();
      else if (e.key === 'Enter') this.submit(input.value.trim());
    });
    input.addEventListener('blur', () => {
      if (input.isConnected && input.value.trim() === '') this.hidePrompt();
    });
    // The panel cancels mousedown to keep focus on the terminal, which would also block the caret.
    input.addEventListener('mousedown', (e) => e.stopPropagation());
    this.prompt.replaceChildren(input);
    this.prompt.hidden = false;
    input.focus();
  }

  private submit(name: string): void {
    if (!name) return;
    const exists = this.layouts.some((l) => l.name.toLowerCase() === name.toLowerCase());
    if (!exists) {
      this.hidePrompt();
      this.callbacks.onSaveLayout(name);
      return;
    }
    const text = document.createElement('span');
    text.className = 'layout-confirm-text';
    text.textContent = `Replace “${name}”?`;
    const yes = document.createElement('button');
    yes.type = 'button';
    yes.className = 'layout-confirm-yes';
    yes.textContent = 'Replace';
    yes.addEventListener('click', () => {
      this.hidePrompt();
      this.callbacks.onSaveLayout(name);
    });
    const no = document.createElement('button');
    no.type = 'button';
    no.className = 'layout-confirm-no';
    no.textContent = 'Cancel';
    no.addEventListener('click', () => this.hidePrompt());
    this.prompt.replaceChildren(text, yes, no);
  }
}
