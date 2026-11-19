import { invoke } from '@tauri-apps/api/core';
import type { Update } from '@tauri-apps/plugin-updater';
import { relaunch } from '@tauri-apps/plugin-process';
import type { ConfirmOptions } from './confirmDialog';
import { platformOs } from './platform';
import { describeUpdateError, LATEST_RELEASE_URL } from './updateErrorModel';
import './updateNotice.css';

export type ConfirmFn = (options: ConfirmOptions) => Promise<boolean>;

interface RenderOptions {
  isError?: boolean;
  /** Label of the button that installs the update; no button when absent. */
  install?: string;
  /** Show a button that opens the latest release for a manual download. */
  download?: boolean;
}

/** Bottom-right banner offering an available update (docs/design/app.md section 3.16). */
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
    this.render(`Bashboard ${this.update.version} is available`, { install: 'Install and restart' });
    document.body.append(root);
  }

  close(): void {
    this.root?.remove();
    this.root = null;
    this.onDismiss();
  }

  private render(message: string, opts: RenderOptions = {}): void {
    const root = this.root;
    if (!root) return;
    const text = document.createElement('div');
    text.textContent = message;
    if (opts.isError) text.className = 'update-notice-error';
    root.replaceChildren(text);
    if (!opts.install && !opts.download) return;

    const buttons = document.createElement('div');
    buttons.className = 'update-notice-buttons';
    buttons.append(this.button('Later', () => this.close()));
    if (opts.download) {
      buttons.append(
        this.button('Download', () =>
          void invoke('open_url', { url: LATEST_RELEASE_URL }).catch((e: unknown) => console.warn('open_url failed', e)),
        ),
      );
    }
    if (opts.install) buttons.append(this.button(opts.install, () => void this.install()));
    root.append(buttons);
  }

  private button(label: string, onClick: () => void): HTMLButtonElement {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = label;
    b.addEventListener('click', onClick);
    return b;
  }

  private async install(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      // Restarting kills every shell; the layout only returns when restore is enabled.
      const ok = await this.confirm({
        title: `Install Bashboard ${this.update.version}?`,
        body: [
          'Bashboard will restart, which ends every running shell and any command or agent session in it.',
          'If workspace restore is enabled in settings, the layout reopens on the next launch.',
        ],
        confirmLabel: 'Install and restart',
      });
      if (!ok) return;

      let total = 0;
      let received = 0;
      this.render('Downloading update...');
      try {
        await this.update.downloadAndInstall((event) => {
          if (event.event === 'Started') total = event.data.contentLength ?? 0;
          else if (event.event === 'Progress') received += event.data.chunkLength;
          else if (event.event === 'Finished') {
            // On Linux the package manager runs next, behind a password prompt.
            this.render(platformOs() === 'linux' ? 'Installing update...' : 'Downloading update... 100%');
            return;
          } else return;
          const pct = total > 0 ? ` ${Math.min(100, Math.round((received / total) * 100))}%` : '';
          this.render(`Downloading update...${pct}`);
        });
      } catch (err) {
        const view = describeUpdateError(err, 'install', platformOs());
        this.render(view.message, { isError: true, install: 'Try again', download: view.offerDownload });
        return;
      }
      this.render('Restarting...');
      try {
        await relaunch();
      } catch (err) {
        // The new version is on disk; only the restart failed, so a manual one finishes the job.
        console.warn('relaunch after update failed:', err);
        this.render(`Bashboard ${this.update.version} is installed. Quit and reopen Bashboard to use it.`, {
          isError: true,
        });
      }
    } finally {
      this.busy = false;
    }
  }
}
