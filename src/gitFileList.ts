import type { GitRow } from './gitModel';

export interface GitFileListOptions {
  title: string;
  /** True for the Staged list: rows offer Unstage and the header Unstage all. */
  staged: boolean;
  /** A row was clicked; the caller shows its diff. */
  onSelect: (row: GitRow) => void;
  /** The hover Stage or Unstage button on one row. */
  onToggle: (row: GitRow) => void;
  /** The header button, with every row currently listed. */
  onToggleAll: (rows: readonly GitRow[]) => void;
  /** The hover Open in editor button. */
  onOpen: (row: GitRow) => void;
}

/** A titled list of changed files (docs/design.md section 4.13). */
export class GitFileList {
  readonly el: HTMLElement;
  private readonly count: HTMLElement;
  private readonly allBtn: HTMLButtonElement;
  private readonly list: HTMLElement;
  private rows: GitRow[] = [];
  private selectedKey: string | null = null;

  constructor(private readonly opts: GitFileListOptions) {
    this.el = document.createElement('div');
    this.el.className = 'git-files';

    const head = document.createElement('div');
    head.className = 'git-section-head';
    const title = document.createElement('span');
    title.className = 'git-section-title';
    title.textContent = opts.title;
    this.count = document.createElement('span');
    this.count.className = 'git-section-count';
    this.allBtn = document.createElement('button');
    this.allBtn.type = 'button';
    this.allBtn.className = 'git-section-btn';
    this.allBtn.textContent = opts.staged ? 'Unstage all' : 'Stage all';
    this.allBtn.addEventListener('click', () => this.opts.onToggleAll(this.rows));
    head.append(title, this.count, this.allBtn);

    this.list = document.createElement('div');
    this.list.className = 'git-rows';
    this.list.setAttribute('role', 'listbox');

    this.el.append(head, this.list);
    this.render();
  }

  /** Replaces the rows; a selected key no longer present highlights nothing. */
  setRows(rows: readonly GitRow[]): void {
    this.rows = [...rows];
    this.render();
  }

  /** Highlights the row with this key (`GitRow.key`) without firing `onSelect`; null clears. */
  select(key: string | null): void {
    this.selectedKey = key;
    this.render();
  }

  selectedRow(): GitRow | null {
    return this.rows.find((r) => r.key === this.selectedKey) ?? null;
  }

  private render(): void {
    this.count.textContent = this.rows.length > 0 ? String(this.rows.length) : '';
    this.allBtn.disabled = this.rows.length === 0;
    if (this.rows.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'git-empty';
      empty.textContent = 'Nothing here';
      this.list.replaceChildren(empty);
      return;
    }
    this.list.replaceChildren(...this.rows.map((row) => this.renderRow(row)));
  }

  private renderRow(row: GitRow): HTMLElement {
    const { entry } = row;
    const el = document.createElement('div');
    el.className = 'git-row';
    if (row.key === this.selectedKey) el.classList.add('selected');
    el.setAttribute('role', 'option');
    el.addEventListener('click', () => {
      this.selectedKey = row.key;
      this.render();
      this.opts.onSelect(row);
    });

    const status = document.createElement('span');
    status.className = `git-status git-status-${entry.status === '?' ? 'new' : entry.status.toLowerCase()}`;
    status.textContent = entry.status;

    const path = document.createElement('span');
    path.className = 'git-row-path';
    path.textContent = entry.origPath ? `${entry.origPath} -> ${entry.path}` : entry.path;
    path.title = path.textContent;

    const actions = document.createElement('span');
    actions.className = 'git-row-actions';
    if (entry.status !== 'D') {
      actions.append(this.action('Open', 'Open in editor', () => this.opts.onOpen(row)));
    }
    actions.append(
      this.opts.staged
        ? this.action('Unstage', 'Unstage this file', () => this.opts.onToggle(row))
        : this.action('Stage', 'Stage this file', () => this.opts.onToggle(row)),
    );

    el.append(status, path, actions);
    return el;
  }

  private action(label: string, title: string, run: () => void): HTMLButtonElement {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'git-row-btn';
    b.textContent = label;
    b.title = title;
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      run();
    });
    return b;
  }
}
