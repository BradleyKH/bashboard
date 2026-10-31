import { getCurrentWindow } from '@tauri-apps/api/window';

export function isWindowVisible(documentVisible: boolean, minimized: boolean): boolean {
  return documentVisible && !minimized;
}

/**
 * Reports whether the window is on screen: once at bind time, then only when the value changes.
 * The backdrop and the background git fetch both pause on it (docs/design.md section 6.4).
 */
export function bindWindowVisibility(onChange: (visible: boolean) => void): void {
  let minimized = false;
  let last: boolean | undefined;
  const apply = () => {
    const visible = isWindowVisible(document.visibilityState === 'visible', minimized);
    if (visible === last) return;
    last = visible;
    onChange(visible);
  };

  // WebView2 reports a fully covered window as hidden here.
  document.addEventListener('visibilitychange', apply);
  apply();

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
