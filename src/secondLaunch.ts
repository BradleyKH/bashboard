import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';

/**
 * The folder named on Bashboard's own command line (Explorer's "Open in Bashboard"), or null.
 * Returned once per process, so a page reload does not open it again.
 */
export function takeStartupFolder(): Promise<string | null> {
  return invoke<string | null>('startup_folder_take');
}

/**
 * Fires when the user launches Bashboard while it is already running (docs/design/app.md
 * section 3.18). `folder` is where the launch started, or null when that folder is not the user's.
 */
export function onSecondLaunch(cb: (folder: string | null) => void): Promise<UnlistenFn> {
  return listen<string | null>('instance://launched', (e) => cb(e.payload));
}
