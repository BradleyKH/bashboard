export interface ConfirmOptions {
  title: string;
  /** One paragraph per entry. */
  body: string[];
  confirmLabel: string;
}

/** Modal yes/no prompt. Escape, an outside click, and Cancel resolve false. */
export class ConfirmDialog {
  private backdrop: HTMLElement | null = null;
  private settle: ((ok: boolean) => void) | null = null;

  isOpen(): boolean {
    return this.backdrop !== null;
  }

  open(options: ConfirmOptions): Promise<boolean> {
    this.finish(false);
    return new Promise<boolean>((resolve) => {
      this.settle = resolve;

      const backdrop = document.createElement('div');
      backdrop.className = 'hook-dialog-backdrop confirm-dialog-backdrop';
      backdrop.addEventListener('mousedown', (e) => {
        if (e.target === backdrop) {
          e.preventDefault();
          this.finish(false);
        }
      });

      const box = document.createElement('div');
      box.className = 'hook-dialog confirm-dialog';
      box.setAttribute('role', 'dialog');
      box.setAttribute('aria-modal', 'true');
      box.addEventListener('keydown', (e) => {
        // Keep keys away from the workspace keymap and xterm.
        e.stopPropagation();
        if (e.key === 'Escape') {
          e.preventDefault();
          this.finish(false);
        }
      });

      const title = document.createElement('h2');
      title.textContent = options.title;
      const paragraphs = options.body.map((text) => {
        const p = document.createElement('p');
        p.className = 'hook-dialog-line confirm-dialog-line';
        p.textContent = text;
        return p;
      });

      const cancel = document.createElement('button');
      cancel.type = 'button';
      cancel.textContent = 'Cancel';
      cancel.addEventListener('click', () => this.finish(false));

      const confirm = document.createElement('button');
      confirm.type = 'button';
      confirm.className = 'hook-dialog-install';
      confirm.textContent = options.confirmLabel;
      confirm.addEventListener('click', () => this.finish(true));

      const buttons = document.createElement('div');
      buttons.className = 'hook-dialog-buttons';
      buttons.append(cancel, confirm);

      box.append(title, ...paragraphs, buttons);
      backdrop.append(box);
      document.body.append(backdrop);
      this.backdrop = backdrop;
      cancel.focus();
    });
  }

  private finish(ok: boolean): void {
    this.backdrop?.remove();
    this.backdrop = null;
    const settle = this.settle;
    this.settle = null;
    settle?.(ok);
  }
}
