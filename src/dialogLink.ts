import { invoke } from '@tauri-apps/api/core';

/** An inline button styled as a link that opens `url` in the default browser. */
export function linkButton(text: string, url: string): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'app-dialog-link';
  b.textContent = text;
  b.title = url;
  b.addEventListener('click', () => {
    invoke('open_url', { url }).catch((err: unknown) => console.warn('open_url failed', err));
  });
  return b;
}
