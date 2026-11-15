import { formatSize } from './formatSize';
import { iconButton } from './rowControls';
import { attachBodyDrag } from './bodyDrag';
import type { FileItem } from './filesTreeModel';

export interface FileRowOptions {
  /** The tree view, which indents rows and gives folders a chevron. */
  tree?: boolean;
  selected: boolean;
  /** The keyboard cursor's row, which the preview shows. */
  cursor: boolean;
  /** Cut and not yet pasted, drawn dimmed as File Explorer draws one. */
  cut?: boolean;
  /** A click, with its Ctrl and Shift state. */
  onSelect: (e: MouseEvent) => void;
  onActivate: () => void;
  /** The chevron of a tree folder was clicked. */
  onToggle?: () => void;
  /** Called with the row's menu button so the menu can anchor to it. */
  onMenu: (anchor: HTMLElement) => void;
  /** The body of the row was dragged past the threshold (a path drag). */
  onDragStart?: (e: PointerEvent) => void;
}

function formatModified(ms: number): string {
  if (!ms) return '';
  const d = new Date(ms);
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return d.toLocaleDateString(
    undefined,
    sameYear ? { month: 'short', day: 'numeric' } : { year: 'numeric', month: 'short', day: 'numeric' },
  );
}

/**
 * One row of the Files list: in the tree a chevron indented by depth, then icon, name, size,
 * modified date, and a hover menu button.
 */
export function renderFileRow(entry: FileItem, opts: FileRowOptions): HTMLElement {
  const row = document.createElement('div');
  row.className = 'file-row';
  row.setAttribute('role', 'option');
  row.setAttribute('aria-selected', String(opts.selected));
  row.dataset.key = entry.key;
  if (opts.selected) row.classList.add('selected');
  if (opts.cursor) row.classList.add('cursor');
  if (opts.cut) row.classList.add('cut');
  if (entry.isDir) row.classList.add('dir');

  const icon = document.createElement('span');
  icon.className = 'file-row-icon';
  icon.textContent = entry.isDir ? '\u{1F4C1}' : '\u{1F4C4}';

  const name = document.createElement('span');
  name.className = 'file-row-name';
  name.textContent = entry.name;
  name.title = entry.name;

  const size = document.createElement('span');
  size.className = 'file-row-meta file-row-size';
  size.textContent = entry.isDir ? '' : formatSize(entry.size);

  const date = document.createElement('span');
  date.className = 'file-row-meta file-row-date';
  date.textContent = entry.isDir ? '' : formatModified(entry.modified);

  const menu = iconButton('⋯', 'file-row-menu', 'Row menu', () => opts.onMenu(menu));

  if (opts.tree) {
    const twisty = document.createElement('span');
    twisty.className = 'file-row-twisty';
    twisty.style.setProperty('--depth', String(entry.depth));
    if (entry.isDir) {
      row.setAttribute('aria-expanded', String(entry.open));
      twisty.textContent = entry.open ? '▾' : '▸';
      twisty.addEventListener('click', (e) => {
        e.stopPropagation();
        opts.onToggle?.();
      });
      // A quick second click toggles back rather than opening the row.
      twisty.addEventListener('dblclick', (e) => e.stopPropagation());
      twisty.addEventListener('pointerdown', (e) => e.stopPropagation());
    }
    row.append(twisty);
  }
  row.append(icon, name, size, date, menu);
  row.addEventListener('click', (e) => opts.onSelect(e));
  row.addEventListener('dblclick', () => opts.onActivate());
  if (opts.onDragStart) attachBodyDrag(row, opts.onDragStart);
  return row;
}
