import { lastFolder } from './dashboardModel';
import { setPathText } from './displayPath';
import { attachBodyDrag } from './favoriteRow';
import type { FavoritesCallbacks } from './favoritesSection';
import { folderButton } from './folderButton';
import { openMenuButton } from './openMenu';

/** One recent folder under the Favorites section (docs/design.md section 4.6). */
export function renderRecentRow(path: string, callbacks: FavoritesCallbacks): HTMLElement {
  const el = document.createElement('div');
  el.className = 'recent-row';
  el.title = path;
  el.addEventListener('click', (e) => callbacks.onOpen(path, { collapsed: e.ctrlKey }));
  attachBodyDrag(el, (e) => callbacks.onDragStart(path, e));

  const name = document.createElement('span');
  name.className = 'recent-name';
  name.textContent = lastFolder(path) || path;

  const full = document.createElement('span');
  full.className = 'recent-path';
  setPathText(full, path);

  const star = document.createElement('button');
  star.type = 'button';
  star.className = 'recent-star';
  star.textContent = '☆';
  star.title = 'Add to favorites';
  star.addEventListener('click', (e) => {
    e.stopPropagation();
    callbacks.onPromote(path);
  });

  const openIn = callbacks.onOpenIn;
  el.append(name, full, folderButton(path), ...(openIn ? [openMenuButton(path, openIn)] : []), star);
  return el;
}
