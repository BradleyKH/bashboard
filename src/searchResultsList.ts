import type { LineMatch } from './searchApi';
import { highlightSegments, type FileGroup, type SearchItem, type SearchResults } from './searchModel';

export interface SearchResultsListOptions {
  onSelect: (item: SearchItem) => void;
  onOpen: (item: SearchItem) => void;
  onToggle: (path: string) => void;
}

/** A stable identity for a result row; a line appears at most once per file. */
export function itemKey(item: SearchItem): string {
  return item.kind === 'name' ? `n:${item.path}` : `m:${item.path}:${item.match.line}`;
}

function openButton(): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'search-open-btn';
  b.textContent = 'Open';
  b.title = 'Open in editor';
  b.tabIndex = -1;
  return b;
}

interface RenderedGroup {
  group: FileGroup;
  el: HTMLElement;
  chevron: HTMLElement;
}

/**
 * The results list of a Search pane (docs/design.md section 4.14). Batches only ever append
 * groups, so `update` appends the new ones and rebuilds only when a search starts over.
 * File content is untrusted: every piece of text goes in through `textContent`.
 */
export class SearchResultsList {
  readonly el: HTMLElement;
  private readonly opts: SearchResultsListOptions;
  private names: readonly string[] | null = null;
  private groups: RenderedGroup[] = [];
  private readonly byPath = new Map<string, RenderedGroup>();
  private readonly items = new Map<string, SearchItem>();
  private readonly rows = new Map<string, HTMLElement>();
  private selectedKey: string | null = null;

  constructor(opts: SearchResultsListOptions) {
    this.opts = opts;
    this.el = document.createElement('div');
    this.el.className = 'search-results';
    this.el.tabIndex = 0;
    this.el.addEventListener('click', (e) => this.onClick(e));
    this.el.addEventListener('dblclick', (e) => this.onDoubleClick(e));
  }

  /** Renders `state`; returns true when the list was rebuilt rather than appended to. */
  update(state: SearchResults): boolean {
    const rebuild = state.names !== this.names || state.groups.length < this.groups.length;
    if (rebuild) this.clear();
    this.names = state.names;
    if (rebuild && state.names.length > 0) this.el.appendChild(this.renderNames(state.names));
    if (state.groups.length > this.groups.length) {
      const frag = document.createDocumentFragment();
      for (let i = this.groups.length; i < state.groups.length; i++) {
        const rendered = this.renderGroup(state.groups[i]);
        this.groups.push(rendered);
        this.byPath.set(rendered.group.path, rendered);
        frag.appendChild(rendered.el);
      }
      this.el.appendChild(frag);
    }
    return rebuild;
  }

  has(key: string): boolean {
    return this.items.has(key);
  }

  setCollapsed(path: string, collapsed: boolean): void {
    const g = this.byPath.get(path);
    if (!g) return;
    g.el.classList.toggle('collapsed', collapsed);
    g.chevron.textContent = collapsed ? '▸' : '▾';
  }

  /** Marks one row selected (or none) and scrolls it into view. */
  select(key: string | null): void {
    if (this.selectedKey !== null) this.rows.get(this.selectedKey)?.classList.remove('selected');
    this.selectedKey = key;
    if (key === null) return;
    const row = this.rows.get(key);
    if (!row) return;
    row.classList.add('selected');
    row.scrollIntoView({ block: 'nearest' });
  }

  focus(): void {
    this.el.focus();
  }

  dispose(): void {
    this.clear();
    this.el.remove();
  }

  private clear(): void {
    this.el.replaceChildren();
    this.groups = [];
    this.byPath.clear();
    this.items.clear();
    this.rows.clear();
  }

  private renderNames(paths: readonly string[]): HTMLElement {
    const section = document.createElement('div');
    section.className = 'search-group search-names';
    const head = document.createElement('div');
    head.className = 'search-group-head';
    const title = document.createElement('span');
    title.className = 'search-group-path';
    title.textContent = 'File names';
    const count = document.createElement('span');
    count.className = 'search-group-count';
    count.textContent = String(paths.length);
    head.append(title, count);
    const rows = document.createElement('div');
    rows.className = 'search-group-rows';
    for (const path of paths) {
      const row = this.row({ kind: 'name', path });
      row.classList.add('search-name');
      const text = document.createElement('span');
      text.className = 'search-text';
      text.textContent = path;
      row.append(text, openButton());
      rows.appendChild(row);
    }
    section.append(head, rows);
    return section;
  }

  private renderGroup(group: FileGroup): RenderedGroup {
    const el = document.createElement('div');
    el.className = 'search-group';
    const head = document.createElement('div');
    head.className = 'search-group-head search-toggle';
    head.dataset.path = group.path;
    head.title = group.path;
    const chevron = document.createElement('span');
    chevron.className = 'search-chevron';
    const path = document.createElement('span');
    path.className = 'search-group-path';
    path.textContent = group.path;
    const count = document.createElement('span');
    count.className = 'search-group-count';
    count.textContent = String(group.matches.length);
    head.append(chevron, path, count, openButton());
    const rows = document.createElement('div');
    rows.className = 'search-group-rows';
    for (const match of group.matches) rows.appendChild(this.matchRow(group.path, match));
    el.append(head, rows);
    el.classList.toggle('collapsed', group.collapsed);
    chevron.textContent = group.collapsed ? '▸' : '▾';
    return { group, el, chevron };
  }

  private matchRow(path: string, match: LineMatch): HTMLElement {
    const row = this.row({ kind: 'match', path, match });
    row.classList.add('search-match');
    const line = document.createElement('span');
    line.className = 'search-line';
    line.textContent = String(match.line);
    const text = document.createElement('span');
    text.className = 'search-text';
    for (const seg of highlightSegments(match.text, match.ranges)) {
      if (seg.hit) {
        const mark = document.createElement('mark');
        mark.textContent = seg.text;
        text.appendChild(mark);
      } else {
        text.appendChild(document.createTextNode(seg.text));
      }
    }
    row.append(line, text, openButton());
    return row;
  }

  private row(item: SearchItem): HTMLElement {
    const key = itemKey(item);
    const row = document.createElement('div');
    row.className = 'search-row';
    row.dataset.key = key;
    if (key === this.selectedKey) row.classList.add('selected');
    this.items.set(key, item);
    this.rows.set(key, row);
    return row;
  }

  private itemAt(e: Event): SearchItem | null {
    const row = (e.target as HTMLElement).closest<HTMLElement>('.search-row');
    const key = row?.dataset.key;
    return key === undefined ? null : (this.items.get(key) ?? null);
  }

  private onClick(e: MouseEvent): void {
    const target = e.target as HTMLElement;
    if (target.closest('.search-open-btn')) {
      // A group head's button opens the file at its top.
      const groupPath = target.closest<HTMLElement>('.search-toggle')?.dataset.path;
      const item = groupPath !== undefined ? { kind: 'name' as const, path: groupPath } : this.itemAt(e);
      if (item) this.opts.onOpen(item);
      return;
    }
    const head = (e.target as HTMLElement).closest<HTMLElement>('.search-toggle');
    if (head?.dataset.path !== undefined) {
      this.opts.onToggle(head.dataset.path);
      return;
    }
    const item = this.itemAt(e);
    if (item) this.opts.onSelect(item);
  }

  private onDoubleClick(e: MouseEvent): void {
    if ((e.target as HTMLElement).closest('.search-open-btn')) return;
    const item = this.itemAt(e);
    if (item) this.opts.onOpen(item);
  }
}
