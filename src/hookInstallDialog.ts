import { agentName, isPreviewAgent } from './agentNames';
import type { HookAgentId, HookInstallPreview } from './hookInstall';
import { hookAction, hookActionVerb, scriptLineLabel } from './hookInstallModel';

export interface HookInstallDialogCallbacks {
  /** Performs the install; a rejection is shown in the dialog and leaves it open. */
  onConfirm(agent: HookAgentId): Promise<void>;
  /** Dismissed, or closed after a successful install; the caller refocuses the terminal. */
  onClose(): void;
}

/** Modal confirmation for installing one agent's hooks (docs/design/sessions.md section 3.3). */
export class HookInstallDialog {
  private backdrop: HTMLElement | null = null;
  private busy = false;
  private agent: HookAgentId = 'claude';
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
    this.agent = preview.agent ?? 'claude';
    const name = agentName(this.agent);
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

    const verb = hookActionVerb(hookAction(preview));
    const title = document.createElement('h2');
    title.textContent = `${verb} ${name} hooks`;

    const details: HTMLElement[] = [];
    const scriptLabel = scriptLineLabel(preview.scriptState);
    if (scriptLabel) details.push(this.line(scriptLabel, preview.scriptPath));
    const updates = Object.keys(preview.updates).length > 0;
    const additions = Object.keys(preview.additions).length > 0;
    if (updates) {
      details.push(this.line('Updates these hooks in', preview.settingsPath), this.json(preview.updates));
    }
    if (additions) {
      details.push(this.line('Adds these hooks to', preview.settingsPath), this.json(preview.additions));
    }
    if (!updates && !additions) {
      const change = preview.scriptState === 'missing' ? 'written' : 'updated';
      details.push(
        this.line('The hooks in', preview.settingsPath, ` are already in place; only the hook program will be ${change}.`),
      );
    }

    this.error = document.createElement('div');
    this.error.className = 'hook-dialog-error';
    this.error.hidden = true;

    this.install = document.createElement('button');
    this.install.type = 'button';
    this.install.className = 'hook-dialog-install';
    this.install.textContent = verb;
    this.install.addEventListener('click', () => void this.confirm());

    this.cancel = document.createElement('button');
    this.cancel.type = 'button';
    this.cancel.textContent = 'Cancel';
    this.cancel.addEventListener('click', () => this.dismiss());

    const buttons = document.createElement('div');
    buttons.className = 'hook-dialog-buttons';
    buttons.append(this.cancel, this.install);

    box.append(title);
    box.append(...details);
    box.append(this.note("Only Bashboard's own hooks are added or changed; any other hooks you have are left as they are."));
    if (isPreviewAgent(this.agent)) {
      box.append(this.note(`${name} support is a preview.`));
    }
    if (this.agent === 'codex') {
      box.append(this.note('Codex will ask you to trust the hook the next time it starts.'));
    }
    box.append(this.error, buttons);
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

  private note(text: string): HTMLElement {
    const p = document.createElement('p');
    p.className = 'hook-dialog-line';
    p.textContent = text;
    return p;
  }

  private json(value: unknown): HTMLElement {
    const pre = document.createElement('pre');
    pre.className = 'hook-dialog-json';
    pre.textContent = JSON.stringify(value, null, 2);
    return pre;
  }

  private line(label: string, path: string, after = ''): HTMLElement {
    const p = document.createElement('p');
    p.className = 'hook-dialog-line';
    const code = document.createElement('code');
    code.textContent = path;
    p.append(`${label} `, code, after);
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
      await this.callbacks.onConfirm(this.agent);
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
    this.install.disabled = busy;
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
