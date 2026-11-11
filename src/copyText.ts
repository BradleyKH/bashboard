import { copiedPathText } from './displayPath';
import { platformOs } from './platform';
import { showToast } from './toast';

/** Writes `text` to the clipboard, toasting `Copied <what>` or the failure. */
export function copyText(text: string, what: string): Promise<void> {
  return navigator.clipboard.writeText(text).then(
    () => {
      showToast(`Copied ${what}`, 1500);
    },
    (err) => {
      showToast(`Could not copy: ${String(err)}`);
    },
  );
}

/**
 * Copies an absolute path with no quotes: with backslashes on Windows, as File Explorer's Copy as
 * path does minus the quotes, and as given elsewhere.
 */
export function copyPath(path: string): Promise<void> {
  return copyText(copiedPathText(path, platformOs()), 'path');
}
