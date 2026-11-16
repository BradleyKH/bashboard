// The AppImage's one-time offer to add Bashboard to the applications menu (docs/design/app.md
// section 3.32). A toast with one button, like the other passing notices; ignoring it is the
// decline, and either way the offer is not shown again.
import { invoke } from '@tauri-apps/api/core';
import type { AppState } from './appState';
import { showToast } from './toast';

export interface AppImageOfferDeps {
  state: AppState;
  /** Saves `state.appImageOfferShown` with the rest of the workspace. */
  save: () => void;
  /** Whether this run is an AppImage with no menu entry yet; false off Linux. */
  status?: () => Promise<boolean>;
  install?: () => Promise<void>;
  toast?: typeof showToast;
}

/** Long enough to read and decide; a toast left alone counts as a decline. */
const OFFER_MS = 30000;

export async function offerAppImageEntry(deps: AppImageOfferDeps): Promise<void> {
  const { state, save } = deps;
  if (state.appImageOfferShown) return;
  const status = deps.status ?? (() => invoke<boolean>('appimage_entry_status'));
  const install = deps.install ?? (() => invoke<void>('appimage_entry_install'));
  const toast = deps.toast ?? showToast;
  // A failed status read offers nothing and leaves the flag clear, so a later launch tries again.
  if (!(await status().catch(() => false))) return;
  state.appImageOfferShown = true;
  save();
  toast('Add Bashboard to your applications menu?', OFFER_MS, {
    label: 'Add',
    run: () =>
      install().then(
        () => toast('Bashboard is in your applications menu.'),
        (err: unknown) => toast(`Could not add Bashboard to the menu: ${String(err)}`),
      ),
  });
}
