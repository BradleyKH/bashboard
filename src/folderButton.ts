import { invoke } from '@tauri-apps/api/core';
import { showToast } from './toast';

/** Opens a folder in File Explorer, with a toast if it fails. */
export function openFolder(path: string): void {
  invoke('open_folder', { path }).catch((err: unknown) => showToast(`Could not open folder: ${String(err)}`));
}

/** The dashboard rows' "open in File Explorer" button. */
export function folderButton(path: string): HTMLButtonElement {
  const el = document.createElement('button');
  el.type = 'button';
  el.className = 'folder-open';
  el.textContent = '🗁';
  el.title = 'Open in File Explorer';
  el.addEventListener('click', (e) => {
    // The row's own click opens a terminal, focuses a pane, or expands details.
    e.stopPropagation();
    openFolder(path);
  });
  return el;
}
