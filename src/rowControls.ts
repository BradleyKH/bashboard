import { isBlurIntoContextMenu } from './contextMenu';

/** Small button for a dashboard row; the click never reaches the row's own handler. */
export function iconButton(label: string, className: string, title: string, onClick: () => void): HTMLButtonElement {
  const el = document.createElement('button');
  el.type = 'button';
  el.className = className;
  el.textContent = label;
  el.title = title;
  el.addEventListener('click', (e) => {
    e.stopPropagation();
    onClick();
  });
  return el;
}

const renamers = new WeakMap<HTMLElement, () => void>();

/** Lets F2 on a focused dashboard row start the rename its button or menu starts. */
export function setRowRename(row: HTMLElement, rename: () => void): void {
  renamers.set(row, rename);
}

export function rowRename(row: HTMLElement): (() => void) | undefined {
  return renamers.get(row);
}

/**
 * Swaps `label` for a text input; Enter or blur commits a changed value, Escape cancels. An empty
 * value commits only with `allowEmpty`, for names where empty means "no fixed name".
 */
export function startRename(
  label: HTMLElement,
  current: string,
  commit: (value: string) => void,
  opts: { allowEmpty?: boolean } = {},
): void {
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'favorite-rename';
  input.value = current;
  // F2 starts a rename from the focused row; Enter and Escape hand focus back to it, before the
  // commit rebuilds the section, so keyboard navigation carries on from the renamed row.
  const row = document.activeElement instanceof HTMLElement && document.activeElement.contains(label)
    ? document.activeElement
    : null;
  let done = false;
  const finish = (save: boolean, refocus: boolean): void => {
    if (done) return;
    done = true;
    const value = input.value.trim();
    input.replaceWith(label);
    if (refocus && row?.isConnected) row.focus();
    if (save && (value || opts.allowEmpty) && value !== current) commit(value);
  };
  input.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') finish(true, true);
    else if (e.key === 'Escape') finish(false, true);
  });
  input.addEventListener('blur', (e) => {
    if (!isBlurIntoContextMenu(e)) finish(true, false);
  });
  // The panel cancels mousedown to keep focus on the terminal, which would also block the caret.
  input.addEventListener('mousedown', (e) => e.stopPropagation());
  input.addEventListener('click', (e) => e.stopPropagation());
  label.replaceWith(input);
  input.focus();
  input.select();
}
