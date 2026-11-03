import { attachContextMenu } from './contextMenu';
import { copyPath } from './copyText';
import { openFolder } from './folderButton';
import type { Pin } from './repos';
import { pinRowMenuItems } from './repoMenus';
import { iconButton, setRowRename, startRename } from './rowControls';
import { attachReorder } from './rowReorder';

export interface PinRowCallbacks {
  onOpenPin(pin: Pin): void;
  onRenamePin(index: number, label: string): void;
  onRemovePin(index: number): void;
  onReorderPin(from: number, to: number): void;
}

function parentFolder(path: string): string {
  const cut = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  return cut > 0 ? path.slice(0, cut) : path;
}

/** One pin in the dashboard's Repo section (docs/design.md section 4.6). A missing target is dimmed and inert. */
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

  const rename = iconButton('✎', 'layout-rename', 'Rename pin (F2)', () => {
    startRename(label, name, (value) => callbacks.onRenamePin(index, value));
  });
  // A missing pin's menu disables Rename, so F2 leaves it alone too.
  if (exists) setRowRename(el, () => rename.click());
  const remove = iconButton('×', 'favorite-remove', 'Remove pin', () => callbacks.onRemovePin(index));

  el.append(handle, icon, label, rename, remove);

  attachContextMenu(el, () => ({
    entries: pinRowMenuItems(
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
