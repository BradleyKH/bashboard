import type { HookInstallPreview } from './hookInstall';

export interface HookInstallDialogCallbacks {
  /** Performs the install; a rejection is shown in the dialog and leaves it open. */
  onConfirm(): Promise<void>;
  /** Dismissed, or closed after a successful install; the caller refocuses the terminal. */
  onClose(): void;
}

/** Modal confirmation for installing the Claude Code hooks (docs/design.md section 3.3). */
export class HookInstallDialog {
  private backdrop: HTMLElement | null = null;
  private busy = false;
  private bashFound = true;
  private install!: HTMLButtonElement;
  private cancel!: HTMLButtonElement;
  private error!: HTMLElement;
  private onClosed: ((installed: boolean) => void) | undefined;

  constructor(private readonly callbacks: HookInstallDialogCallbacks) {}

  isOpen(): boolean {
    return this.backdrop !== null;
  }

  /**
   * `onClosed`, when given, receives whether the install happened in place of
   * `callbacks.onClose`. `callbacks.onConfirm` still runs either way.
   */
  open(preview: HookInstallPreview, onClosed?: (installed: boolean) => void): void {
    if (this.backdrop) this.close();
    this.busy = false;
    this.bashFound = preview.bashFound;
    this.onClosed = onClosed;

    const backdrop = document.createElement('div');
    backdrop.className = 'hook-dialog-backdrop';
    backdrop.addEventListener('mousedown', (e) => {
      if (e.target === backdrop) {
        e.preventDefault();
        this.dismiss();
      }
    });

    const box = document.createElement('div');
    box.className = 'hook-dialog';
    box.tabIndex = -1;
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-modal', 'true');
    box.addEventListener('keydown', (e) => this.onKey(e));

    const title = document.createElement('h2');
    title.textContent = 'Install Claude Code hooks';

    const script = this.line('Writes the hook script to', preview.scriptPath);
    const settings = this.line('Adds these hooks to', preview.settingsPath);

    const pre = document.createElement('pre');
    pre.className = 'hook-dialog-json';
    pre.textContent = JSON.stringify(preview.additions, null, 2);

    this.error = document.createElement('div');
    this.error.className = 'hook-dialog-error';
    this.error.hidden = true;

    this.install = document.createElement('button');
    this.install.type = 'button';
    this.install.className = 'hook-dialog-install';
    this.install.textContent = 'Install';
    this.install.disabled = !preview.bashFound;
    this.install.addEventListener('click', () => void this.confirm());

    this.cancel = document.createElement('button');
    this.cancel.type = 'button';
    this.cancel.textContent = 'Cancel';
    this.cancel.addEventListener('click', () => this.dismiss());

    const buttons = document.createElement('div');
    buttons.className = 'hook-dialog-buttons';
    buttons.append(this.cancel, this.install);

    box.append(title);
    if (!preview.bashFound) {
      const warning = document.createElement('p');
      warning.className = 'hook-dialog-error';
      warning.textContent =
        'The hooks run through Git Bash, which was not found. Install Git for Windows, then open this dialog again.';
      box.append(warning);
    }
    box.append(script, settings, pre, this.error, buttons);
    backdrop.append(box);
    document.body.append(backdrop);
    this.backdrop = backdrop;
    box.focus();
  }

  close(): void {
    this.backdrop?.remove();
    this.backdrop = null;
    this.onClosed = undefined;
  }

  private line(label: string, path: string): HTMLElement {
    const p = document.createElement('p');
    p.className = 'hook-dialog-line';
    const code = document.createElement('code');
    code.textContent = path;
    p.append(`${label} `, code);
    return p;
  }

  private dismiss(): void {
    if (this.busy) return;
    const onClosed = this.onClosed;
    this.close();
    if (onClosed) onClosed(false);
    else this.callbacks.onClose();
  }

  private async confirm(): Promise<void> {
    if (this.busy || this.install.disabled) return;
    this.setBusy(true);
    this.error.hidden = true;
    try {
      await this.callbacks.onConfirm();
    } catch (e) {
      this.setBusy(false);
      this.error.textContent = e instanceof Error ? e.message : String(e);
      this.error.hidden = false;
      return;
    }
    this.busy = false;
    const onClosed = this.onClosed;
    this.close();
    if (onClosed) onClosed(true);
    else this.callbacks.onClose();
  }

  private setBusy(busy: boolean): void {
    this.busy = busy;
    this.install.disabled = busy || !this.bashFound;
    this.cancel.disabled = busy;
  }

  private onKey(e: KeyboardEvent): void {
    // Keep keys away from the workspace keymap and xterm.
    e.stopPropagation();
    if (e.key === 'Escape') {
      e.preventDefault();
      this.dismiss();
    } else if (e.key === 'Enter' && !(e.target instanceof HTMLButtonElement)) {
      e.preventDefault();
    }
  }
}
