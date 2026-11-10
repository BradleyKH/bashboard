import { attachContextMenu } from './contextMenu';
import { copyPath, copyText } from './copyText';
import { openFolder } from './folderButton';
import { isCommandPin, type Pin } from './repos';
import { commandPinRowMenuItems, pinRowMenuItems } from './repoMenus';
import { iconButton, setRowRename, startRename } from './rowControls';
import { attachReorder } from './rowReorder';

export interface PinRowCallbacks {
  onOpenPin(pin: Pin): void;
  onRenamePin(index: number, label: string): void;
  /** Opens the edit popup for the command pin at `index`. */
  onEditPin(index: number): void;
  onRemovePin(index: number): void;
  onReorderPin(from: number, to: number): void;
}

function parentFolder(path: string): string {
  const cut = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  return cut > 0 ? path.slice(0, cut) : path;
}

/**
 * One pin in the dashboard's Pins section (docs/design/dashboard.md section 4.6). A missing target
 * is dimmed and inert; a command pin edits through its popup rather than renaming inline.
 */
export function renderPinRow(
  pin: Pin,
  /** Shown when the pin has no label. */
  name: string,
  index: number,
  isDir: boolean,
  exists: boolean,
  /** The pin's absolute path, for Copy path and Open in File Explorer. */
  absolute: string,
  callbacks: PinRowCallbacks,
  /** A command pin whose terminal is running a command. */
  running = false,
): HTMLElement {
  const command = isCommandPin(pin) ? pin.command : null;
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
  // Global pins share the list but reorder among themselves (globalPinRow.ts).
  attachReorder(handle, el, index, '.pin-row:not(.global-pin-row)', callbacks.onReorderPin);

  const icon = document.createElement('span');
  icon.className = 'pin-icon';
  icon.textContent = command !== null ? '>_' : isDir ? '🗀' : '🗎';
  if (command !== null) icon.classList.add('pin-icon-command');

  const label = document.createElement('div');
  label.className = 'favorite-label pin-label';
  label.textContent = name;
  label.title = command !== null ? `${command}
${absolute}` : pin.path;

  const rename =
    command !== null
      ? iconButton('✎', 'layout-rename', 'Edit pin (F2)', () => callbacks.onEditPin(index))
      : iconButton('✎', 'layout-rename', 'Rename pin (F2)', () => {
          startRename(label, name, (value) => callbacks.onRenamePin(index, value));
        });
  // A missing pin's menu disables Rename, so F2 leaves it alone too.
  if (exists) setRowRename(el, () => rename.click());
  const remove = iconButton('×', 'favorite-remove', 'Remove pin', () => callbacks.onRemovePin(index));

  if (running) {
    el.classList.add('running');
    const mark = document.createElement('span');
    mark.className = 'pin-running';
    mark.title = 'Running';
    el.append(handle, icon, label, mark, rename, remove);
  } else {
    el.append(handle, icon, label, rename, remove);
  }

  attachContextMenu(el, () => ({
    entries:
      command !== null
        ? commandPinRowMenuItems(
            { exists },
            {
              run: () => callbacks.onOpenPin(pin),
              edit: () => rename.click(),
              copyCommand: () => void copyText(command, 'command'),
              openInExplorer: () => openFolder(absolute),
              copyPath: () => void copyPath(absolute),
              remove: () => callbacks.onRemovePin(index),
            },
          )
        : pinRowMenuItems(
            { exists },
            {
              open: () => callbacks.onOpenPin(pin),
              openInExplorer: () => openFolder(isDir ? absolute : parentFolder(absolute)),
              copyPath: () => void copyPath(absolute),
              rename: () => rename.click(),
              remove: () => callbacks.onRemovePin(index),
            },
          ),
    target: el,
  }));
  return el;
}
