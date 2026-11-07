import { Channel, invoke } from '@tauri-apps/api/core';
import type { BrowserEvent } from './devtoolsModel';

export interface ResponseBody {
  body: string;
  /** The body is base64-encoded binary rather than text. */
  base64: boolean;
}

/** Binds this pane's frame to the CDP bridge; events for it arrive on `onEvent` until `detach`. */
export function attach(paneId: string, onEvent: (event: BrowserEvent) => void): Promise<void> {
  const channel = new Channel<BrowserEvent>();
  channel.onmessage = onEvent;
  return invoke('browser_attach', { paneId, onEvent: channel });
}

export function detach(paneId: string): Promise<void> {
  return invoke('browser_detach', { paneId });
}

/** -1 goes back, +1 forward. */
export function history(paneId: string, delta: number): Promise<void> {
  return invoke('browser_history', { paneId, delta });
}

export function reload(paneId: string, ignoreCache: boolean): Promise<void> {
  return invoke('browser_reload', { paneId, ignoreCache });
}

export function responseBody(paneId: string, requestId: string): Promise<ResponseBody> {
  return invoke<ResponseBody>('browser_response_body', { paneId, requestId });
}

/** Which browser pane's frame holds keyboard focus, or null once focus is back in the app. */
export function setFocus(paneId: string | null): Promise<void> {
  return invoke('browser_focus', { paneId });
}

/** The `keys` of every keybinding the keymap accepted; the core claims only these from a page. */
export function chords(keys: string[]): Promise<void> {
  return invoke('browser_chords', { keys });
}
