let home: string | null = null;

/** Sets the home folder that `displayPath` abbreviates; null (as in a browser-only run) disables it. */
export function setHomeDir(dir: string | null): void {
  home = dir;
}

/** `path` with a leading home folder shown as `~`, compared without regard to case or slash style. */
export function displayPath(path: string, homeDir: string | null = home): string {
  if (!homeDir) return path;
  const base = homeDir.replace(/[\\/]+$/, '');
  if (base === '' || path.length < base.length) return path;
  const norm = (s: string) => s.replace(/\//g, '\\').toLowerCase();
  if (norm(path.slice(0, base.length)) !== norm(base)) return path;
  const rest = path.slice(base.length);
  // A bare prefix match would turn C:\Users\my-username2 into ~2 when home is C:\Users\my-username.
  if (rest !== '' && !/^[\\/]/.test(rest)) return path;
  return rest.replace(/[\\/]+$/, '') === '' ? '~' : `~${rest}`;
}

/**
 * Fills `el` with `path` for display: home abbreviated, the full path as the tooltip, and the
 * `path-text` class, which cuts an overlong path from the left so its distinctive end stays.
 */
export function setPathText(el: HTMLElement, path: string): void {
  el.classList.add('path-text');
  el.title = path;
  // The class sets direction: rtl to move the ellipsis to the left; this keeps the text itself
  // laid out left to right, or bidi would carry a leading ~ or slash to the far end.
  const text = document.createElement('bdi');
  text.dir = 'ltr';
  text.textContent = displayPath(path);
  el.replaceChildren(text);
}
