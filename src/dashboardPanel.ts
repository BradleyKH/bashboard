import { makeCollapsible, setSectionCollapsed } from './collapsibleSection';
import { externalSessions, groupCardsByTab, paneCards } from './dashboardModel';
import type { PaneCardInput } from './dashboardModel';
import {
  applyDashboardWidth,
  clampDashboardWidth,
  dashboardResizeHandle,
  DEFAULT_DASHBOARD_WIDTH,
} from './dashboardResize';
import { toggleSection } from './dashboardSections';
import type { DashboardSection } from './dashboardSections';
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
import { renderSessionRow } from './sessionRow';
import { renderPaneCard } from './paneCard';
import { renderPaneGroup } from './paneGroup';
import type { TabInfo } from './workspace';

export interface DashboardCallbacks
  extends Partial<FavoritesCallbacks>,
    Partial<LayoutsCallbacks>,
    Partial<PinRowCallbacks>,
    Partial<ContainersSectionCallbacks> {
  onFocus: (paneId: string) => void;
  onClose: (paneId: string) => void;
  onCardDragStart?: (paneId: string, e: PointerEvent) => void;
  onSwitchTab?: (tabId: string) => void;
  /** The user collapsed or expanded a section; the argument is every collapsed section. */
  onSectionsChange?: (collapsed: DashboardSection[]) => void;
  /** The user finished dragging the panel's left edge. */
  onWidthChange?: (width: number) => void;
  /** Open menu on a folder row or the Repo section's buttons. */
  onOpenIn?: OpenInHandler;
  onInstallHooks: () => void;
  onShowHelp: () => void;
  onShowSettings: () => void;
  /** The hide button closed the panel. */
  onHide?: () => void;
}

const AGE_REFRESH_MS = 15_000;

/** The right-edge dashboard's sections (docs/design.md section 4.6). */
export class DashboardPanel {
  private open = false;
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
  private repo: RepoSectionState = { repo: null, pins: [] };
  private repoKey = '';
  private timer: number | undefined;
  private peeking = false;
  private peekTimer: number | undefined;
  private peekExpired = false;
  private hovered = false;
  private readonly installButton: HTMLButtonElement;
  private readonly repoSection: RepoSection;
  private readonly favoritesSection: FavoritesSection;
  private readonly layoutsSection: LayoutsSection;
  private readonly containersSection: ContainersSection;
  private containersStore: ContainersStore | null = null;
  private containersEnabled = true;
  private unsubscribeContainers: (() => void) | null = null;
  private readonly terminalList: HTMLElement;
  private readonly sessionList: HTMLElement;

  constructor(
    private readonly root: HTMLElement,
    private readonly callbacks: DashboardCallbacks,
  ) {
    this.repoSection = new RepoSection({
      onOpenIn: (kind, root) => this.callbacks.onOpenIn?.(kind, root),
      onOpenPin: (pin) => this.callbacks.onOpenPin?.(pin),
      onRenamePin: (index, label) => this.callbacks.onRenamePin?.(index, label),
      onRemovePin: (index) => this.callbacks.onRemovePin?.(index),
      onReorderPin: (from, to) => this.callbacks.onReorderPin?.(from, to),
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
    );
    window.addEventListener('resize', () => this.applyWidth());
    this.applyWidth();
    const top = document.createElement('div');
    top.className = 'dashboard-top';
    top.append(hideButton);
    // Repo follows the focused pane and stays at the top; everything from here down sits at the
    // bottom, so a focus change that resizes Repo never shifts the rest.
    this.favoritesSection.el.classList.add('dashboard-bottom-start');
    root.append(resizeHandle, top, this.repoSection.el, this.favoritesSection.el, this.layoutsSection.el);
    this.register('repo', this.repoSection.el, this.repoSection.head);
    this.register('favorites', this.favoritesSection.el, this.favoritesSection.head);
    this.register('layouts', this.layoutsSection.el, this.layoutsSection.head);
    this.terminalList = this.section('panes', 'Panes');
    this.containersSection = new ContainersSection({
      onOpenContainers: (keys) => this.callbacks.onOpenContainers?.(keys),
      onStart: (row) => this.callbacks.onStart?.(row),
      onStop: (row) => this.callbacks.onStop?.(row),
    });
    this.containersSection.setVisible(false);
    root.append(this.containersSection.el);
    this.register('containers', this.containersSection.el, this.containersSection.head);
    this.sessionList = this.section('external', 'External sessions');
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

  /** Follows the store: the section lists its snapshot and shows while an engine is available and the setting allows it. */
  setContainersStore(store: ContainersStore): void {
    this.unsubscribeContainers?.();
    this.containersStore = store;
    this.unsubscribeContainers = store.subscribe(() => this.renderContainers());
    this.renderContainers();
  }

  setContainersEnabled(enabled: boolean): void {
    this.containersEnabled = enabled;
    this.renderContainers();
  }

  private renderContainers(): void {
    const store = this.containersStore;
    if (!store) return;
    this.containersSection.update(store.current());
    this.containersSection.setVisible(store.available && this.containersEnabled);
  }

  isOpen(): boolean {
    return this.open;
  }

  toggle(): void {
    this.setOpen(!this.open);
  }

  setOpen(open: boolean): void {
    if (open) this.endPeek();
    if (open === this.open) return;
    this.open = open;
    document.body.classList.toggle('dashboard-open', open);
    window.clearInterval(this.timer);
    this.timer = undefined;
    if (open) {
      this.render();
      this.timer = window.setInterval(() => this.render(), AGE_REFRESH_MS);
    }
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
    if (this.open) return;
    this.peeking = true;
    this.peekExpired = false;
    document.body.classList.add('dashboard-peek');
    window.clearTimeout(this.peekTimer);
    this.peekTimer = window.setTimeout(() => {
      this.peekExpired = true;
      if (!this.hovered) this.endPeek();
    }, ms);
    this.render();
  }

  private endPeek(): void {
    if (!this.peeking) return;
    this.peeking = false;
    window.clearTimeout(this.peekTimer);
    this.peekTimer = undefined;
    document.body.classList.remove('dashboard-peek');
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
    setSectionCollapsed(section, this.collapsed.includes(id));
    makeCollapsible(section, header, () => {
      this.collapsed = toggleSection(this.collapsed, id);
      setSectionCollapsed(section, this.collapsed.includes(id));
      this.callbacks.onSectionsChange?.(this.collapsedSections());
    });
  }

  private section(id: DashboardSection, heading: string): HTMLElement {
    const section = document.createElement('section');
    section.className = 'dashboard-section';
    const h = document.createElement('h2');
    h.textContent = heading;
    const list = document.createElement('div');
    list.className = 'dashboard-list';
    section.append(h, list);
    this.root.append(section);
    this.register(id, section, h);
    return list;
  }

  private render(): void {
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
      confirming: this.confirming.has(card.paneId),
      onFocus: this.callbacks.onFocus,
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
