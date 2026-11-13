import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';

/** Shows a system notification for a pane (docs/design/sessions.md section 4.7). */
export function showNotification(title: string, body: string, paneId: string): Promise<void> {
  return invoke<void>('toast_show', { title, body, paneId });
}

/** Fires with the pane id when the user clicks a notification; the core has already raised the window. */
export function onNotificationActivated(cb: (paneId: string) => void): Promise<UnlistenFn> {
  return listen<string>('toast://activated', (e) => cb(e.payload));
}
