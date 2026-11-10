import { Channel, invoke } from '@tauri-apps/api/core';
import type { TlsProbe } from './browserPaneModel';
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

/** Moves the frame from `from` to `to` in place of its current history entry, if it still shows `from`. */
export function replace(paneId: string, from: string, to: string): Promise<void> {
  return invoke('browser_replace', { paneId, from, to });
}

export function reload(paneId: string, ignoreCache: boolean): Promise<void> {
  return invoke('browser_reload', { paneId, ignoreCache });
}

export function responseBody(paneId: string, requestId: string): Promise<ResponseBody> {
  return invoke<ResponseBody>('browser_response_body', { paneId, requestId });
}

/** Why an https loopback address failed to load, from a TLS handshake the core makes itself. */
export function probeTls(url: string): Promise<TlsProbe> {
  return invoke<TlsProbe>('browser_probe_tls', { url });
}

/** `url` as https when it is an http loopback URL whose port speaks TLS; otherwise unchanged. */
export function preferTls(url: string): Promise<string> {
  return invoke<string>('browser_prefer_tls', { url });
}

/** Which browser pane's frame holds keyboard focus, or null once focus is back in the app. */
export function setFocus(paneId: string | null): Promise<void> {
  return invoke('browser_focus', { paneId });
}

/** The `keys` of every keybinding the keymap accepted; the core claims only these from a page. */
export function chords(keys: string[]): Promise<void> {
  return invoke('browser_chords', { keys });
}

/** How a served file page is trusted (docs/design/browser.md section 3.21). */
export type FileTrust = 'trusted' | 'local' | 'downloaded';

export interface ServedFile {
  /** The loopback address the frame loads. */
  url: string;
  /** The mount's serving address up to its root. */
  base: string;
  /** The mount's folder on disk; allowed hosts are kept per folder. */
  folder: string;
  trust: FileTrust;
  /** The file's path on disk, which the address field shows. */
  path: string;
}

/** Serves the local HTML file at `fileUrl` (a `file:///` URL) to this pane over loopback. */
export function serveFile(paneId: string, fileUrl: string): Promise<ServedFile> {
  return invoke<ServedFile>('browser_serve_file', { paneId, fileUrl });
}

/** Stops watching this pane's file once it shows something else; its tokens stay live until it closes. */
export function unwatchFile(paneId: string): Promise<void> {
  return invoke('browser_unwatch_file', { paneId });
}
