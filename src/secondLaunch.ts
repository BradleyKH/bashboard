import { listen, type UnlistenFn } from '@tauri-apps/api/event';

/**
 * Fires when the user launches Bashboard while it is already running (docs/design.md section
 * 3.18). `folder` is where the launch started, or null when that folder is not the user's.
 */
export function onSecondLaunch(cb: (folder: string | null) => void): Promise<UnlistenFn> {
  return listen<string | null>('instance://launched', (e) => cb(e.payload));
}
