import { invoke } from '@tauri-apps/api/core';
import { showToast } from './toast';

/** An editor the core detected (docs/design.md section 3.12). */
export interface Editor {
  id: string;
  name: string;
}

export function listEditors(): Promise<Editor[]> {
  return invoke<Editor[]>('editors');
}

/** Opens a file or folder in the preferred editor, toasting when it falls back or fails. */
export async function openInEditor(path: string, line?: number): Promise<void> {
  try {
    const r = await invoke<{ fallback: boolean }>('open_in_editor', { path, line: line ?? null });
    if (r.fallback) showToast('The preferred editor was not found; opened in the default app.');
  } catch (err) {
    showToast(err instanceof Error ? err.message : String(err));
  }
}
