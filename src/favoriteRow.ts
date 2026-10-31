import type { FavoritesCallbacks } from './favoritesSection';
import { favoritePathText, type Favorite } from './favorites';
import { setPathText } from './displayPath';
import { folderButton } from './folderButton';
import { openMenuButton } from './openMenu';
import { profileBadge } from './profiles';
import { attachReorder } from './rowReorder';
import { iconButton, startRename } from './rowControls';
import { attachBodyDrag } from './bodyDrag';

const DOUBLE_CLICK_MS = 300;

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
