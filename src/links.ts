import { invoke } from '@tauri-apps/api/core';

/**
 * True only for http: and https: URLs. Anything else (file:, javascript:,
 * bare words, empty strings) is rejected so a link can never hand the shell
 * a scheme the open_url command should not launch.
 */
export function isOpenableUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  return parsed.protocol === 'http:' || parsed.protocol === 'https:';
}

/**
 * Opens a link in the default browser. Ctrl+click is required so that a plain
 * click on terminal output keeps selecting text instead of navigating away.
 */
export function openLink(event: MouseEvent, url: string): void {
  if (!event.ctrlKey || !isOpenableUrl(url)) return;
  invoke('open_url', { url }).catch((err: unknown) => {
    console.warn('open_url failed', err);
  });
}
