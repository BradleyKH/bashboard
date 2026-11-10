import './commandPinDialog.css';

/** A command pin listed for its own repo (or folder outside one), or for every folder. */
export type PinScope = 'repo' | 'global';

export interface CommandPinValues {
  label: string;
  command: string;
  scope: PinScope;
}

export interface CommandPinDialogOptions {
  /** "New pin" or "Edit pin". */
  title: string;
  /** The folder a repo-scoped pin runs in, shown read only; null offers only global scope. */
  folder: string | null;
  /** Whether that folder is in a git repo, which names the scope This repo rather than This folder. */
  isGit: boolean;
  initial: CommandPinValues;
}

/**
 * The new pin popup (docs/design/dashboard.md section 4.6): Name, Command, and Scope over the
 * folder the pin runs in. Resolves the trimmed values on save, or null on Escape, Cancel, or an
 * outside click.
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
      let scope: PinScope = options.folder === null ? 'global' : options.initial.scope;
      const scopeRow = document.createElement('div');
      scopeRow.className = 'command-pin-field command-pin-scope';
      const scopeText = document.createElement('span');
      scopeText.textContent = 'Scope';
      const group = document.createElement('span');
      group.className = 'command-pin-scope-group';
      group.setAttribute('role', 'group');
      group.setAttribute('aria-label', 'Scope');
      const scopeButton = (value: PinScope, text: string, tip: string): HTMLButtonElement => {
        const b = document.createElement('button');
        b.type = 'button';
        b.textContent = text;
        b.title = tip;
        b.addEventListener('click', () => {
          scope = value;
          syncScope();
        });
        return b;
      };
      const local = scopeButton(
        'repo',
        options.isGit ? 'This repo' : 'This folder',
        options.isGit ? 'Listed while a pane is in this repo' : 'Listed while a pane is in this folder',
      );
      local.disabled = options.folder === null;
      const everywhere = scopeButton('global', 'Everywhere', 'Listed for every folder, and runs in the focused pane’s');
      group.append(local, everywhere);
      scopeRow.append(scopeText, group);
      const syncScope = (): void => {
        local.setAttribute('aria-pressed', String(scope === 'repo'));
        everywhere.setAttribute('aria-pressed', String(scope === 'global'));
        const text = scope === 'repo' && options.folder !== null ? options.folder : 'the focused pane’s folder';
        folder.textContent = `Runs in ${text}`;
        folder.title = text;
      };
      syncScope();

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
        this.finish({ label: name.input.value.trim(), command: command.input.value.trim(), scope });
      });

      box.append(title, name.row, command.row, scopeRow, folder, buttons);
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
