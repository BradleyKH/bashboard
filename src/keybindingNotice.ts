const AUTO_CLEAR_MS = 10_000;

export interface NoticeActions {
  onUndo?: () => void;
  onAssign?: () => void;
}

/** The status line at the bottom of the shortcut guide; it lasts until the next edit or 10 seconds. */
export class KeybindingNotice {
  readonly element: HTMLElement;
  private timer: number | null = null;

  constructor() {
    this.element = document.createElement('div');
    this.element.className = 'kb-notice';
    this.element.setAttribute('role', 'status');
    this.element.hidden = true;
  }

  show(text: string, actions: NoticeActions): void {
    this.reset();
    this.element.classList.remove('kb-notice-error');
    const span = document.createElement('span');
    span.className = 'kb-notice-text';
    span.textContent = text;
    this.element.appendChild(span);
    if (actions.onUndo) this.addButton('Undo', 'kb-notice-undo', actions.onUndo);
    if (actions.onAssign) this.addButton('Assign a key', 'kb-notice-assign', actions.onAssign);
    this.element.hidden = false;
    this.timer = window.setTimeout(() => this.clear(), AUTO_CLEAR_MS);
  }

  showError(text: string): void {
    this.reset();
    this.element.classList.add('kb-notice-error');
    const span = document.createElement('span');
    span.className = 'kb-notice-text';
    span.textContent = text;
    this.element.appendChild(span);
    this.element.hidden = false;
    this.timer = window.setTimeout(() => this.clear(), AUTO_CLEAR_MS);
  }

  clear(): void {
    this.reset();
    this.element.classList.remove('kb-notice-error');
    this.element.hidden = true;
  }

  dispose(): void {
    this.cancelTimer();
  }

  private addButton(label: string, cls: string, callback: () => void): void {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `kb-notice-button ${cls}`;
    btn.textContent = label;
    btn.title = label;
    btn.addEventListener('click', () => {
      this.clear();
      callback();
    });
    this.element.appendChild(btn);
  }

  private reset(): void {
    this.cancelTimer();
    this.element.replaceChildren();
  }

  private cancelTimer(): void {
    if (this.timer !== null) {
      window.clearTimeout(this.timer);
      this.timer = null;
    }
  }
}
