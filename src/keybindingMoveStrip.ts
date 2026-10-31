/**
 * The strip shown under an edit row when a recorded chord belongs to another action.
 * Enter and Escape are handled by the dialog through the recorder, not here.
 */
export function renderMoveStrip(
  text: string,
  onMove: () => void,
  onCancel: () => void,
  moveLabel = 'Move',
): HTMLElement {
  const strip = document.createElement('div');
  strip.className = 'kb-strip';
  strip.setAttribute('role', 'alert');

  const message = document.createElement('span');
  message.className = 'kb-strip-text';
  message.textContent = text;
  strip.append(message);

  const move = document.createElement('button');
  move.type = 'button';
  move.className = 'kb-strip-move';
  move.textContent = moveLabel;
  move.addEventListener('click', () => onMove());

  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.className = 'kb-strip-cancel';
  cancel.textContent = 'Cancel';
  cancel.addEventListener('click', () => onCancel());

  strip.append(move, cancel);
  return strip;
}
