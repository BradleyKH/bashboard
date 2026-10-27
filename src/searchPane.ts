import './searchPane.css';
import { openInEditor } from './editors';
import { samePath } from './favorites';
import { lookup, type Action, type Keymap } from './keymap';
import type { CellSize } from './layout';
import { toFontFamily } from './pane';
import type { PaneView } from './paneView';
import { repoRoot } from './repoFiles';
import {
  absolutePath,
  emptyResults,
  flatten,
  footerText,
  stepSelection,
  toggleGroup,
  type SearchItem,
  type SearchResults,
} from './searchModel';
import type { SearchOptions } from './searchOptions';
import { SearchPreview } from './searchPreview';
import { itemKey, SearchResultsList } from './searchResultsList';
import { SearchRunner } from './searchRunner';
import type { Settings } from './settings';
import { textFieldOwns } from './textPaneKeys';

export interface SearchPaneOptions {
  host: HTMLElement;
  paneId: string;
  settings: Settings;
  /** The repo root, or a folder inside it (the pane adopts the resolved root). */
  root: string;
  /** A non-empty query runs as soon as the root is resolved, which is how restore reruns it. */
  query: string;
  options: SearchOptions;
  expanded: boolean;
  keymap: () => Keymap;
  dispatch: (action: Action) => boolean;
  onFocus: () => void;
  /** The root, query, or options changed (title and saved state follow). */
  onChange: () => void;
}

const MIN_SPLIT = 0.15;
const MAX_SPLIT = 0.85;

function baseName(p: string): string {
  const parts = p.split(/[\\/]+/).filter((s) => s !== '');
  return parts.length > 0 ? parts[parts.length - 1] : p;
}

type ToggleName = 'caseSensitive' | 'wholeWord' | 'regex';

const TOGGLES: ReadonlyArray<{ name: ToggleName; label: string; title: string }> = [
  { name: 'caseSensitive', label: 'Aa', title: 'Match case' },
  { name: 'wholeWord', label: 'ab', title: 'Whole word' },
  { name: 'regex', label: '.*', title: 'Regex' },
];

/** Code search over a repo (docs/design.md section 4.14). */
export class SearchPane implements PaneView {
  readonly kind = 'search' as const;
  readonly paneId: string;
  private readonly opts: SearchPaneOptions;
  private readonly host: HTMLElement;
  private readonly body: HTMLElement;
  private readonly queryField: HTMLInputElement;
  private readonly includeField: HTMLInputElement;
  private readonly toggleButtons = new Map<ToggleName, HTMLButtonElement>();
  private readonly error: HTMLElement;
  private readonly split: HTMLElement;
  private readonly left: HTMLElement;
  private readonly divider: HTMLElement;
  private readonly footer: HTMLElement;
  private readonly results: SearchResultsList;
  private readonly preview: SearchPreview;
  private readonly runner: SearchRunner;
  private settings: Settings;
  private rootPath: string;
  private query: string;
  private options: SearchOptions;
  /** Searches wait for the root to resolve, since result paths are relative to it. */
  private ready = false;
  private state: SearchResults = emptyResults();
  private readonly collapsed = new Set<string>();
  private selectedKey: string | null = null;
  private splitFraction = 0.4;
  private disposed = false;
  private readonly listeners: Array<() => void> = [];

  constructor(opts: SearchPaneOptions) {
    this.opts = opts;
    this.host = opts.host;
    this.paneId = opts.paneId;
    this.settings = opts.settings;
    this.rootPath = opts.root;
    this.query = opts.query;
    this.options = { ...opts.options };

    this.host.style.display = 'flex';
    this.host.style.flexDirection = 'column';
    this.body = document.createElement('div');
    this.body.className = 'pane-body search-body';
    this.body.tabIndex = -1;

    const bar = document.createElement('div');
    bar.className = 'search-bar';
    const queryRow = document.createElement('div');
    queryRow.className = 'search-bar-row';
    this.queryField = document.createElement('input');
    this.queryField.type = 'text';
    this.queryField.className = 'search-field search-query';
    this.queryField.placeholder = 'Search';
    this.queryField.setAttribute('aria-label', 'Search');
    this.queryField.spellcheck = false;
    this.queryField.value = this.query;
    queryRow.appendChild(this.queryField);
    for (const t of TOGGLES) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'search-toggle-btn';
      b.textContent = t.label;
      b.title = t.title;
      b.setAttribute('aria-label', t.title);
      b.setAttribute('aria-pressed', String(this.options[t.name]));
      this.listen(b, 'click', () => this.flip(t.name));
      this.toggleButtons.set(t.name, b);
      queryRow.appendChild(b);
    }
    this.includeField = document.createElement('input');
    this.includeField.type = 'text';
    this.includeField.className = 'search-field search-include';
    this.includeField.placeholder = 'Files to include (e.g. *.ts, src/**)';
    this.includeField.setAttribute('aria-label', 'Files to include');
    this.includeField.title = 'Files to include: comma-separated globs';
    this.includeField.spellcheck = false;
    this.includeField.value = this.options.include;
    bar.append(queryRow, this.includeField);

    this.error = document.createElement('div');
    this.error.className = 'search-error';
    this.error.hidden = true;

    this.split = document.createElement('div');
    this.split.className = 'search-split';
    this.left = document.createElement('div');
    this.left.className = 'search-left';
    this.results = new SearchResultsList({
      onSelect: (item) => this.select(item),
      onOpen: (item) => this.open(item),
      onToggle: (path) => this.toggle(path),
    });
    this.left.appendChild(this.results.el);
    this.divider = document.createElement('div');
    this.divider.className = 'search-divider';
    const right = document.createElement('div');
    right.className = 'search-right';
    this.preview = new SearchPreview({
      settings: this.settings,
      onOpenInEditor: (path, line) => void openInEditor(path, line ?? undefined),
    });
    right.appendChild(this.preview.el);
    this.split.append(this.left, this.divider, right);

    this.footer = document.createElement('div');
    this.footer.className = 'search-footer';

    this.body.append(bar, this.error, this.split, this.footer);
    this.host.appendChild(this.body);
    this.applySplit();
    this.applyFont();

    this.runner = new SearchRunner({ onChange: (s) => this.onResults(s) });

    this.listen(this.host, 'focusin', () => opts.onFocus());
    this.listen(this.host, 'keydown', (e) => this.onKeyDown(e as KeyboardEvent));
    this.listen(this.queryField, 'input', () => {
      this.query = this.queryField.value;
      this.edited();
    });
    this.listen(this.includeField, 'input', () => {
      this.options = { ...this.options, include: this.includeField.value };
      this.edited();
    });
    this.listen(this.queryField, 'keydown', (e) => this.onFieldKey(e as KeyboardEvent, true));
    this.listen(this.includeField, 'keydown', (e) => this.onFieldKey(e as KeyboardEvent, false));
    this.listen(this.results.el, 'keydown', (e) => this.onListKey(e as KeyboardEvent));
    this.listen(this.results.el, 'focus', () => this.onListFocus());
    this.listen(this.divider, 'pointerdown', (e) => this.startDrag(e as PointerEvent));

    this.renderFooter();
    void this.init();
  }

  /** The repo root, which is the pane's folder. */
  get folder(): string {
    return this.rootPath;
  }

  root(): string {
    return this.rootPath;
  }

  /** The repo folder's name, for the title strip. */
  title(): string {
    return baseName(this.rootPath);
  }

  /** The `search` saved-pane fields. */
  saved(): { root: string; query: string; options: SearchOptions } {
    return { root: this.rootPath, query: this.query, options: { ...this.options } };
  }

  /** Focuses the query field. */
  focus(): void {
    this.queryField.focus();
  }

  setExpanded(_expanded: boolean): void {}

  applySettings(settings: Settings): void {
    this.settings = settings;
    this.applyFont();
    this.preview.applySettings(settings);
  }

  cellSize(): CellSize {
    const probe = document.createElement('span');
    probe.textContent = 'M'.repeat(10);
    probe.style.cssText = 'position: absolute; visibility: hidden; white-space: pre;';
    probe.style.fontFamily = toFontFamily(this.settings.font.family);
    probe.style.fontSize = `${this.settings.font.size}px`;
    this.body.appendChild(probe);
    const width = probe.getBoundingClientRect().width / 10;
    const probeHeight = probe.getBoundingClientRect().height;
    probe.remove();
    const row = this.body.querySelector<HTMLElement>('.search-row');
    const height = row?.offsetHeight || probeHeight || this.settings.font.size * 1.2;
    return {
      width,
      height,
      // Everything outside the body: borders and the title strip.
      padX: Math.max(0, this.host.offsetWidth - this.body.clientWidth) + 1,
      padY: Math.max(0, this.host.offsetHeight - this.body.clientHeight) + 1,
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.runner.dispose();
    this.results.dispose();
    this.preview.dispose();
    for (const off of this.listeners) off();
    this.listeners.length = 0;
    this.body.remove();
  }

  private async init(): Promise<void> {
    const asked = this.rootPath;
    try {
      const info = await repoRoot(asked);
      if (this.disposed) return;
      if (!samePath(info.root, asked)) {
        this.rootPath = info.root;
        this.opts.onChange();
      }
    } catch {
      // Not resolvable: search the given folder, and let the core report a bad path inline.
      if (this.disposed) return;
    }
    this.ready = true;
    if (this.query !== '') this.run(true);
  }

  private flip(name: ToggleName): void {
    this.options = { ...this.options, [name]: !this.options[name] };
    this.toggleButtons.get(name)?.setAttribute('aria-pressed', String(this.options[name]));
    this.edited();
  }

  private edited(): void {
    this.opts.onChange();
    this.run(false);
  }

  private run(now: boolean): void {
    if (!this.ready || this.disposed) return;
    this.preview.invalidate();
    if (now) this.runner.runNow(this.rootPath, this.query, this.options);
    else this.runner.schedule(this.rootPath, this.query, this.options);
    // An empty query clears synchronously, which the runner reports without a change in `done`.
    this.renderFooter();
  }

  private onResults(state: SearchResults): void {
    this.state = state;
    if (this.results.update(state)) this.collapsed.clear();
    // A rerun starts empty, so the selection is dropped only once the run ends without its row.
    if (state.done && this.selectedKey !== null && !this.results.has(this.selectedKey)) {
      this.selectedKey = null;
      this.results.select(null);
      void this.preview.show(null);
    }
    this.error.textContent = state.error ?? '';
    this.error.hidden = state.error === null;
    this.renderFooter();
  }

  private renderFooter(): void {
    let text = '';
    if (this.state.error === null && this.query !== '') {
      text = footerText(this.state) || 'Searching...';
    }
    this.footer.textContent = text;
  }

  /** The results with the pane's collapsed groups applied, for navigation. */
  private viewState(): SearchResults {
    let s = this.state;
    for (const path of this.collapsed) s = toggleGroup(s, path);
    return s;
  }

  private toggle(path: string): void {
    const collapsed = !this.collapsed.has(path);
    if (collapsed) this.collapsed.add(path);
    else this.collapsed.delete(path);
    this.results.setCollapsed(path, collapsed);
    if (collapsed && this.selectedKey?.startsWith(`m:${path}:`)) {
      this.selectedKey = null;
      this.results.select(null);
    }
  }

  private select(item: SearchItem): void {
    this.selectedKey = itemKey(item);
    this.results.select(this.selectedKey);
    void this.preview.show(absolutePath(this.rootPath, item.path), item.kind === 'match' ? item.match.line : null);
  }

  private step(delta: number): void {
    const items = flatten(this.viewState());
    const at = this.selectedKey === null ? -1 : items.findIndex((i) => itemKey(i) === this.selectedKey);
    const next = stepSelection(items, at < 0 ? null : at, delta);
    if (next !== null) this.select(items[next]);
  }

  private open(item: SearchItem): void {
    const path = absolutePath(this.rootPath, item.path);
    void openInEditor(path, item.kind === 'match' ? item.match.line : undefined);
  }

  private openSelected(): void {
    if (this.selectedKey === null) return;
    const item = flatten(this.viewState()).find((i) => itemKey(i) === this.selectedKey);
    if (item) this.open(item);
  }

  private onFieldKey(e: KeyboardEvent, isQuery: boolean): void {
    if (e.ctrlKey || e.altKey || e.metaKey || e.shiftKey) return;
    if (e.key === 'Enter') {
      this.run(true);
    } else if (isQuery && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
      this.step(e.key === 'ArrowDown' ? 1 : -1);
    } else {
      return;
    }
    e.preventDefault();
  }

  /** Keyboard focus on the list keeps the current selection, or selects the first result when there is none. */
  private onListFocus(): void {
    if (this.selectedKey !== null || !this.results.el.matches(':focus-visible')) return;
    this.step(1);
  }

  private onListKey(e: KeyboardEvent): void {
    if (e.ctrlKey || e.altKey || e.metaKey || e.shiftKey) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') this.step(e.key === 'ArrowDown' ? 1 : -1);
    else if (e.key === 'Enter') this.openSelected();
    else return;
    e.preventDefault();
  }

  private onKeyDown(e: KeyboardEvent): void {
    // The fields and the list already handled their own navigation keys.
    if (e.defaultPrevented) return;
    const action = lookup(this.opts.keymap(), e);
    if (action && !textFieldOwns(action) && this.opts.dispatch(action)) {
      e.preventDefault();
      e.stopPropagation();
    }
  }

  private applyFont(): void {
    this.body.style.setProperty('--search-code-font', toFontFamily(this.settings.font.family));
    this.body.style.setProperty('--search-code-size', `${this.settings.font.size}px`);
  }

  private applySplit(): void {
    this.left.style.flexBasis = `${this.splitFraction * 100}%`;
  }

  private startDrag(e: PointerEvent): void {
    if (e.button !== 0) return;
    e.preventDefault();
    this.divider.setPointerCapture(e.pointerId);
    this.divider.classList.add('dragging');
    const move = (ev: PointerEvent) => {
      const r = this.split.getBoundingClientRect();
      if (r.width <= 0) return;
      this.splitFraction = Math.min(MAX_SPLIT, Math.max(MIN_SPLIT, (ev.clientX - r.left) / r.width));
      this.applySplit();
    };
    const up = () => {
      this.divider.classList.remove('dragging');
      this.divider.removeEventListener('pointermove', move);
      this.divider.removeEventListener('pointerup', up);
      this.divider.removeEventListener('pointercancel', up);
    };
    this.divider.addEventListener('pointermove', move);
    this.divider.addEventListener('pointerup', up);
    this.divider.addEventListener('pointercancel', up);
  }

  private listen(target: EventTarget, type: string, fn: (e: Event) => void): void {
    target.addEventListener(type, fn);
    this.listeners.push(() => target.removeEventListener(type, fn));
  }
}
