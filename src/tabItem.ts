import type { TabInfo } from './workspace';

export interface TabItemHooks {
  onSwitch(id: string): void;
  onClose(id: string): void;
  onRename(id: string, name: string): void;
  /** Called when inline rename ends, so focus can return to the terminal. */
  onRenameDone(): void;
  onPointerDown(id: string, e: PointerEvent): void;
}

/** One tab in the strip (docs/design.md section 4.10). */
export class TabItem {
  readonly el: HTMLElement;
  private readonly dot: HTMLElement;
  private readonly title: HTMLElement;
  private info: TabInfo | null = null;
  private editing = false;

  constructor(
    readonly id: string,
    private readonly hooks: TabItemHooks,
  ) {
    this.el = document.createElement('div');
    this.el.className = 'tab-item';
    this.el.dataset.tabId = id;

    this.dot = document.createElement('span');
    this.dot.className = 'status-dot idle';

    this.title = document.createElement('span');
    this.title.className = 'tab-title';

    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'tab-close';
    close.textContent = '×';
    close.title = 'Close tab';
    close.addEventListener('pointerdown', (e) => e.stopPropagation());
    close.addEventListener('click', (e) => {
      e.stopPropagation();
      this.hooks.onClose(this.id);
    });

    this.el.append(this.dot, this.title, close);
    this.el.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || this.editing) return;
      this.hooks.onPointerDown(this.id, e);
    });
    this.el.addEventListener('click', () => {
      if (!this.editing) this.hooks.onSwitch(this.id);
    });
    this.title.addEventListener('dblclick', () => this.beginRename());
  }

  update(info: TabInfo): void {
    this.info = info;
    this.el.classList.toggle('active', info.active);
    this.el.classList.toggle('attention', info.attention);
    this.dot.className = `status-dot ${info.status}`;
    this.title.textContent = info.title;
    this.el.title = info.title;
  }

  private beginRename(): void {
    if (this.editing || !this.info) return;
    this.editing = true;
    const input = document.createElement('input');
    input.className = 'tab-rename';
    input.value = this.info.name ?? this.info.title;
    input.spellcheck = false;
    this.title.replaceWith(input);

    let finished = false;
    const finish = (save: boolean) => {
      if (finished) return;
      finished = true;
      this.editing = false;
      const value = input.value.trim();
      input.replaceWith(this.title);
      if (save) this.hooks.onRename(this.id, value);
      this.hooks.onRenameDone();
    };
    input.addEventListener('keydown', (e) => {
      // Keys here are text editing, not chords for the terminal.
      e.stopPropagation();
      if (e.key === 'Enter') finish(true);
      else if (e.key === 'Escape') finish(false);
    });
    input.addEventListener('blur', () => finish(true));
    input.addEventListener('pointerdown', (e) => e.stopPropagation());
    input.addEventListener('click', (e) => e.stopPropagation());
    input.focus();
    input.select();
  }
}
