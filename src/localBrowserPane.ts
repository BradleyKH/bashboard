// The Local Browser pane: a sandboxed iframe on a loopback dev server, driven by the Rust CDP bridge
// (docs/design/browser.md section 4.21).
import './localBrowser.css';
import * as browserApi from './browserApi';
import { BrowserDevtools } from './browserDevtools';
import {
  blockedNotice,
  devicePreset,
  formatDevice,
  isBlankUrl,
  isErrorPageUrl,
  normalizeDevtools,
  parseDevice,
  unreachableMessage,
  type DeviceState,
  type DevtoolsState,
  type TlsProbe,
} from './browserPaneModel';
import { BrowserToolbar } from './browserToolbar';
import type { BrowserEvent } from './devtoolsModel';
import { fitScale } from './devicePresets';
import { lookup, type Action, type Keymap } from './keymap';
import type { CellSize } from './layout';
import { KEEP_ALIVE_ATTR } from './layoutView';
import { hostLabel, isBookmarked, normalizeInput, RecentUrls, toggleBookmark, type Bookmark } from './localBrowserModel';
import { toFontFamily } from './pane';
import type { PaneView } from './paneView';
import type { Listener } from './ports';
import { localUrl, processLabel } from './portsModel';
import { saveSetting, type Settings } from './settings';

const NOTICE_MS = 5000;
const START_REFRESH_MS = 3000;
/** How long after a `blocked` event an error page is taken to be that navigation's, not a dead server. */
const BLOCKED_ERROR_MS = 3000;
// Mirrors the Overview's sandbox: no popups and no top navigation, so a page cannot escape its frame.
const SANDBOX = 'allow-scripts allow-forms allow-same-origin allow-modals';

/** Shared by every Local Browser pane for URL suggestions; not saved across launches. */
const recent = new RecentUrls();

export interface LocalBrowserSavedState {
  url: string | null;
  devtools: DevtoolsState;
  /** A device preset id, with `:rotated` when turned on its side. */
  device: string;
}

export interface LocalBrowserPaneOptions {
  host: HTMLElement;
  paneId: string;
  /** The page to open, null for the start page, or undefined for `localBrowser.homeUrl`. */
  url?: string | null;
  devtools?: Partial<DevtoolsState>;
  device?: string;
  settings: Settings;
  expanded: boolean;
  keymap: () => Keymap;
  dispatch: (action: Action) => boolean;
  onFocus: () => void;
  /** Listening ports, for the start page and URL suggestions. */
  listeners: () => Listener[];
  /** Opens a non-local address the page tried to visit in the system browser. */
  onOpenExternal: (url: string) => void;
  /** The URL, title, drawer, or device changed (title and saved state follow). */
  onStateChange: () => void;
  /** Whether the pane needs the shared listening-ports list (true while expanded, false once hidden or disposed). */
  onWantPorts?: (wanted: boolean) => void;
}

/**
 * A browser pane limited to loopback dev servers (docs/design/browser.md section 4.21). The page
 * runs in a sandboxed iframe that the Rust CDP bridge watches and polices; the pane learns the
 * page's URL and title only from bridge events and never reads the frame.
 */
export class LocalBrowserPane implements PaneView {
  readonly kind = 'browser' as const;
  readonly paneId: string;
  readonly folder = null;
  private readonly opts: LocalBrowserPaneOptions;
  private readonly host: HTMLElement;
  private readonly body: HTMLElement;
  private readonly toolbar: BrowserToolbar;
  private readonly notice: HTMLElement;
  private readonly stage: HTMLElement;
  private readonly deviceBox: HTMLElement;
  private readonly frame: HTMLIFrameElement;
  private readonly startPage: HTMLElement;
  private readonly errorPage: HTMLElement;
  private readonly devtools: BrowserDevtools;
  private readonly resizeObserver: ResizeObserver;
  private readonly appOrigin: string | null;
  private settings: Settings;
  private bookmarks: readonly Bookmark[];
  private device: DeviceState;
  /** What the frame shows, from bridge events; before the first event, the URL it was sent to. */
  private url: string | null = null;
  /** The last URL this pane asked the frame to load, for Retry and the unreachable notice. */
  private requested: string | null = null;
  private pageTitle = '';
  /** Document request ids, so a failed one can show the unreachable notice. */
  private readonly documentRequests = new Map<string, string>();
  /** The last navigation the bridge blocked, whose error page and failed request are not "nothing is listening". */
  private lastBlocked: { url: string; at: number } | null = null;
  /** Bumped by each failure and each committed page, so a late TLS probe can't show a stale overlay. */
  private unreachableSeq = 0;
  private readonly attached: Promise<void>;
  private frameFocused = false;
  private noticeTimer = 0;
  private startTimer = 0;
  private expanded: boolean;
  private disposed = false;
  private readonly listeners: Array<() => void> = [];

  constructor(opts: LocalBrowserPaneOptions) {
    this.opts = opts;
    this.host = opts.host;
    this.paneId = opts.paneId;
    this.settings = opts.settings;
    this.bookmarks = opts.settings.localBrowser.bookmarks;
    this.device = parseDevice(opts.device);
    this.expanded = opts.expanded;
    this.appOrigin = typeof window === 'undefined' ? null : window.location.origin;

    this.host.style.display = 'flex';
    this.host.style.flexDirection = 'column';
    // Off screen the host waits in a hidden park instead of leaving the document, which would
    // reload the page from the frame's original src and lose its state.
    this.host.setAttribute(KEEP_ALIVE_ATTR, '');
    this.body = document.createElement('div');
    this.body.className = 'pane-body lb-body';
    this.body.tabIndex = -1;

    this.toolbar = new BrowserToolbar({
      appOrigin: this.appOrigin,
      suggestionInputs: () => ({ bookmarks: this.bookmarks, listeners: opts.listeners(), recent: recent.list() }),
      bookmarks: () => this.bookmarks,
      device: () => this.device,
      onBack: () => this.history(-1),
      onForward: () => this.history(1),
      onReload: (hard) => this.reload(hard),
      onHome: () => this.home(),
      onNavigate: (url) => this.navigate(url),
      onToggleBookmark: () => this.toggleBookmark(),
      onDevice: (d) => this.setDevice(d),
      onToggleDevtools: () => this.devtools.toggle(),
    });

    this.notice = document.createElement('div');
    this.notice.className = 'lb-notice';
    this.notice.hidden = true;

    this.stage = document.createElement('div');
    this.stage.className = 'lb-stage';
    this.deviceBox = document.createElement('div');
    this.deviceBox.className = 'lb-device';
    this.frame = document.createElement('iframe');
    this.frame.className = 'lb-frame';
    this.frame.dataset.browserPane = this.paneId;
    this.frame.setAttribute('sandbox', SANDBOX);
    this.frame.referrerPolicy = 'no-referrer';
    this.frame.title = 'Local Browser page';
    this.deviceBox.append(this.frame);
    this.startPage = document.createElement('div');
    this.startPage.className = 'lb-start';
    this.errorPage = document.createElement('div');
    this.errorPage.className = 'lb-error';
    this.errorPage.hidden = true;
    this.stage.append(this.deviceBox, this.startPage, this.errorPage);

    this.devtools = new BrowserDevtools({
      state: normalizeDevtools(opts.devtools),
      fetchBody: (id) => browserApi.responseBody(this.paneId, id),
      availableHeight: () => this.body.clientHeight - this.toolbar.element.offsetHeight,
      onChange: () => {
        this.toolbar.setDevtoolsOpen(this.devtools.isOpen());
        opts.onStateChange();
      },
      onCountsChange: () => this.toolbar.setErrorCount(this.devtools.errorCount()),
      onDragging: (dragging) => this.body.classList.toggle('lb-dragging', dragging),
    });
    this.toolbar.setDevtoolsOpen(this.devtools.isOpen());

    this.body.append(this.toolbar.element, this.notice, this.stage, this.devtools.element);
    this.host.appendChild(this.body);

    this.resizeObserver = new ResizeObserver(() => {
      this.layoutDevice();
      this.devtools.layout();
    });
    this.resizeObserver.observe(this.stage);
    this.resizeObserver.observe(this.body);

    this.listen(this.host, 'focusin', () => opts.onFocus());
    this.listen(this.host, 'keydown', (e) => this.onKeyDown(e as KeyboardEvent));
    // Focus moving into the frame blurs the app's window with the frame as the active element.
    this.listen(window, 'blur', () => this.checkFrameFocus());
    this.listen(this.frame, 'focus', () => this.checkFrameFocus());
    this.listen(window, 'focus', () => this.frameLostFocus());
    this.listen(document, 'focusin', () => this.frameLostFocus());
    this.listen(this.stage, 'pointerenter', () => this.renderStartPage());

    // The bridge must know this pane before the frame's first document is requested.
    this.attached = browserApi
      .attach(this.paneId, (ev) => this.onEvent(ev))
      .catch((err: unknown) => console.warn('browser_attach failed', err));

    this.setExpanded(opts.expanded);
    this.layoutDevice();
    this.showPage(null);
    const initial = opts.url === undefined ? opts.settings.localBrowser.homeUrl || null : opts.url;
    if (initial !== null) this.navigate(initial);
  }

  title(): string {
    if (this.pageTitle) return this.pageTitle;
    if (this.url !== null) return hostLabel(this.url);
    return 'Local Browser';
  }

  /** The current page URL, or null on the start page. */
  currentUrl(): string | null {
    return this.url;
  }

  state(): LocalBrowserSavedState {
    return { url: this.url, devtools: this.devtools.state(), device: formatDevice(this.device) };
  }

  /** Loads `url` (a loopback address, or shorthand such as `5173`); a refused one shows why in the toolbar. */
  navigate(url: string): void {
    const r = normalizeInput(url, this.appOrigin);
    if (!r.ok) {
      this.toolbar.setMessage(r.reason);
      return;
    }
    this.requested = r.url;
    this.showPage(r.url);
    this.errorPage.hidden = true;
    recent.add(r.url);
    void this.attached.then(() => {
      if (this.disposed) return;
      // Setting src navigates even when it equals the current value, which Retry relies on.
      this.frame.src = r.url;
    });
    queueMicrotask(() => {
      if (!this.disposed) this.opts.onStateChange();
    });
  }

  focus(): void {
    if (this.url === null || !this.errorPage.hidden) this.toolbar.focusUrl();
    else this.frame.focus();
  }

  setExpanded(expanded: boolean): void {
    this.expanded = expanded;
    if (!expanded) this.frameLostFocusNow();
    this.opts.onWantPorts?.(expanded);
    this.updateStartTimer();
  }

  applySettings(settings: Settings): void {
    this.settings = settings;
    this.bookmarks = settings.localBrowser.bookmarks;
    this.updateBookmarkStar();
    this.renderStartPage();
  }

  cellSize(): CellSize {
    const probe = document.createElement('span');
    probe.textContent = 'M'.repeat(10);
    probe.style.cssText = 'position: absolute; visibility: hidden; white-space: pre;';
    probe.style.fontFamily = toFontFamily(this.settings.font.family);
    probe.style.fontSize = `${this.settings.font.size}px`;
    this.body.appendChild(probe);
    const rect = probe.getBoundingClientRect();
    probe.remove();
    return {
      width: rect.width / 10,
      height: rect.height || this.settings.font.size * 1.2,
      padX: Math.max(0, this.host.offsetWidth - this.body.clientWidth) + 1,
      padY: Math.max(0, this.host.offsetHeight - this.body.clientHeight) + 1,
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.frameLostFocusNow();
    this.opts.onWantPorts?.(false);
    void browserApi.detach(this.paneId).catch(() => {});
    window.clearTimeout(this.noticeTimer);
    window.clearInterval(this.startTimer);
    this.resizeObserver.disconnect();
    for (const off of this.listeners) off();
    this.listeners.length = 0;
    this.toolbar.dispose();
    this.devtools.dispose();
    this.frame.removeAttribute('src');
    this.body.remove();
  }

  private onEvent(ev: BrowserEvent): void {
    if (this.disposed) return;
    switch (ev.kind) {
      case 'navigated':
        if (isErrorPageUrl(ev.url)) {
          if (!this.recentlyBlocked()) this.showUnreachable(ev.unreachableUrl ?? this.requested ?? this.url);
          return;
        }
        this.errorPage.hidden = true;
        this.unreachableSeq++;
        this.documentRequests.clear();
        this.devtools.navigated();
        this.pageTitle = '';
        if (isBlankUrl(ev.url)) {
          this.showPage(null);
        } else {
          this.showPage(ev.url);
          recent.add(ev.url);
        }
        if (ev.title) this.setTitle(ev.title);
        this.opts.onStateChange();
        return;
      case 'navigatedInPage':
        this.showPage(ev.url);
        this.opts.onStateChange();
        return;
      case 'title':
        this.setTitle(ev.title);
        return;
      case 'blocked':
        this.lastBlocked = { url: ev.url, at: Date.now() };
        if (ev.external) this.opts.onOpenExternal(ev.url);
        this.showNotice(blockedNotice(ev.url, ev.external, this.appOrigin));
        return;
      case 'loadState':
        this.toolbar.setLoading(ev.loading);
        return;
      case 'request':
        if (ev.resourceType.toLowerCase() === 'document') this.documentRequests.set(ev.requestId, ev.url);
        this.devtools.handle(ev);
        return;
      case 'failed': {
        const docUrl = this.documentRequests.get(ev.requestId);
        // An aborted document load is a navigation the bridge blocked, which keeps the current page.
        if (docUrl !== undefined && !ev.canceled && !/ERR_ABORTED/i.test(ev.errorText) && !this.isBlocked(docUrl)) this.showUnreachable(docUrl);
        this.devtools.handle(ev);
        return;
      }
      default:
        this.devtools.handle(ev);
    }
  }

  private recentlyBlocked(): boolean {
    return this.lastBlocked !== null && Date.now() - this.lastBlocked.at < BLOCKED_ERROR_MS;
  }

  private isBlocked(url: string): boolean {
    const bare = (u: string) => u.split('#')[0];
    return this.recentlyBlocked() && bare(url) === bare(this.lastBlocked!.url);
  }

  private setTitle(title: string): void {
    // The bridge can report one title twice for an in-page navigation.
    if (title === this.pageTitle) return;
    this.pageTitle = title;
    this.opts.onStateChange();
  }

  /** Switches between the start page (null) and the frame, and syncs the toolbar. */
  private showPage(url: string | null): void {
    this.url = url;
    this.toolbar.setPage(url);
    this.updateBookmarkStar();
    const blank = url === null;
    this.startPage.hidden = !blank;
    this.deviceBox.hidden = blank;
    if (blank) this.renderStartPage();
    this.updateStartTimer();
  }

  /** The overlay for a document that failed to load; the address field and title follow `url`. */
  private showUnreachable(url: string | null): void {
    if (url) {
      this.pageTitle = '';
      this.showPage(url);
      this.opts.onStateChange();
    }
    this.toolbar.setLoading(false);
    const seq = ++this.unreachableSeq;
    if (url === null || !url.startsWith('https:')) return this.renderUnreachable(url, null);
    // Chromium's error page doesn't say why; hide the overlay until the core's own handshake does,
    // rather than flash "nothing is listening" over a certificate problem.
    this.errorPage.hidden = true;
    void browserApi
      .probeTls(url)
      .catch(() => null)
      .then((probe) => {
        if (!this.disposed && seq === this.unreachableSeq) this.renderUnreachable(url, probe);
      });
  }

  private renderUnreachable(url: string | null, probe: TlsProbe | null): void {
    const message = unreachableMessage(url, probe);
    const heading = document.createElement('h3');
    heading.textContent = message.heading;
    const hint = document.createElement('p');
    hint.textContent = message.hint;
    const parts: HTMLElement[] = [heading, hint];
    if (message.command) {
      const command = document.createElement('code');
      command.className = 'lb-error-command';
      command.textContent = message.command;
      parts.push(command);
    }
    const retry = document.createElement('button');
    retry.type = 'button';
    retry.className = 'lb-btn lb-primary';
    retry.textContent = 'Retry';
    retry.addEventListener('click', () => {
      if (url) this.navigate(url);
    });
    this.errorPage.replaceChildren(...parts, retry);
    this.errorPage.hidden = false;
  }

  private showNotice(text: string): void {
    window.clearTimeout(this.noticeTimer);
    this.notice.textContent = text;
    this.notice.hidden = false;
    this.noticeTimer = window.setTimeout(() => {
      this.notice.hidden = true;
    }, NOTICE_MS);
  }

  private history(delta: number): void {
    browserApi.history(this.paneId, delta).catch((err: unknown) => this.showNotice(`Could not go ${delta < 0 ? 'back' : 'forward'}: ${String(err)}`));
  }

  private reload(hard: boolean): void {
    const target = this.requested ?? this.url;
    if (!this.errorPage.hidden && target) {
      this.navigate(target);
      return;
    }
    browserApi.reload(this.paneId, hard).catch(() => {
      // No page session yet (or a browser-only run): reloading the frame's source does the same.
      if (this.url) this.navigate(this.url);
    });
  }

  private home(): void {
    const home = this.settings.localBrowser.homeUrl;
    if (home) {
      this.navigate(home);
      return;
    }
    this.requested = null;
    this.errorPage.hidden = true;
    this.frame.src = 'about:blank';
    this.pageTitle = '';
    this.showPage(null);
    this.opts.onStateChange();
    this.toolbar.focusUrl();
  }

  private toggleBookmark(): void {
    if (this.url === null) return;
    const before = this.bookmarks;
    const next = toggleBookmark(before, this.url, this.pageTitle);
    this.bookmarks = next;
    this.updateBookmarkStar();
    saveSetting(['localBrowser', 'bookmarks'], next).catch((err: unknown) => {
      this.bookmarks = before;
      this.updateBookmarkStar();
      this.showNotice(`Could not save the bookmark: ${String(err)}`);
    });
  }

  private updateBookmarkStar(): void {
    this.toolbar.setBookmarked(this.url !== null && isBookmarked(this.bookmarks, this.url));
  }

  private setDevice(d: DeviceState): void {
    this.device = d;
    this.toolbar.setDevice(d);
    this.layoutDevice();
    this.opts.onStateChange();
  }

  /** Responsive fills the stage; a fixed preset is centered and shrunk to fit, never enlarged. */
  private layoutDevice(): void {
    const preset = devicePreset(this.device);
    const box = this.deviceBox.style;
    const fixed = preset.width !== null && preset.height !== null;
    this.deviceBox.classList.toggle('fixed', fixed);
    if (!fixed) {
      box.width = box.height = box.left = box.top = box.transform = '';
      return;
    }
    const avail = { width: this.stage.clientWidth, height: this.stage.clientHeight };
    const scale = fitScale(preset, avail);
    const w = preset.width! * scale;
    const h = preset.height! * scale;
    box.width = `${preset.width}px`;
    box.height = `${preset.height}px`;
    box.left = `${Math.max(0, (avail.width - w) / 2)}px`;
    box.top = `${Math.max(0, (avail.height - h) / 2)}px`;
    box.transform = scale < 1 ? `scale(${scale})` : '';
  }

  private renderStartPage(): void {
    if (this.disposed || this.startPage.hidden) return;
    const heading = document.createElement('h3');
    heading.textContent = 'Local Browser';
    const hint = document.createElement('p');
    hint.className = 'lb-start-hint';
    hint.textContent = 'Type a port or a localhost address above, or pick a server below.';

    const ports = this.opts
      .listeners()
      .filter((l) => !l.system && !l.own)
      .sort((a, b) => a.port - b.port);
    const portButtons = ports.map((l) => {
      const url = localUrl(l);
      return this.startButton(`localhost:${l.port}`, processLabel(l.name), url);
    });
    const bookmarkButtons = this.bookmarks.map((b) => this.startButton(b.name || hostLabel(b.url), hostLabel(b.url), b.url));

    this.startPage.replaceChildren(
      heading,
      hint,
      this.startSection('Listening ports', portButtons, 'Nothing is listening right now.'),
      this.startSection('Bookmarks', bookmarkButtons, 'No bookmarks yet. Use the star in the address field to add one.'),
    );
  }

  private startSection(title: string, buttons: HTMLElement[], empty: string): HTMLElement {
    const section = document.createElement('section');
    section.className = 'lb-start-section';
    const h = document.createElement('h4');
    h.textContent = title;
    const list = document.createElement('div');
    list.className = 'lb-start-list';
    if (buttons.length === 0) {
      const note = document.createElement('div');
      note.className = 'lb-empty';
      note.textContent = empty;
      list.append(note);
    } else {
      list.append(...buttons);
    }
    section.append(h, list);
    return section;
  }

  private startButton(label: string, detail: string, url: string): HTMLButtonElement {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'lb-start-btn';
    b.title = url;
    const main = document.createElement('span');
    main.className = 'lb-start-label';
    main.textContent = label;
    const sub = document.createElement('span');
    sub.className = 'lb-start-detail';
    sub.textContent = detail;
    b.append(main, sub);
    b.addEventListener('click', () => this.navigate(url));
    return b;
  }

  /** Refreshes the start page's port list while it is on screen. */
  private updateStartTimer(): void {
    const want = this.expanded && !this.disposed && this.url === null;
    if (want && this.startTimer === 0) this.startTimer = window.setInterval(() => this.renderStartPage(), START_REFRESH_MS);
    else if (!want && this.startTimer !== 0) {
      window.clearInterval(this.startTimer);
      this.startTimer = 0;
    }
  }

  private checkFrameFocus(): void {
    if (this.disposed || document.activeElement !== this.frame || this.frameFocused) return;
    this.frameFocused = true;
    this.opts.onFocus();
    void browserApi.setFocus(this.paneId).catch(() => {});
  }

  /** Releases `browser_focus` regardless of the DOM's active element, which a hidden pane no longer controls. */
  private frameLostFocusNow(): void {
    if (!this.frameFocused) return;
    this.frameFocused = false;
    void browserApi.setFocus(null).catch(() => {});
  }

  private frameLostFocus(): void {
    if (!this.frameFocused || document.activeElement === this.frame) return;
    this.frameFocused = false;
    void browserApi.setFocus(null).catch(() => {});
  }

  private onKeyDown(e: KeyboardEvent): void {
    const action = lookup(this.opts.keymap(), e);
    if (action && this.opts.dispatch(action)) {
      e.preventDefault();
      e.stopPropagation();
    }
  }

  private listen(target: EventTarget, type: string, fn: (e: Event) => void): void {
    target.addEventListener(type, fn);
    this.listeners.push(() => target.removeEventListener(type, fn));
  }
}
