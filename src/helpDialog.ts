import type { HelpSection } from './helpModel';

export interface HelpDialogCallbacks {
  /** Dismissed; the caller refocuses the terminal. */
  onClose(): void;
}

/** The F1 keyboard shortcut guide (docs/design.md section 4.5). */
export class HelpDialog {
  private backdrop: HTMLElement | null = null;

  constructor(private readonly callbacks: HelpDialogCallbacks) {}

  isOpen(): boolean {
    return this.backdrop !== null;
  }

  open(sections: HelpSection[]): void {
    if (this.backdrop) this.close();

    const backdrop = document.createElement('div');
    backdrop.className = 'help-dialog-backdrop';
    backdrop.addEventListener('mousedown', (e) => {
      if (e.target === backdrop) {
        e.preventDefault();
        this.dismiss();
      }
    });

    const box = document.createElement('div');
    box.className = 'help-dialog';
    box.tabIndex = -1;
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-modal', 'true');
    box.setAttribute('aria-label', 'Keyboard shortcuts');
    box.addEventListener('keydown', (e) => this.onKey(e));

    const header = document.createElement('div');
    header.className = 'help-dialog-header';
    const title = document.createElement('h2');
    title.textContent = 'Keyboard shortcuts';
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'help-dialog-close';
    close.textContent = '×';
    close.title = 'Close (Escape)';
    close.addEventListener('click', () => this.dismiss());
    header.append(title, close);

    const body = document.createElement('div');
    body.className = 'help-dialog-body';
    body.append(...sections.map((s) => this.section(s)));

    const footer = document.createElement('p');
    footer.className = 'help-dialog-footer';
    footer.textContent =
      'Change these with the "keybindings" list in settings.json; an "unbound" entry gives a key back to the shell.';

    box.append(header, body, footer);
    backdrop.append(box);
    document.body.append(backdrop);
    this.backdrop = backdrop;
    box.focus();
  }

  close(): void {
    this.backdrop?.remove();
    this.backdrop = null;
  }

  private section(section: HelpSection): HTMLElement {
    const el = document.createElement('section');
    const h = document.createElement('h3');
    h.textContent = section.title;
    const table = document.createElement('div');
    table.className = 'help-dialog-rows';
    for (const row of section.rows) {
      const label = document.createElement('div');
      label.className = 'help-dialog-label';
      label.textContent = row.label;
      if (row.note) {
        const note = document.createElement('div');
        note.className = 'help-dialog-note';
        note.textContent = row.note;
        label.append(note);
      }
      const keys = document.createElement('div');
      keys.className = 'help-dialog-keys';
      keys.append(
        ...row.keys.map((k) => {
          const kbd = document.createElement('kbd');
          kbd.textContent = k;
          return kbd;
        }),
      );
      table.append(label, keys);
    }
    el.append(h, table);
    return el;
  }

  private dismiss(): void {
    this.close();
    this.callbacks.onClose();
  }

  private onKey(e: KeyboardEvent): void {
    // Keep keys away from the workspace keymap and xterm.
    e.stopPropagation();
    if (e.key === 'Escape' || e.key === 'F1') {
      e.preventDefault();
      this.dismiss();
    }
  }
}
