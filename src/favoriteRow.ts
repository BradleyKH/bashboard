import type { FavoritesCallbacks } from './favoritesSection';
import { favoritePathText, type Favorite } from './favorites';
import { setPathText } from './displayPath';
import { folderButton } from './folderButton';
import { openMenuButton } from './openMenu';
import { profileBadge } from './profiles';
import { attachReorder } from './rowReorder';
import { iconButton, startRename } from './rowControls';

const DRAG_THRESHOLD_PX = 4;
const DOUBLE_CLICK_MS = 300;

/**
 * Starts `onDragStart` once the pointer moves 4 px from a left-button press on the row body,
 * and swallows the click that would otherwise follow, so a plain click still opens the row.
 */
export function attachBodyDrag(
  row: HTMLElement,
  onDragStart: (e: PointerEvent) => void,
): void {
  let dragged = false;
  row.addEventListener('pointerdown', (e) => {
    dragged = false;
    if (e.button !== 0) return;
    if ((e.target as HTMLElement).closest('button, input, .favorite-handle')) return;
    const startX = e.clientX;
    const startY = e.clientY;
    const stop = (): void => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', stop);
      window.removeEventListener('pointercancel', stop);
    };
    const move = (ev: PointerEvent): void => {
      if (Math.hypot(ev.clientX - startX, ev.clientY - startY) < DRAG_THRESHOLD_PX) return;
      stop();
      dragged = true;
      onDragStart(ev);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', stop);
    window.addEventListener('pointercancel', stop);
  });
  row.addEventListener(
    'click',
    (e) => {
      if (!dragged) return;
      dragged = false;
      e.stopImmediatePropagation();
    },
    true,
  );
}

/** One favorite in the dashboard's Favorites section (docs/design.md section 4.6). */
export function renderFavoriteRow(
  favorite: Favorite,
  index: number,
  callbacks: FavoritesCallbacks,
): HTMLElement {
  const el = document.createElement('div');
  el.className = 'favorite-row';
  el.dataset.index = String(index);
  // A click on the label waits out a possible double-click, which renames instead of opening.
  let openTimer: number | undefined;
  el.addEventListener('click', (e) => {
    const collapsed = e.ctrlKey;
    if (!(e.target as HTMLElement).closest('.favorite-label')) {
      callbacks.onOpen(favorite.path, { collapsed });
      return;
    }
    if (e.detail > 1) return;
    openTimer = window.setTimeout(() => callbacks.onOpen(favorite.path, { collapsed }), DOUBLE_CLICK_MS);
  });
  attachBodyDrag(el, (e) => callbacks.onDragStart(favorite.path, e));

  const handle = document.createElement('span');
  handle.className = 'favorite-handle';
  handle.textContent = '⠇';
  handle.title = 'Drag to reorder';
  attachReorder(handle, el, index, '.favorite-row', callbacks.onReorder);

  const text = document.createElement('div');
  text.className = 'favorite-text';

  const label = document.createElement('div');
  label.className = 'favorite-label';
  label.textContent = favorite.label;
  label.title = favorite.path;
  label.addEventListener('dblclick', (e) => {
    e.stopPropagation();
    window.clearTimeout(openTimer);
    startRename(label, favorite.label, (value) => callbacks.onRename(index, value));
  });

  const path = document.createElement('div');
  path.className = 'favorite-path';
  setPathText(path, favorite.path, favoritePathText(favorite));

  text.append(label, path);

  const remove = iconButton('×', 'favorite-remove', 'Remove favorite', () => callbacks.onRemove(index));

  const badge = favorite.profile ? profileBadge(favorite.profile) : null;
  const openIn = callbacks.onOpenIn;
  el.append(
    handle,
    text,
    ...(badge ? [badge] : []),
    folderButton(favorite.path),
    ...(openIn ? [openMenuButton(favorite.path, openIn)] : []),
    remove,
  );
  return el;
}
