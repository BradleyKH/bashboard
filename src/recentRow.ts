import { attachContextMenu } from './contextMenu';
import { copyPath } from './copyText';
import { lastFolder } from './dashboardModel';
import { setPathText } from './displayPath';
import { recentRowMenuItems } from './favoriteMenus';
import { attachBodyDrag } from './bodyDrag';
import type { FavoritesCallbacks } from './favoritesSection';
import { folderButton, openFolder } from './folderButton';
import { openInMenuItems, openMenuButton } from './openMenu';

/** One recent folder under the Favorites section (docs/design/dashboard.md section 4.6). */
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
  attachContextMenu(el, async () => {
    const openItems = openIn ? await openInMenuItems(path, openIn) : [];
    return {
      entries: recentRowMenuItems(path, openItems, {
        openInExplorer: openFolder,
        copyPath,
        promote: callbacks.onPromote,
      }),
      target: el,
    };
  });
  el.append(name, full, folderButton(path), ...(openIn ? [openMenuButton(path, openIn)] : []), star);
  return el;
}
