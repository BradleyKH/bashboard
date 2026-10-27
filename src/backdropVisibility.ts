import { getCurrentWindow } from '@tauri-apps/api/window';
import type { BackdropHandle } from './backdrop/backdrop';

export function isBackdropVisible(documentVisible: boolean, minimized: boolean): boolean {
  return documentVisible && !minimized;
}

/** Pauses the backdrop while the page is hidden or the window is minimized (docs/design.md section 6.4). */
export function bindBackdropVisibility(handle: BackdropHandle): void {
  let minimized = false;
  const apply = () => handle.setVisible(isBackdropVisible(document.visibilityState === 'visible', minimized));

  // WebView2 reports a fully covered window as hidden here.
  document.addEventListener('visibilitychange', apply);

  // Minimizing does not always flip visibilityState, so ask the window itself. Absent outside Tauri.
  try {
    const win = getCurrentWindow();
    const refresh = () =>
      win
        .isMinimized()
        .then((value) => {
          minimized = value;
          apply();
        })
        .catch(() => {});
    void win.onResized(() => void refresh()).catch(() => {});
    void refresh();
  } catch {
    // Plain browser: visibilitychange alone drives it.
  }
}
