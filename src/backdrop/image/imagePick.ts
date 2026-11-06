import { invoke } from '@tauri-apps/api/core';

/** Opens the native picker for the Image style's file or the Slideshow's folder; null when cancelled. */
export function pickBackdropImage(kind: 'imageFile' | 'folder', current: string): Promise<string | null> {
  return invoke<string | null>('backdrop_image_pick', { folder: kind === 'folder', current });
}
