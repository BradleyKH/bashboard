import { attachContextMenu } from './contextMenu';
import { layoutRowMenuItems } from './favoriteMenus';
import type { NamedLayout } from './layouts';
import type { LayoutsCallbacks } from './layoutsSection';
import { iconButton, startRename } from './rowControls';

/** One saved layout in the dashboard's Layouts section. */
export function renderLayoutRow(layout: NamedLayout, index: number, callbacks: LayoutsCallbacks): HTMLElement {
  const el = document.createElement('div');
  el.className = 'favorite-row layout-row';
  el.dataset.index = String(index);
  el.addEventListener('click', () => callbacks.onOpenLayout(layout.name));

  const text = document.createElement('div');
  text.className = 'favorite-text';

  const label = document.createElement('div');
  label.className = 'favorite-label';
  label.textContent = layout.name;
  label.title = 'Open layout';

  const count = layout.tab.panes.length;
  const meta = document.createElement('div');
  meta.className = 'favorite-path';
  meta.textContent = `${count} pane${count === 1 ? '' : 's'}`;

  text.append(label, meta);

  const beginRename = (): void => startRename(label, layout.name, (value) => callbacks.onRenameLayout(index, value));
  const rename = iconButton('✎', 'layout-rename', 'Rename layout', beginRename);
  // A layout is costly to rebuild by hand, so removing it asks inline first.
  const remove = iconButton('×', 'favorite-remove', 'Remove layout', () => {
    const confirm = document.createElement('span');
    confirm.className = 'card-confirm';
    const ask = document.createElement('span');
    ask.textContent = 'Remove?';
    confirm.append(
      ask,
      iconButton('Yes', 'card-confirm-yes', 'Remove layout', () => callbacks.onRemoveLayout(index)),
      iconButton('No', 'card-confirm-no', 'Keep layout', () => confirm.replaceWith(rename, remove)),
    );
    rename.remove();
    remove.replaceWith(confirm);
  });

  attachContextMenu(el, () => ({
    entries: layoutRowMenuItems({
      open: () => callbacks.onOpenLayout(layout.name),
      rename: beginRename,
      // While the inline confirm shows, the button is detached and the confirm stays as is.
      remove: () => {
        if (remove.isConnected) remove.click();
      },
    }),
    target: el,
  }));

  el.append(text, rename, remove);
  return el;
}
