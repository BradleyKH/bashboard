import type { FileTrust } from './browserApi';
import { deviceLabel, devicePreset, type DeviceState } from './browserPaneModel';
import { openContextMenu } from './contextMenu';
import { item, separator, type MenuEntry } from './contextMenuModel';
import { DEVICE_PRESETS } from './devicePresets';
import { getHomeDir } from './displayPath';
import {
  hostLabel,
  normalizeInput,
  suggestions,
  type Bookmark,
  type Suggestion,
  type SuggestionInputs,
} from './localBrowserModel';

const SUGGESTION_LIMIT = 8;
const SOURCE_LABEL: Record<Suggestion['source'], string> = { bookmark: 'Bookmark', port: 'Port', recent: 'Recent' };

export interface BrowserToolbarOptions {
  /** The app's own origin, which the URL field refuses. */
  appOrigin: string | null;
  suggestionInputs: () => SuggestionInputs;
  bookmarks: () => readonly Bookmark[];
  device: () => DeviceState;
  onBack: () => void;
  onForward: () => void;
  /** `hard` skips the cache (Shift+click). */
  onReload: (hard: boolean) => void;
  onHome: () => void;
  onNavigate: (url: string) => void;
  onToggleBookmark: () => void;
  onDevice: (device: DeviceState) => void;
  onToggleDevtools: () => void;
}

const TRUST_LABEL: Record<FileTrust, string> = { trusted: 'Trusted', local: 'Local', downloaded: 'Downloaded' };
// One sentence per level, matching the trust table in docs/design/browser.md section 3.21.
const TRUST_TIP: Record<FileTrust, string> = {
  trusted: 'Trusted: this file is in a trusted folder, so it can reach any host.',
  local:
    'Local: this file can load from its own folder and common CDNs only; other hosts are refused until you allow them.',
  downloaded:
    'Downloaded: Windows marked this file as from the internet, so it can reach only its own folder and common CDNs, and allowing a host asks first.',
};

/** The Local Browser's chrome: navigation buttons, the URL field with suggestions, bookmarks, device size, DevTools. */
export class BrowserToolbar {
  readonly element: HTMLElement;
  private readonly opts: BrowserToolbarOptions;
  private readonly input: HTMLInputElement;
  private readonly suggestBox: HTMLElement;
  private readonly message: HTMLElement;
  private readonly back: HTMLButtonElement;
  private readonly forward: HTMLButtonElement;
  private readonly reload: HTMLButtonElement;
  private readonly star: HTMLButtonElement;
  private readonly deviceBtn: HTMLButtonElement;
  private readonly devtoolsBtn: HTMLButtonElement;
  private readonly badge: HTMLElement;
  private readonly trustBadge: HTMLElement;
  /**
   * What the field shows whenever the user is not editing it: a file page's path, else the URL. The
   * suggestions treat it as the unedited value.
   */
  private shownText = '';
  private shown: Suggestion[] = [];
  private highlighted = -1;
  private messageTimer = 0;

  constructor(opts: BrowserToolbarOptions) {
    this.opts = opts;
    this.element = document.createElement('div');
    this.element.className = 'lb-toolbar';

    this.back = this.iconButton('←', 'Back', () => opts.onBack());
    this.forward = this.iconButton('→', 'Forward', () => opts.onForward());
    this.reload = this.iconButton('↻', 'Reload (Shift+click to bypass the cache)', (e) => opts.onReload(e.shiftKey));
    const home = this.iconButton('⌂', 'Home', () => opts.onHome());

    const field = document.createElement('div');
    field.className = 'lb-url';
    this.input = document.createElement('input');
    this.input.type = 'text';
    this.input.className = 'lb-url-input';
    this.input.placeholder = 'Port or localhost address, like 5173 or localhost:3000/app';
    this.input.spellcheck = false;
    this.input.autocomplete = 'off';
    this.input.setAttribute('aria-label', 'Address');
    this.star = this.iconButton('☆', 'Bookmark this page', () => opts.onToggleBookmark());
    this.star.classList.add('lb-star');
    this.suggestBox = document.createElement('div');
    this.suggestBox.className = 'lb-suggest';
    this.suggestBox.hidden = true;
    this.suggestBox.setAttribute('role', 'listbox');
    this.message = document.createElement('div');
    this.message.className = 'lb-url-message';
    this.message.hidden = true;
    this.trustBadge = document.createElement('span');
    this.trustBadge.className = 'lb-trust';
    this.trustBadge.hidden = true;
    field.append(this.trustBadge, this.input, this.star, this.suggestBox, this.message);

    const bookmarksBtn = this.textButton('Bookmarks ▾', 'Open a bookmark', (b) => this.openBookmarks(b));
    this.deviceBtn = this.textButton('', 'Device size', (b) => this.openDevices(b));
    this.badge = document.createElement('span');
    this.badge.className = 'lb-badge';
    this.badge.hidden = true;
    this.devtoolsBtn = this.textButton('DevTools', 'Show or hide the Console and Network drawer', () => opts.onToggleDevtools());
    this.devtoolsBtn.append(this.badge);

    this.element.append(this.back, this.forward, this.reload, home, field, bookmarksBtn, this.deviceBtn, this.devtoolsBtn);

    this.input.addEventListener('focus', () => {
      this.input.select();
      this.showSuggestions();
    });
    this.input.addEventListener('input', () => {
      this.setMessage(null);
      this.showSuggestions();
    });
    this.input.addEventListener('blur', () => {
      this.hideSuggestions();
      this.input.value = this.shownText;
    });
    this.input.addEventListener('keydown', (e) => this.onKeyDown(e));
    // Keeps the field focused through a click on a suggestion, so blur does not hide it first.
    this.suggestBox.addEventListener('mousedown', (e) => e.preventDefault());

    this.setPage(null);
    this.setDevice(opts.device());
  }

  /**
   * The page shown, or null on the start page; the field follows unless it is being edited.
   * `display` is what the field shows in place of `url`, as a file page's path in place of its
   * loopback serving address.
   */
  setPage(url: string | null, display?: string): void {
    this.shownText = display ?? url ?? '';
    if (document.activeElement !== this.input) this.input.value = this.shownText;
    const hasPage = url !== null;
    this.back.disabled = !hasPage;
    this.forward.disabled = !hasPage;
    this.reload.disabled = !hasPage;
    this.star.disabled = !hasPage;
  }

  setLoading(loading: boolean): void {
    this.element.classList.toggle('loading', loading);
  }

  setBookmarked(bookmarked: boolean): void {
    this.star.textContent = bookmarked ? '★' : '☆';
    this.star.classList.toggle('active', bookmarked);
    this.star.title = bookmarked ? 'Remove this bookmark' : 'Bookmark this page';
  }

  /** The trust level of the file page shown; null for a loopback page, which has none. */
  setTrust(trust: FileTrust | null): void {
    this.trustBadge.hidden = trust === null;
    this.trustBadge.dataset.trust = trust ?? '';
    this.trustBadge.textContent = trust === null ? '' : TRUST_LABEL[trust];
    this.trustBadge.title = trust === null ? '' : TRUST_TIP[trust];
  }

  setErrorCount(n: number): void {
    this.badge.hidden = n === 0;
    this.badge.textContent = n > 99 ? '99+' : String(n);
    this.badge.title = `${n} console ${n === 1 ? 'error' : 'errors'}`;
  }

  setDevtoolsOpen(open: boolean): void {
    this.devtoolsBtn.classList.toggle('active', open);
  }

  setDevice(device: DeviceState): void {
    const label = deviceLabel(device);
    this.deviceBtn.firstChild!.textContent = `${label} ▾`;
    this.deviceBtn.classList.toggle('active', label !== 'Responsive');
  }

  focusUrl(): void {
    this.input.focus();
  }

  /** An inline note under the URL field, such as why an address was refused; null hides it. */
  setMessage(text: string | null, timeoutMs = 0): void {
    window.clearTimeout(this.messageTimer);
    this.message.hidden = text === null;
    this.message.textContent = text ?? '';
    if (text !== null && timeoutMs > 0) this.messageTimer = window.setTimeout(() => this.setMessage(null), timeoutMs);
  }

  dispose(): void {
    window.clearTimeout(this.messageTimer);
  }

  private onKeyDown(e: KeyboardEvent): void {
    let handled = true;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (this.suggestBox.hidden) this.showSuggestions();
      if (this.shown.length > 0) {
        const n = this.shown.length;
        const step = e.key === 'ArrowDown' ? 1 : -1;
        this.highlight(this.highlighted < 0 ? (step > 0 ? 0 : n - 1) : (this.highlighted + step + n) % n);
      }
    } else if (e.key === 'Enter') {
      const picked = this.highlighted >= 0 ? this.shown[this.highlighted] : undefined;
      if (picked) this.go(picked.url);
      else this.submit();
    } else if (e.key === 'Escape') {
      if (!this.suggestBox.hidden) this.hideSuggestions();
      else {
        this.input.value = this.shownText;
        this.input.select();
      }
      this.setMessage(null);
    } else {
      handled = false;
    }
    if (handled) {
      e.preventDefault();
      e.stopPropagation();
    }
  }

  private submit(): void {
    const r = normalizeInput(this.input.value, this.opts.appOrigin, getHomeDir());
    if (!r.ok) {
      this.hideSuggestions();
      this.setMessage(r.reason);
      return;
    }
    this.go(r.url, r.file ? r.path : r.url);
  }

  /** `shown` is what the field keeps while it stays focused, which a file's path replaces its URL with. */
  private go(url: string, shown: string = url): void {
    this.hideSuggestions();
    this.setMessage(null);
    this.input.value = shown;
    this.opts.onNavigate(url);
  }

  private showSuggestions(): void {
    const query = this.input.value === this.shownText ? '' : this.input.value;
    this.shown = suggestions(query, this.opts.suggestionInputs()).slice(0, SUGGESTION_LIMIT);
    this.highlighted = -1;
    if (this.shown.length === 0) {
      this.hideSuggestions();
      return;
    }
    this.suggestBox.replaceChildren(
      ...this.shown.map((s, i) => {
        const row = document.createElement('div');
        row.className = 'lb-suggest-row';
        row.setAttribute('role', 'option');
        const label = document.createElement('span');
        label.className = 'lb-suggest-label';
        label.textContent = s.label;
        const url = document.createElement('span');
        url.className = 'lb-suggest-url';
        url.textContent = s.source === 'recent' ? '' : hostLabel(s.url);
        const source = document.createElement('span');
        source.className = 'lb-suggest-source';
        source.textContent = SOURCE_LABEL[s.source];
        row.append(label, url, source);
        row.addEventListener('mouseenter', () => this.highlight(i));
        row.addEventListener('click', () => this.go(s.url));
        return row;
      }),
    );
    this.suggestBox.hidden = false;
  }

  private hideSuggestions(): void {
    this.suggestBox.hidden = true;
    this.shown = [];
    this.highlighted = -1;
  }

  private highlight(i: number): void {
    this.highlighted = i;
    const rows = this.suggestBox.children;
    for (let k = 0; k < rows.length; k++) rows[k].classList.toggle('active', k === i);
    rows[i]?.scrollIntoView({ block: 'nearest' });
  }

  private openBookmarks(anchor: HTMLElement): void {
    const marks = this.opts.bookmarks();
    const entries: MenuEntry[] =
      marks.length === 0
        ? [item('No bookmarks yet. Use the star in the address field to add one.', () => {}, { enabled: false })]
        : marks.map((b) => item(b.name || hostLabel(b.url), () => this.go(b.url)));
    openContextMenu(entries, { anchorEl: anchor, align: 'right' });
  }

  private openDevices(anchor: HTMLElement): void {
    const current = this.opts.device();
    const fixed = devicePreset(current).width !== null;
    const entries: MenuEntry[] = [
      ...DEVICE_PRESETS.map((p) =>
        item(p.label, () => this.opts.onDevice({ id: p.id, rotated: p.id === current.id && current.rotated }), {
          checked: p.id === current.id,
        }),
      ),
      separator(),
      item('Rotate', () => this.opts.onDevice({ id: current.id, rotated: !current.rotated }), { enabled: fixed }),
    ];
    openContextMenu(entries, { anchorEl: anchor, align: 'right' });
  }

  private iconButton(glyph: string, title: string, onClick: (e: MouseEvent) => void): HTMLButtonElement {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'lb-icon-btn';
    b.textContent = glyph;
    b.title = title;
    b.setAttribute('aria-label', title);
    b.addEventListener('click', onClick);
    return b;
  }

  private textButton(label: string, title: string, onClick: (b: HTMLButtonElement) => void): HTMLButtonElement {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'lb-btn lb-tool-btn';
    b.append(document.createTextNode(label));
    b.title = title;
    b.addEventListener('click', () => onClick(b));
    return b;
  }
}
