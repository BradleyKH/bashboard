import type { Update } from '@tauri-apps/plugin-updater';
import { relaunch } from '@tauri-apps/plugin-process';
import type { ConfirmOptions } from './confirmDialog';
import './updateNotice.css';

export type ConfirmFn = (options: ConfirmOptions) => Promise<boolean>;

/** Bottom-right banner offering an available update (docs/design.md section 3.16). */
export class UpdateNotice {
  private root: HTMLElement | null = null;
  private busy = false;

  constructor(
    private readonly update: Update,
    private readonly confirm: ConfirmFn,
    private readonly onDismiss: () => void,
  ) {}

  show(): void {
    if (this.root) return;
    const root = document.createElement('div');
    root.className = 'update-notice';
    root.setAttribute('role', 'status');
    this.root = root;
    this.render(`Bashboard ${this.update.version} is available`, true);
    document.body.append(root);
  }

  close(): void {
    this.root?.remove();
    this.root = null;
    this.onDismiss();
  }

  private render(message: string, withButtons: boolean, isError = false): void {
    const root = this.root;
    if (!root) return;
    const text = document.createElement('div');
    text.textContent = message;
    if (isError) text.className = 'update-notice-error';
    root.replaceChildren(text);
    if (!withButtons) return;

    const install = document.createElement('button');
    install.type = 'button';
    install.textContent = 'Install and restart';
    install.addEventListener('click', () => void this.install());
    const later = document.createElement('button');
    later.type = 'button';
    later.textContent = 'Later';
    later.addEventListener('click', () => this.close());
    const buttons = document.createElement('div');
    buttons.className = 'update-notice-buttons';
    buttons.append(later, install);
    root.append(buttons);
  }

  private async install(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      // Restarting kills every shell; the layout only returns when restore is enabled.
      const ok = await this.confirm({
        title: `Install Bashboard ${this.update.version}?`,
        body: [
          'Bashboard will restart, which ends every running shell and any command or Claude session in it.',
          'If workspace restore is enabled in settings, the layout reopens on the next launch.',
        ],
        confirmLabel: 'Install and restart',
      });
      if (!ok) return;

      let total = 0;
      let received = 0;
      this.render('Downloading update...', false);
      await this.update.downloadAndInstall((event) => {
        if (event.event === 'Started') total = event.data.contentLength ?? 0;
        else if (event.event === 'Progress') received += event.data.chunkLength;
        else return;
        const pct = total > 0 ? ` ${Math.min(100, Math.round((received / total) * 100))}%` : '';
        this.render(`Downloading update...${pct}`, false);
      });
      this.render('Restarting...', false);
      await relaunch();
    } catch (err) {
      this.render(`Update failed: ${String(err)}`, true, true);
    } finally {
      this.busy = false;
    }
  }
}
