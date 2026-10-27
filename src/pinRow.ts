import type { Pin } from './repos';
import { iconButton, startRename } from './rowControls';
import { attachReorder } from './rowReorder';

export interface PinRowCallbacks {
  onOpenPin(pin: Pin): void;
  onRenamePin(index: number, label: string): void;
  onRemovePin(index: number): void;
  onReorderPin(from: number, to: number): void;
}

/** One pin in the dashboard's Repo section (docs/design.md section 4.6). A missing target is dimmed and inert. */
export function renderPinRow(
  pin: Pin,
  /** Shown when the pin has no label. */
  name: string,
  index: number,
  isDir: boolean,
  exists: boolean,
  callbacks: PinRowCallbacks,
): HTMLElement {
  const el = document.createElement('div');
  el.className = 'favorite-row pin-row';
  el.dataset.index = String(index);
  if (exists) {
    el.addEventListener('click', () => callbacks.onOpenPin(pin));
  } else {
    el.classList.add('missing');
    el.title = 'Not found';
  }

  const handle = document.createElement('span');
  handle.className = 'favorite-handle';
  handle.textContent = '⠇';
  handle.title = 'Drag to reorder';
  attachReorder(handle, el, index, '.pin-row', callbacks.onReorderPin);

  const icon = document.createElement('span');
  icon.className = 'pin-icon';
  icon.textContent = isDir ? '🗀' : '🗎';

  const label = document.createElement('div');
  label.className = 'favorite-label pin-label';
  label.textContent = name;
  label.title = pin.path;

  const rename = iconButton('✎', 'layout-rename', 'Rename pin', () => {
    startRename(label, name, (value) => callbacks.onRenamePin(index, value));
  });
  const remove = iconButton('×', 'favorite-remove', 'Remove pin', () => callbacks.onRemovePin(index));

  el.append(handle, icon, label, rename, remove);
  return el;
}
