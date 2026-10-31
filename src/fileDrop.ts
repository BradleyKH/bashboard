import { getCurrentWebview } from '@tauri-apps/api/webview';
import { getCurrentWindow } from '@tauri-apps/api/window';

export interface FileDropHooks {
  targetAt(x: number, y: number): string | null;
  highlight(paneId: string | null): void;
  hover(pos: { x: number; y: number } | null): void;
  drop(paneId: string, paths: string[]): void;
}

/** Tauri reports drag positions in physical pixels; the DOM hit-tests in CSS pixels. */
export function clientPoint(
  pos: { x: number; y: number },
  dpr: number,
): { x: number; y: number } {
  const scale = dpr > 0 ? dpr : 1;
  return { x: pos.x / scale, y: pos.y / scale };
}

/** Routes File Explorer drops (Tauri's webview drag-drop events) to the workspace's hooks. */
export function listenFileDrops(hooks: FileDropHooks): void {
  try {
    void getCurrentWebview()
      .onDragDropEvent((event) => {
        const payload = event.payload;
        if (payload.type === 'leave') {
          hooks.highlight(null);
          hooks.hover(null);
          return;
        }
        const pt = clientPoint(payload.position, window.devicePixelRatio);
        if (payload.type === 'enter' || payload.type === 'over') {
          hooks.hover(pt);
          hooks.highlight(hooks.targetAt(pt.x, pt.y));
          return;
        }
        const target = hooks.targetAt(pt.x, pt.y);
        hooks.highlight(null);
        hooks.hover(null);
        if (target === null || payload.paths.length === 0) return;
        // The drag came from another app, so the window must be active before the terminal can
        // take keystrokes.
        getCurrentWindow()
          .setFocus()
          .catch((err) => console.warn('could not focus the window after a file drop', err));
        hooks.drop(target, payload.paths);
      })
      .catch((err) => console.warn('file drop listener unavailable', err));
  } catch (err) {
    console.warn('file drop listener unavailable', err);
  }
}
