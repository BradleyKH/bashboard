import { windowsPathText } from './displayPath';
import { showToast } from './toast';

/** Writes `text` to the clipboard, toasting `Copied <what>` or the failure. */
export function copyText(text: string, what: string): Promise<void> {
  return navigator.clipboard.writeText(text).then(
    () => showToast(`Copied ${what}`, 1500),
    (err) => showToast(`Could not copy: ${String(err)}`),
  );
}

/** Copies an absolute path with backslashes and no quotes, as File Explorer's Copy as path does minus the quotes. */
export function copyPath(path: string): Promise<void> {
  return copyText(windowsPathText(path), 'path');
}
