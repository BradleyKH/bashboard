import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import type { MediaCommand, MediaSnapshot } from './mediaModel';

/** What is playing now, or null while no app has a media session (always, off Windows). */
export function mediaState(): Promise<MediaSnapshot | null> {
  return invoke<MediaSnapshot | null>('media_state');
}

/** The current album art as image bytes; empty when there is none. */
export function mediaArt(): Promise<ArrayBuffer> {
  return invoke<ArrayBuffer>('media_art');
}

/** Sends a transport or volume command; failures are logged, since the next snapshot shows the truth. */
export function mediaControl(command: MediaCommand): void {
  invoke('media_control', { command }).catch((e) => console.warn('media control failed:', e));
}

export function onMediaChanged(cb: (s: MediaSnapshot | null) => void): Promise<() => void> {
  return listen<MediaSnapshot | null>('media://changed', (e) => cb(e.payload));
}
