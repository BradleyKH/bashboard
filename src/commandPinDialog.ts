import './commandPinDialog.css';

export interface CommandPinValues {
  label: string;
  command: string;
}

export interface CommandPinDialogOptions {
  /** "New pin" or "Edit pin". */
  title: string;
  /** The folder the command runs in, shown read only. */
  folder: string;
  initial: CommandPinValues;
}

/**
 * The new pin popup (docs/design/dashboard.md section 4.6): Name and Command over the pin's
 * folder. Resolves the trimmed values on save, or null on Escape, Cancel, or an outside click.
 */
export class CommandPinDialog {
  private backdrop: HTMLElement | null = null;
  private settle: ((values: CommandPinValues | null) => void) | null = null;
  private restoreFocus: HTMLElement | null = null;

  open(options: CommandPinDialogOptions): Promise<CommandPinValues | null> {
    this.finish(null);
    this.restoreFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    return new Promise((resolve) => {
      this.settle = resolve;

      const backdrop = document.createElement('div');
      backdrop.className = 'hook-dialog-backdrop';
      backdrop.addEventListener('mousedown', (e) => {
        if (e.target === backdrop) {
          e.preventDefault();
          this.finish(null);
        }
      });

      const box = document.createElement('form');
      box.className = 'hook-dialog command-pin-dialog';
      box.setAttribute('role', 'dialog');
      box.setAttribute('aria-modal', 'true');

      const title = document.createElement('h2');
      title.textContent = options.title;

      const name = this.field('Name', options.initial.label, 'Optional; the command shows when empty');
      const command = this.field('Command', options.initial.command, 'dotnet run --project src/App.Api');
      command.input.spellcheck = false;
      command.input.classList.add('command-pin-command');

      const folder = document.createElement('p');
      folder.className = 'hook-dialog-line command-pin-folder';
      folder.textContent = `Runs in ${options.folder}`;
      folder.title = options.folder;

      const cancel = document.createElement('button');
      cancel.type = 'button';
      cancel.textContent = 'Cancel';
      cancel.addEventListener('click', () => this.finish(null));

      const save = document.createElement('button');
      save.type = 'submit';
      save.className = 'hook-dialog-install';
      save.textContent = 'Pin';
      const sync = (): void => {
        save.disabled = command.input.value.trim() === '';
      };
      command.input.addEventListener('input', sync);
      sync();

      const buttons = document.createElement('div');
      buttons.className = 'hook-dialog-buttons';
      buttons.append(cancel, save);

      box.addEventListener('keydown', (e) => {
        // Keep keys away from the workspace keymap and xterm.
        e.stopPropagation();
        if (e.key === 'Escape') {
          e.preventDefault();
          this.finish(null);
        }
      });
      box.addEventListener('submit', (e) => {
        e.preventDefault();
        if (save.disabled) return;
        this.finish({ label: name.input.value.trim(), command: command.input.value.trim() });
      });

      box.append(title, name.row, command.row, folder, buttons);
      backdrop.append(box);
      document.body.append(backdrop);
      this.backdrop = backdrop;
      // A prefilled command (from a selection or an edit) most often wants a name next.
      (options.initial.command && !options.initial.label ? name.input : command.input).focus();
    });
  }

  private field(label: string, value: string, placeholder: string): { row: HTMLElement; input: HTMLInputElement } {
    const row = document.createElement('label');
    row.className = 'command-pin-field';
    const text = document.createElement('span');
    text.textContent = label;
    const input = document.createElement('input');
    input.type = 'text';
    input.value = value;
    input.placeholder = placeholder;
    row.append(text, input);
    return { row, input };
  }

  private finish(values: CommandPinValues | null): void {
    if (!this.backdrop) return;
    this.backdrop.remove();
    this.backdrop = null;
    const settle = this.settle;
    this.settle = null;
    this.restoreFocus?.focus();
    this.restoreFocus = null;
    settle?.(values);
  }
}
