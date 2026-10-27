import { formatSize } from './formatSize';
import { iconButton } from './rowControls';
import type { FileEntry } from './filesModel';

export interface FileRowOptions {
  selected: boolean;
  onSelect: () => void;
  onActivate: () => void;
  /** Called with the row's menu button so the menu can anchor to it. */
  onMenu: (anchor: HTMLElement) => void;
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

/** One row of the Files list: icon, name, size, modified date, and a hover menu button. */
export function renderFileRow(entry: FileEntry, opts: FileRowOptions): HTMLElement {
  const row = document.createElement('div');
  row.className = 'file-row';
  row.setAttribute('role', 'option');
  row.setAttribute('aria-selected', String(opts.selected));
  row.dataset.name = entry.name;
  if (opts.selected) row.classList.add('selected');
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

  row.append(icon, name, size, date, menu);
  row.addEventListener('click', () => opts.onSelect());
  row.addEventListener('dblclick', () => opts.onActivate());
  return row;
}
