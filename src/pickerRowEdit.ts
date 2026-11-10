// The DOM pieces a managed picker row swaps in to rename or remove an item in place
// (docs/design/dashboard.md section 4.6). The Picker owns the state; these only build controls.

/**
 * A text input over a row's label. Enter or blur commits, Escape cancels; `finish` runs once,
 * with the trimmed value or null for a cancel.
 */
export function pickerRenameInput(current: string, finish: (value: string | null) => void): HTMLInputElement {
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'picker-rename';
  input.value = current;
  let done = false;
  const end = (value: string | null): void => {
    if (done) return;
    done = true;
    finish(value);
  };
  input.addEventListener('keydown', (e) => {
    // The filter input's handler must not see these, or Escape would close the picker.
    e.stopPropagation();
    if (e.key === 'Enter') {
      e.preventDefault();
      end(input.value.trim());
    } else if (e.key === 'Escape') {
      e.preventDefault();
      end(null);
    } else if (e.key === 'Tab') {
      e.preventDefault();
    }
  });
  input.addEventListener('blur', () => end(input.value.trim()));
  // The row cancels mousedown to keep focus in the filter, which would also block the caret here.
  input.addEventListener('mousedown', (e) => e.stopPropagation());
  input.addEventListener('click', (e) => e.stopPropagation());
  return input;
}

function rowButton(label: string, className: string, title: string, onClick: () => void): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = className;
  btn.textContent = label;
  btn.title = title;
  btn.tabIndex = -1;
  btn.addEventListener('mousedown', (e) => e.preventDefault());
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    onClick();
  });
  return btn;
}

/** The hover pencil, before the ×. */
export function pickerRenameButton(title: string, onClick: () => void): HTMLButtonElement {
  return rowButton('✎', 'picker-rename-button', title, onClick);
}

/** The hover × at a row's right end. */
export function pickerRemoveButton(title: string, onClick: () => void): HTMLButtonElement {
  return rowButton('×', 'picker-remove', title, onClick);
}

/** "Remove? Yes No", in place of the row's right-hand notes while a removal waits on an answer. */
export function pickerConfirmControls(onYes: () => void, onNo: () => void): HTMLElement {
  const box = document.createElement('span');
  box.className = 'picker-confirm';
  const ask = document.createElement('span');
  ask.textContent = 'Remove?';
  box.append(
    ask,
    rowButton('Yes', 'picker-confirm-yes', 'Remove (Enter)', onYes),
    rowButton('No', 'picker-confirm-no', 'Keep (Escape)', onNo),
  );
  return box;
}
