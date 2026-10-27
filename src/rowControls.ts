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

/** Swaps `label` for a text input; Enter or blur commits a changed, non-empty value, Escape cancels. */
export function startRename(
  label: HTMLElement,
  current: string,
  commit: (value: string) => void,
): void {
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'favorite-rename';
  input.value = current;
  let done = false;
  const finish = (save: boolean): void => {
    if (done) return;
    done = true;
    const value = input.value.trim();
    input.replaceWith(label);
    if (save && value && value !== current) commit(value);
  };
  input.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') finish(true);
    else if (e.key === 'Escape') finish(false);
  });
  input.addEventListener('blur', () => finish(true));
  // The panel cancels mousedown to keep focus on the terminal, which would also block the caret.
  input.addEventListener('mousedown', (e) => e.stopPropagation());
  input.addEventListener('click', (e) => e.stopPropagation());
  label.replaceWith(input);
  input.focus();
  input.select();
}
