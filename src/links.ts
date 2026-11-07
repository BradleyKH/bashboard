import { invoke } from '@tauri-apps/api/core';
import { isLoopbackUrl } from './localBrowserModel';

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

export interface OpenLinkOptions {
  onOpenLocal?: (url: string) => void;
}

/**
 * Opens a link. Ctrl+click is required so that a plain click on terminal
 * output keeps selecting text instead of navigating away. A loopback link
 * goes to the Local Browser (when the pane supplies one); Ctrl+Shift+click
 * sends it to the system browser instead, like any other link.
 */
export function openLink(event: MouseEvent, url: string, opts: OpenLinkOptions = {}): void {
  if (!event.ctrlKey || !isOpenableUrl(url)) return;
  if (opts.onOpenLocal && !event.shiftKey && isLoopbackUrl(url)) {
    opts.onOpenLocal(url);
    return;
  }
  invoke('open_url', { url }).catch((err: unknown) => {
    console.warn('open_url failed', err);
  });
}
