import { attachContextMenu } from './contextMenu';
import { copyText } from './copyText';
import { globalPinName, type GlobalPin } from './globalPins';
import { globeIcon } from './globeIcon';
import { globalPinRowMenuItems } from './repoMenus';
import { iconButton, setRowRename } from './rowControls';
import { attachReorder } from './rowReorder';

export interface GlobalPinRowCallbacks {
  onRunGlobalPin(index: number): void;
  onEditGlobalPin(index: number): void;
  onRemoveGlobalPin(index: number): void;
  onReorderGlobalPin(from: number, to: number): void;
}

/**
 * One global command pin in the dashboard's Pins section (docs/design/dashboard.md section 4.6),
 * after the repo's own pins. It runs in the focused pane's folder, so it is never missing.
 */
export function renderGlobalPinRow(
  pin: GlobalPin,
  index: number,
  callbacks: GlobalPinRowCallbacks,
  /** Its terminal for the current repo is running a command. */
  running = false,
): HTMLElement {
  const el = document.createElement('div');
  // Its own row class keeps a drag among the global pins, apart from the repo's.
  el.className = 'favorite-row pin-row global-pin-row';
  el.dataset.index = String(index);
  el.addEventListener('click', () => callbacks.onRunGlobalPin(index));

  const handle = document.createElement('span');
  handle.className = 'favorite-handle';
  handle.textContent = '⠇';
  handle.title = 'Drag to reorder';
  attachReorder(handle, el, index, '.global-pin-row', callbacks.onReorderGlobalPin);

  const icon = document.createElement('span');
  icon.className = 'pin-icon pin-icon-global';
  icon.title = 'Global pin';
  icon.append(globeIcon());

  const label = document.createElement('div');
  label.className = 'favorite-label pin-label';
  label.textContent = globalPinName(pin);
  label.title = `${pin.command}\nRuns in the focused pane's folder`;

  const edit = iconButton('✎', 'row-rename', 'Edit pin (F2)', () => callbacks.onEditGlobalPin(index));
  setRowRename(el, () => edit.click());
  const remove = iconButton('×', 'favorite-remove', 'Remove pin', () => callbacks.onRemoveGlobalPin(index));

  if (running) {
    el.classList.add('running');
    const mark = document.createElement('span');
    mark.className = 'pin-running';
    mark.title = 'Running';
    el.append(handle, icon, label, mark, edit, remove);
  } else {
    el.append(handle, icon, label, edit, remove);
  }

  attachContextMenu(el, () => ({
    entries: globalPinRowMenuItems({
      run: () => callbacks.onRunGlobalPin(index),
      edit: () => edit.click(),
      copyCommand: () => void copyText(pin.command, 'command'),
      remove: () => callbacks.onRemoveGlobalPin(index),
    }),
    target: el,
  }));
  return el;
}
