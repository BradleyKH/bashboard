export interface ConfirmOptions {
  title: string;
  /** One paragraph per entry. */
  body: string[];
  confirmLabel: string;
  /** Optional labeled checkbox between the body and the buttons; read it back with openWithCheckbox. */
  checkbox?: { label: string; checked: boolean; disabled: boolean; note?: string };
}

export interface ConfirmResult {
  confirmed: boolean;
  checked: boolean;
}

/** Modal yes/no prompt. Escape, an outside click, and Cancel resolve false. */
export class ConfirmDialog {
  private backdrop: HTMLElement | null = null;
  private settle: ((result: ConfirmResult) => void) | null = null;
  private checkbox: HTMLInputElement | null = null;

  isOpen(): boolean {
    return this.backdrop !== null;
  }

  open(options: ConfirmOptions): Promise<boolean> {
    return this.openWithCheckbox(options).then((r) => r.confirmed);
  }

  openWithCheckbox(options: ConfirmOptions): Promise<ConfirmResult> {
    this.finish(false);
    return new Promise<ConfirmResult>((resolve) => {
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

      const extras: HTMLElement[] = [];
      if (options.checkbox) {
        const { label, checked, disabled, note } = options.checkbox;
        const row = document.createElement('label');
        row.className = 'confirm-dialog-checkbox';
        const input = document.createElement('input');
        input.type = 'checkbox';
        input.checked = checked;
        input.disabled = disabled;
        this.checkbox = input;
        row.append(input, ' ', label);
        extras.push(row);
        if (note) {
          const noteEl = document.createElement('p');
          noteEl.className = 'hook-dialog-line confirm-dialog-note';
          noteEl.textContent = note;
          extras.push(noteEl);
        }
      }

      box.append(title, ...paragraphs, ...extras, buttons);
      backdrop.append(box);
      document.body.append(backdrop);
      this.backdrop = backdrop;
      cancel.focus();
    });
  }

  private finish(ok: boolean): void {
    const checked = this.checkbox?.checked ?? false;
    this.backdrop?.remove();
    this.backdrop = null;
    this.checkbox = null;
    const settle = this.settle;
    this.settle = null;
    settle?.({ confirmed: ok, checked });
  }
}
