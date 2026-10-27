import { check } from '@tauri-apps/plugin-updater';
import { showToast } from './toast';
import { UpdateNotice, type ConfirmFn } from './updateNotice';

export interface CheckForUpdateOptions {
  /** True when the user asked: report "up to date" and failures instead of staying quiet. */
  manual: boolean;
  /** Asks before restarting; main.ts passes its shared ConfirmDialog.open. */
  confirm: ConfirmFn;
}

let notice: UpdateNotice | null = null;

/** Checks for a newer release and offers it in a banner (docs/design.md section 3.16). */
export async function checkForUpdate(opts: CheckForUpdateOptions): Promise<void> {
  // The updater has no installed bundle to replace under `pnpm tauri dev`.
  if (import.meta.env.DEV) return;
  if (notice) return;
  try {
    const update = await check();
    if (!update) {
      if (opts.manual) showToast('Bashboard is up to date');
      return;
    }
    if (notice) return;
    notice = new UpdateNotice(update, opts.confirm, () => {
      notice = null;
    });
    notice.show();
  } catch (err) {
    if (opts.manual) showToast(`Could not check for updates: ${String(err)}`);
    else console.warn('update check failed:', err);
  }
}
