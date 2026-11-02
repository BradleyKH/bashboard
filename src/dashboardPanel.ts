import { makeCollapsible, setSectionCollapsed } from './collapsibleSection';
import { claudeLine } from './claudeModel';
import { ClaudeContexts } from './claudeContexts';
import { attachContextMenu } from './contextMenu';
import { DashboardClock } from './dashboardClock';
import { attachElementDrag } from './dashboardElementDrag';
import { dashboardMenuItems } from './dashboardMenu';
import { externalSessions, groupCardsByTab, paneCards } from './dashboardModel';
import type { PaneCardInput } from './dashboardModel';
import {
  applyDashboardWidth,
  clampDashboardWidth,
  dashboardResizeHandle,
  DEFAULT_DASHBOARD_WIDTH,
} from './dashboardResize';
import type { DashboardSide } from './dashboardResize';
import { DashboardNav } from './dashboardNav';
import { DashboardSystem } from './dashboardSystem';
import { DEFAULT_ELEMENT_ORDER, ELEMENT_SHOWN_BY_DEFAULT, moveSection, toggleSection } from './dashboardSections';
import type { DashboardElement, DashboardSection } from './dashboardSections';
import { recentFolders, samePath } from './favorites';
import type { Favorite } from './favorites';
import { ContainersSection } from './containersSection';
import type { ContainersSectionCallbacks } from './containersSection';
import type { ContainersStore } from './containersStore';
import { FavoritesSection } from './favoritesSection';
import type { FavoritesCallbacks } from './favoritesSection';
import { LayoutsSection } from './layoutsSection';
import type { LayoutsCallbacks } from './layoutsSection';
import type { NamedLayout } from './layouts';
import type { OpenInHandler } from './openMenu';
import type { PinRowCallbacks } from './pinRow';
import { RepoSection } from './repoSection';
import type { RepoSectionState } from './repoSection';
import type { Session } from './sessions';
import type { Settings } from './settings';
import { renderSessionRow } from './sessionRow';
import { renderPaneCard } from './paneCard';
import { renderPaneGroup } from './paneGroup';
import type { TabInfo } from './workspace';
import type { WorktreeCallbacks } from './worktreeList';

export interface DashboardCallbacks
  extends Partial<FavoritesCallbacks>,
    Partial<LayoutsCallbacks>,
    Partial<PinRowCallbacks>,
    Partial<ContainersSectionCallbacks> {
  onFocus: (paneId: string) => void;
  onClose: (paneId: string) => void;
  /** A Panes card's menu collapses or expands its pane. */
  onToggleCollapse?: (paneId: string) => void;
  onCardDragStart?: (paneId: string, e: PointerEvent) => void;
  onSwitchTab?: (tabId: string) => void;
  /** The user collapsed or expanded a section; the argument is every collapsed section. */
  onSectionsChange?: (collapsed: DashboardSection[]) => void;
  /** The user finished dragging the panel's inner edge. */
  onWidthChange?: (width: number) => void;
  /** The user dragged an element to a new place; the argument is the whole element order. */
  onOrderChange?: (order: DashboardElement[]) => void;
  /** The panel's own menu asked to show or hide an element; the setting's reload applies it. */
  onSetElementShown?: (element: DashboardElement, shown: boolean) => void;
  /** Open menu on a folder row or the Repo section's buttons. */
  onOpenIn?: OpenInHandler;
  onDeleteWorktree?: WorktreeCallbacks['onDeleteWorktree'];
  onSetPrimaryBranch?: WorktreeCallbacks['onSetPrimaryBranch'];
  /** The panel came on screen (open or peeking) or left it. */
  onShownChange?: (shown: boolean) => void;
  onInstallHooks: () => void;
  onShowHelp: () => void;
  onShowSettings: () => void;
  /** The hide button closed the panel. */
  onHide?: () => void;
  /** Escape or F6 left the panel; focus goes back to the panes. */
  onLeave?: () => void;
  /** A key pressed in the panel that it does not use itself; true when a workspace action ran. */
  onKey?: (e: KeyboardEvent) => boolean;
}

const AGE_REFRESH_MS = 15_000;

/**
 * The dashboard, docked on the left or right side of the window: Repo at the top, the footer at
 * the bottom, and between them the elements in the user's order, each shown or hidden by its
 * setting (docs/design.md section 4.6).
 */
export class DashboardPanel {
  private open = false;
  private order: DashboardElement[] = [...DEFAULT_ELEMENT_ORDER];
  /** Whether the clock sits in the slot above Repo; its place in `order` holds for when it is not. */
  private clockTop = true;
  private shown: Record<DashboardElement, boolean> = { ...ELEMENT_SHOWN_BY_DEFAULT };
  private side: DashboardSide = 'right';
  private windowShown = true;
  private readonly elements = new Map<DashboardElement, HTMLElement>();
  private readonly elementList: HTMLElement;
  private readonly topSlot: HTMLElement;
  private readonly clock = new DashboardClock();
  private readonly system = new DashboardSystem();
  private readonly claude = new ClaudeContexts(() => this.render());
  private panes: PaneCardInput[] = [];
  private collapsed: DashboardSection[] = [];
  /** The width the user chose; what shows is clamped to the current window. */
  private preferredWidth = DEFAULT_DASHBOARD_WIDTH;
  private readonly sectionEls = new Map<DashboardSection, HTMLElement>();
  private tabs: TabInfo[] = [];
  private sessions: Session[] = [];
  private readonly expanded = new Set<string>();
  private readonly confirming = new Set<string>();
  private favorites: Favorite[] = [];
  private favoritesKey = '';
  private layouts: NamedLayout[] = [];
  private layoutsKey = '';
  private repo: RepoSectionState = { repo: null, pins: [], worktrees: null };
  private wasShown = false;
  private repoKey = '';
  private timer: number | undefined;
  private peeking = false;
  private peekTimer: number | undefined;
  private peekExpired = false;
  /** A peek opened by F6, which lasts while focus stays in the panel instead of timing out. */
  private held = false;
  private hovered = false;
  private readonly nav: DashboardNav;
  private readonly installButton: HTMLButtonElement;
  private readonly repoSection: RepoSection;
  private readonly favoritesSection: FavoritesSection;
  private readonly layoutsSection: LayoutsSection;
  private readonly containersSection: ContainersSection;
  private containersStore: ContainersStore | null = null;
  private unsubscribeContainers: (() => void) | null = null;
  private readonly terminalList: HTMLElement;
  private readonly sessionList: HTMLElement;

  constructor(
    root: HTMLElement,
    private readonly callbacks: DashboardCallbacks,
  ) {
    this.repoSection = new RepoSection({
      onOpenIn: (kind, root) => this.callbacks.onOpenIn?.(kind, root),
      onOpenPin: (pin) => this.callbacks.onOpenPin?.(pin),
      onRenamePin: (index, label) => this.callbacks.onRenamePin?.(index, label),
      onRemovePin: (index) => this.callbacks.onRemovePin?.(index),
      onReorderPin: (from, to) => this.callbacks.onReorderPin?.(from, to),
      onDeleteWorktree: (root, w) => this.callbacks.onDeleteWorktree?.(root, w) ?? Promise.resolve(null),
      onSetPrimaryBranch: (root, branch) => this.callbacks.onSetPrimaryBranch?.(root, branch),
    });
    this.favoritesSection = new FavoritesSection({
      onOpen: (path, opts) => this.callbacks.onOpen?.(path, opts),
      onAdd: () => this.callbacks.onAdd?.(),
      onRename: (index, label) => this.callbacks.onRename?.(index, label),
      onRemove: (index) => this.callbacks.onRemove?.(index),
      onReorder: (from, to) => this.callbacks.onReorder?.(from, to),
      onPromote: (path) => this.callbacks.onPromote?.(path),
      onDragStart: (path, e) => this.callbacks.onDragStart?.(path, e),
      onOpenIn: (kind, path) => this.callbacks.onOpenIn?.(kind, path),
    });
    this.layoutsSection = new LayoutsSection({
      onOpenLayout: (name) => this.callbacks.onOpenLayout?.(name),
      onSaveLayout: (name) => this.callbacks.onSaveLayout?.(name),
      onRenameLayout: (index, name) => this.callbacks.onRenameLayout?.(index, name),
      onRemoveLayout: (index) => this.callbacks.onRemoveLayout?.(index),
    });
    const hideButton = document.createElement('button');
    hideButton.type = 'button';
    hideButton.className = 'dashboard-hide';
    hideButton.textContent = '×';
    hideButton.title = 'Hide the dashboard';
    hideButton.addEventListener('click', () => {
      this.hide();
      this.callbacks.onHide?.();
    });
    const resizeHandle = dashboardResizeHandle(
      () => this.shownWidth(),
      (width) => {
        this.preferredWidth = width;
        this.callbacks.onWidthChange?.(width);
      },
      () => this.side,
    );
    window.addEventListener('resize', () => this.applyWidth());
    this.applyWidth();
    const top = document.createElement('div');
    top.className = 'dashboard-top';
    top.append(hideButton);
    // Repo follows the focused pane and stays at the top; the elements sit at the bottom, so a
    // focus change that resizes Repo never shifts them.
    this.elementList = document.createElement('div');
    this.elementList.className = 'dashboard-elements';
    this.topSlot = document.createElement('div');
    this.topSlot.className = 'dashboard-clock-top';
    this.topSlot.hidden = true;
    root.append(resizeHandle, top, this.topSlot, this.repoSection.el, this.elementList);
    this.register('repo', this.repoSection.el, this.repoSection.head);
    this.addSection('favorites', this.favoritesSection.el, this.favoritesSection.head);
    this.addSection('layouts', this.layoutsSection.el, this.layoutsSection.head);
    this.terminalList = this.section('panes', 'Panes');
    this.containersSection = new ContainersSection({
      onOpenContainers: (keys) => this.callbacks.onOpenContainers?.(keys),
      onStart: (row) => this.callbacks.onStart?.(row),
      onStop: (row) => this.callbacks.onStop?.(row),
    });
    this.containersSection.setVisible(false);
    this.addSection('containers', this.containersSection.el, this.containersSection.head);
    this.sessionList = this.section('external', 'External sessions');
    this.addSection('system', this.system.el, this.system.head);
    this.addElement('clock', this.clock.el, this.clock.el);
    this.installButton = document.createElement('button');
    this.installButton.type = 'button';
    this.installButton.className = 'hooks-install';
    this.installButton.textContent = 'Install Claude Code hooks';
    this.installButton.hidden = true;
    this.installButton.addEventListener('click', () => this.callbacks.onInstallHooks());
    const helpButton = document.createElement('button');
    helpButton.type = 'button';
    helpButton.className = 'help-open';
    helpButton.textContent = 'Keyboard shortcuts';
    helpButton.addEventListener('click', () => this.callbacks.onShowHelp());
    const settingsButton = document.createElement('button');
    settingsButton.type = 'button';
    settingsButton.className = 'help-open';
    settingsButton.textContent = 'Settings';
    settingsButton.addEventListener('click', () => this.callbacks.onShowSettings());
    const footer = document.createElement('div');
    footer.className = 'dashboard-footer';
    footer.append(this.installButton, helpButton, settingsButton);
    root.append(footer);
    this.nav = new DashboardNav(root, {
      onLeave: () => this.leave(),
      onKey: (e) => this.callbacks.onKey?.(e) ?? false,
    });
    this.layoutElements();
    root.addEventListener('focusout', () => {
      if (!this.held) return;
      // A rebuild that replaced the focused row has already refocused its successor by the time
      // this runs, and the Open menu takes focus only until it closes.
      queueMicrotask(() => {
        const active = document.activeElement;
        if (this.held && !this.nav.hasFocus() && !active?.closest('.context-menu')) this.endPeek();
      });
    });
    // Rows with their own menus stop the event, so this opens only on the panel's background,
    // headers, and other spots no row claims.
    attachContextMenu(root, () => ({
      entries: dashboardMenuItems(this.shown, (el, show) => this.callbacks.onSetElementShown?.(el, show)),
    }));
    root.addEventListener('pointerenter', () => {
      this.hovered = true;
    });
    root.addEventListener('pointerleave', () => {
      this.hovered = false;
      if (this.peeking && this.peekExpired) this.endPeek();
    });
    // Clicking a control would otherwise move focus off xterm; click handlers still fire.
    root.addEventListener('mousedown', (e) => {
      const target = e.target as HTMLElement;
      if (!target.closest('.session-detail-value')) e.preventDefault();
    });
  }

  /**
   * Follows the store: the section lists its snapshot and shows while an engine is available. Its
   * setting, like every element's, decides whether it is in the panel at all.
   */
  setContainersStore(store: ContainersStore): void {
    this.unsubscribeContainers?.();
    this.containersStore = store;
    this.unsubscribeContainers = store.subscribe(() => this.renderContainers());
    this.renderContainers();
  }

  private renderContainers(): void {
    const store = this.containersStore;
    if (!store) return;
    const focus = this.nav.capture();
    this.containersSection.update(store.current());
    this.containersSection.setVisible(store.available);
    this.nav.restore(focus);
  }

  /** Applies `dashboard.side` and `dashboard.sections` (docs/design.md section 4.6). */
  applyDashboardSettings(d: Settings['dashboard']): void {
    this.shown = { ...d.sections };
    this.setSide(d.side);
    this.layoutElements();
    this.syncTimers();
  }

  /** Applies a saved element order without firing `onOrderChange`. */
  setSectionOrder(order: DashboardElement[]): void {
    this.order = [...order];
    this.layoutElements();
  }

  sectionOrder(): DashboardElement[] {
    return [...this.order];
  }

  /** Applies a saved clock position without firing `onOrderChange`. */
  setClockTop(top: boolean): void {
    this.clockTop = top;
    this.layoutElements();
  }

  clockAtTop(): boolean {
    return this.clockTop;
  }

  /** Whether the window is shown (not hidden or minimized); the clock ticks only while it is. */
  setWindowShown(shown: boolean): void {
    this.windowShown = shown;
    this.syncTimers();
  }

  private setSide(side: DashboardSide): void {
    if (side === this.side) return;
    // A peek animates in from its side, so it ends rather than jumping across the window.
    if (this.peeking) {
      if (this.nav.hasFocus()) this.leave();
      else this.endPeek();
    }
    this.side = side;
    document.body.classList.toggle('dashboard-left', side === 'left');
  }

  /**
   * Starts or stops every timer that runs only while its element is on screen; System also stops
   * while collapsed (docs/design.md section 4.6). Called whenever any input changes.
   */
  private syncTimers(): void {
    const onScreen = this.isShown();
    this.clock.setRunning(this.shown.clock && onScreen && this.windowShown);
    this.system.setGate({
      enabled: this.shown.system,
      expanded: !this.collapsed.includes('system'),
      onScreen,
      windowShown: this.windowShown,
    });
    this.claude.setEnabled(this.shown.panes);
  }

  /**
   * Puts the shown elements in the panel in order and detaches the rest; a disabled element keeps
   * its place in `order`, so turning it back on returns it there.
   */
  private layoutElements(): void {
    const atTop = this.clockTop && this.shown.clock;
    const next = this.order
      .filter((id) => this.shown[id] && !(atTop && id === 'clock'))
      .map((id) => this.elements.get(id)!);
    const current = [...this.elementList.children];
    const topSame = atTop === (this.topSlot.firstElementChild === this.clock.el);
    if (topSame && next.length === current.length && next.every((el, i) => el === current[i])) return;
    const focus = this.nav.capture();
    this.topSlot.replaceChildren(...(atTop ? [this.clock.el] : []));
    this.topSlot.hidden = !atTop;
    this.elementList.replaceChildren(...next);
    this.nav.restore(focus);
  }

  isOpen(): boolean {
    return this.open;
  }

  /** Whether the panel is on screen, open or peeking. */
  isShown(): boolean {
    return this.open || this.peeking;
  }

  private notifyShown(): void {
    this.syncTimers();
    const shown = this.isShown();
    if (shown === this.wasShown) return;
    this.wasShown = shown;
    this.callbacks.onShownChange?.(shown);
  }

  /** Whether keyboard focus is in the panel. */
  hasFocus(): boolean {
    return this.nav.hasFocus();
  }

  /**
   * Moves keyboard focus into the panel (docs/design.md section 4.6). A hidden panel shows as a
   * peek that lasts until focus leaves it.
   */
  focusIn(): void {
    if (!this.open && !this.held) {
      this.peeking = true;
      this.held = true;
      this.peekExpired = false;
      window.clearTimeout(this.peekTimer);
      document.body.classList.add('dashboard-peek');
      this.render();
      this.notifyShown();
    }
    this.nav.enter();
  }

  /** Hands focus back to the panes, ending an F6 peek. */
  leave(): void {
    this.callbacks.onLeave?.();
    // With no pane to take it, focus would otherwise stay on a row of a panel that may be closing.
    if (this.nav.hasFocus()) (document.activeElement as HTMLElement).blur();
    if (this.held) this.endPeek();
  }

  /** The Panes section's tab group under the point, for dropping a dragged card into its tab. */
  groupAt(x: number, y: number): { tabId: string; rect: DOMRect } | null {
    if (!this.open && !this.peeking) return null;
    for (const el of this.terminalList.querySelectorAll<HTMLElement>('.terminal-group[data-tab-id]')) {
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) continue;
      if (x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom) {
        return { tabId: el.dataset.tabId!, rect };
      }
    }
    return null;
  }

  toggle(): void {
    this.setOpen(!this.open);
  }

  setOpen(open: boolean): void {
    // Going from a peek to open keeps the panel on screen, so no change is reported in between.
    if (open) this.endPeek(false);
    if (open === this.open) return;
    this.open = open;
    document.body.classList.toggle('dashboard-open', open);
    window.clearInterval(this.timer);
    this.timer = undefined;
    if (open) {
      this.render();
      this.timer = window.setInterval(() => this.render(), AGE_REFRESH_MS);
    }
    this.notifyShown();
  }

  /** Closes the panel, or ends a peek. */
  hide(): void {
    this.endPeek();
    this.setOpen(false);
  }

  setHooksInstalled(installed: boolean): void {
    this.installButton.hidden = installed;
  }

  /** Shows the panel over the panes for a moment without narrowing them. */
  peek(ms = 4000): void {
    if (this.open || this.held) return;
    this.peeking = true;
    this.peekExpired = false;
    document.body.classList.add('dashboard-peek');
    window.clearTimeout(this.peekTimer);
    this.peekTimer = window.setTimeout(() => {
      this.peekExpired = true;
      if (!this.hovered) this.endPeek();
    }, ms);
    this.render();
    this.notifyShown();
  }

  private endPeek(notify = true): void {
    if (!this.peeking) return;
    this.peeking = false;
    this.held = false;
    window.clearTimeout(this.peekTimer);
    this.peekTimer = undefined;
    document.body.classList.remove('dashboard-peek');
    if (notify) this.notifyShown();
  }

  update(panes: PaneCardInput[], tabs: TabInfo[], sessions: Session[]): void {
    this.panes = panes;
    this.tabs = tabs;
    this.sessions = sessions;
    if (this.open || this.peeking) this.render();
  }

  setFavorites(favorites: Favorite[]): void {
    this.favorites = favorites;
    if (this.open || this.peeking) this.render();
  }

  setRepo(state: RepoSectionState): void {
    this.repo = state;
    if (this.open || this.peeking) this.render();
  }

  setLayouts(list: NamedLayout[]): void {
    this.layouts = list;
    if (this.open || this.peeking) this.render();
  }

  /** Applies the saved collapsed sections without firing `onSectionsChange`. */
  setCollapsedSections(list: DashboardSection[]): void {
    this.collapsed = [...list];
    for (const [id, el] of this.sectionEls) setSectionCollapsed(el, this.collapsed.includes(id));
    this.syncTimers();
  }

  collapsedSections(): DashboardSection[] {
    return [...this.collapsed];
  }

  /** Applies a saved width without firing `onWidthChange`. */
  setWidth(width: number): void {
    this.preferredWidth = width;
    this.applyWidth();
  }

  width(): number {
    return this.preferredWidth;
  }

  private shownWidth(): number {
    return clampDashboardWidth(this.preferredWidth, window.innerWidth);
  }

  private applyWidth(): void {
    applyDashboardWidth(this.shownWidth());
  }

  private register(id: DashboardSection, section: HTMLElement, header: HTMLElement): void {
    this.sectionEls.set(id, section);
    section.dataset.section = id;
    setSectionCollapsed(section, this.collapsed.includes(id));
    makeCollapsible(section, header, () => {
      this.collapsed = toggleSection(this.collapsed, id);
      setSectionCollapsed(section, this.collapsed.includes(id));
      this.syncTimers();
      this.callbacks.onSectionsChange?.(this.collapsedSections());
    });
  }

  private section(id: DashboardSection & DashboardElement, heading: string): HTMLElement {
    const section = document.createElement('section');
    section.className = 'dashboard-section';
    const h = document.createElement('h2');
    h.textContent = heading;
    const list = document.createElement('div');
    list.className = 'dashboard-list';
    section.append(h, list);
    this.addSection(id, section, h);
    return list;
  }

  private addSection(id: DashboardSection & DashboardElement, section: HTMLElement, header: HTMLElement): void {
    this.register(id, section, header);
    this.addElement(id, section, header);
  }

  /**
   * `handle` drags the element: a section's header, or the whole clock. Only the clock may also
   * land in the slot above Repo.
   */
  private addElement(id: DashboardElement, el: HTMLElement, handle: HTMLElement): void {
    el.dataset.element = id;
    this.elements.set(id, el);
    const isClock = id === 'clock';
    attachElementDrag(
      handle,
      this.elementList,
      id,
      (target) => {
        const toTop = target === 'top';
        const next = toTop ? this.order : moveSection(this.order, id, target);
        const clockTop = isClock ? toTop : this.clockTop;
        if (clockTop === this.clockTop && next.every((e, i) => e === this.order[i])) return;
        this.order = next;
        this.clockTop = clockTop;
        this.layoutElements();
        this.callbacks.onOrderChange?.(this.sectionOrder());
      },
      isClock ? this.topSlot : undefined,
    );
  }

  private render(): void {
    const focus = this.nav.capture();
    this.renderSections();
    this.nav.restore(focus);
  }

  private renderSections(): void {
    const now = Date.now();
    const cards = paneCards(this.panes, this.sessions);
    const external = externalSessions(this.sessions, this.panes);

    // Drop state for cards and rows that no longer exist, so a reused id starts fresh.
    const live = new Set(cards.map((c) => c.paneId));
    for (const id of this.confirming) if (!live.has(id)) this.confirming.delete(id);
    const ids = new Set(external.map((s) => s.sessionId));
    for (const id of this.expanded) if (!ids.has(id)) this.expanded.delete(id);

    // Rebuilding the section mid-edit would destroy a rename input or a reorder in progress.
    const recents = recentFolders(this.sessions, this.favorites);
    const focusedPane = this.panes.find((p) => p.focused);
    const cwd = focusedPane?.kind === 'terminal' ? focusedPane.cwd : null;
    const canAdd = cwd !== null && !this.favorites.some((f) => samePath(f.path, cwd));
    const key = JSON.stringify([this.favorites, recents, canAdd]);
    if (key !== this.favoritesKey) {
      this.favoritesKey = key;
      this.favoritesSection.update(this.favorites, recents, canAdd);
    }

    const repoKey = JSON.stringify(this.repo);
    if (repoKey !== this.repoKey) {
      this.repoKey = repoKey;
      this.repoSection.update(this.repo);
    }

    const layoutsKey = JSON.stringify(this.layouts.map((l) => [l.name, l.tab.panes.length]));
    if (layoutsKey !== this.layoutsKey) {
      this.layoutsKey = layoutsKey;
      this.layoutsSection.update(this.layouts);
    }

    // Group headers appear only with two or more tabs (docs/design.md section 4.6).
    const cardOptions = (card: (typeof cards)[number]) => ({
      now,
      claudeLine: card.kind === 'terminal' && card.sessionId !== null ? claudeLine(this.claude.get(card.sessionId)) : null,
      confirming: this.confirming.has(card.paneId),
      onFocus: this.callbacks.onFocus,
      onToggleCollapse: this.callbacks.onToggleCollapse,
      onOpenIn: this.callbacks.onOpenIn,
      onDragStart: this.callbacks.onCardDragStart,
      onClose: (paneId: string) => {
        this.confirming.delete(paneId);
        this.callbacks.onClose(paneId);
      },
      onConfirmChange: (paneId: string, confirming: boolean) => {
        if (confirming) this.confirming.add(paneId);
        else this.confirming.delete(paneId);
        this.render();
      },
    });
    const groups = groupCardsByTab(cards, this.tabs);
    const showHeaders = groups.length > 1;
    this.terminalList.replaceChildren(
      ...(showHeaders
        ? groups.map((g) =>
            renderPaneGroup(
              g,
              g.cards.map((card) => renderPaneCard(card, cardOptions(card))),
              (tabId) => this.callbacks.onSwitchTab?.(tabId),
            ),
          )
        : cards.map((card) => renderPaneCard(card, cardOptions(card)))),
    );

    this.sessionList.parentElement!.hidden = external.length === 0;
    this.sessionList.replaceChildren(
      ...external.map((s) =>
        renderSessionRow(s, {
          now,
          expanded: this.expanded.has(s.sessionId),
          onOpenIn: this.callbacks.onOpenIn,
          onToggle: (id) => {
            if (!this.expanded.delete(id)) this.expanded.add(id);
            this.render();
          },
        }),
      ),
    );
  }
}
