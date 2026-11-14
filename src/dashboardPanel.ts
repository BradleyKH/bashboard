import { agentName, isPreviewAgent } from './agentNames';
import { BranchSection } from './branchSection';
import { BranchSectionController } from './branchSectionController';
import { badgeText, badgeTitle, isOverThreshold } from './branchSizeModel';
import { branchSizeStore } from './branchSizeStore';
import type { AgentId } from './savedWorkspace';
import { makeCollapsible, setSectionCollapsed } from './collapsibleSection';
import { agentLine } from './agentModel';
import { clockMenuItems } from './clockMenu';
import type { ClockStyle } from './clockModel';
import { AgentContexts } from './agentContexts';
import { attachContextMenu } from './contextMenu';
import { DashboardClock } from './dashboardClock';
import type { DashboardColumn } from './dashboardColumns';
import { DashboardColumnsView } from './dashboardColumnsView';
import { dashboardMenuItems } from './dashboardMenu';
import { agentCards, externalSessions, groupCardsByTab, otherPanesLabel, paneCards } from './dashboardModel';
import type { PaneCard, PaneCardInput } from './dashboardModel';
import { sparkleIcon } from './sparkleIcon';
import {
  applyDashboardWidth,
  clampDashboardWidth,
  dashboardResizeHandle,
  DEFAULT_DASHBOARD_WIDTH,
} from './dashboardResize';
import type { DashboardSide } from './dashboardResize';
import { DashboardNav } from './dashboardNav';
import { dashboardRevealHandle } from './dashboardReveal';
import { withKeys } from './dashboardRevealModel';
import { DashboardSystem } from './dashboardSystem';
import { DashboardWave } from './dashboardWave';
import { ELEMENT_SHOWN_BY_DEFAULT, toggleSection } from './dashboardSections';
import type { DashboardElement, DashboardSection, ShowableSection } from './dashboardSections';
import { recentFolders, samePath } from './favorites';
import type { Favorite } from './favorites';
import { ContainersSection } from './containersSection';
import type { ContainersSectionCallbacks } from './containersSection';
import type { ContainersStore } from './containersStore';
import { PortsSection, type PortsSectionCallbacks } from './portsSection';
import type { PortsStore } from './portsStore';
import { ShipSection } from './shipSection';
import { shipOverviewStore } from './shipOverviewStore';
import { NeedsYouSection } from './needsYouSection';
import { needsYouStore } from './needsYouStore';
import type { ShipTab } from './shipModel';
import { LocalModelsSection } from './localModelsSection';
import { findLoadedOllama } from './localModelsModel';
import type { LocalModelsStore } from './localModelsStore';
import { FavoritesSection } from './favoritesSection';
import type { FavoritesCallbacks } from './favoritesSection';
import { LayoutsSection } from './layoutsSection';
import type { LayoutsCallbacks } from './layoutsSection';
import type { NamedLayout } from './layouts';
import type { OpenInHandler } from './openMenu';
import type { PinRowCallbacks } from './pinRow';
import type { GlobalPinRowCallbacks } from './globalPinRow';
import { pinIcon } from './pinIcon';
import { heartIcon } from './heartIcon';
import { gridIcon } from './gridIcon';
import { LaunchSection } from './launchSection';
import type { LaunchKind } from './launchModel';
import { PinsSection, type RepoState } from './pinsSection';
import type { Session } from './sessions';
import { GIT_BASH_PROFILE } from './profiles';
import type { Settings } from './settings';
import { renderSessionRow } from './sessionRow';
import { renderPaneCard } from './paneCard';
import { renderPaneGroup } from './paneGroup';
import type { TabInfo } from './workspace';

export interface DashboardCallbacks
  extends Partial<FavoritesCallbacks>,
    Partial<LayoutsCallbacks>,
    Partial<PinRowCallbacks>,
    Partial<GlobalPinRowCallbacks>,
    Partial<ContainersSectionCallbacks> {
  /** The Pins heading's "+" (docs/design/dashboard.md section 4.6). */
  onNewPin?: () => void;
  onFocus: (paneId: string) => void;
  onClose: (paneId: string) => void;
  /** The Ports section's rows; omitted, they only list. */
  ports?: PortsSectionCallbacks;
  /** The Ship section opens the Overview, drilled into `target` on `tab` when given. */
  onOpenShip?: (target: string | null, tab?: ShipTab) => void;
  /** The Branch section's header opens the Git tab for its worktree. */
  onOpenGit?: (root: string) => void;
  /** A Panes card's menu collapses or expands its pane. */
  onToggleCollapse?: (paneId: string) => void;
  onCardDragStart?: (paneId: string, e: PointerEvent) => void;
  onSwitchTab?: (tabId: string) => void;
  /** A tab group header's Rename; an empty name returns the tab to following its focused pane. */
  onRenameTab?: (tabId: string, name: string) => void;
  /** The user collapsed or expanded a section; the argument is every collapsed section. */
  onSectionsChange?: (collapsed: DashboardSection[]) => void;
  /** The user toggled the Panes section's folder paths. */
  onPanePathsChange?: (shown: boolean) => void;
  /** The user toggled the Panes section's AI filter. */
  onAgentPanesOnlyChange?: (only: boolean) => void;
  /** The user toggled whether the Pins section lists global pins. */
  onShowGlobalPinsChange?: (shown: boolean) => void;
  /** The user finished dragging the panel's inner edge. */
  onWidthChange?: (width: number) => void;
  /** An element or Pins moved, by a drag or the first split into two columns; save the placement. */
  onOrderChange?: () => void;
  /** The panel's own menu asked to show or hide an element; the setting's reload applies it. */
  onSetElementShown?: (element: ShowableSection, shown: boolean) => void;
  /** The clock's menu picked a style; the setting's reload applies it. */
  onSetClockStyle?: (style: ClockStyle) => void;
  /** Open menu on a folder row. */
  onOpenIn?: OpenInHandler;
  /** A Launch button: opens `kind` at the focused pane's repo root. */
  onLaunch?: (kind: LaunchKind) => void;
  /** The Launch option under the pointer or focus, or null when none is; drives the preview. */
  onLaunchPreview?: (kind: LaunchKind | null) => void;
  /** The top bar's + button, shown while Launch is hidden; the menu drops from `anchor`. */
  onOpenLaunchMenu?: (anchor: HTMLElement) => void;
  /** The top bar's Favorites and Layouts buttons, shown while their section is hidden; the menu drops from `anchor`. */
  onOpenFavoritesMenu?: (anchor: HTMLElement) => void;
  onOpenLayoutsMenu?: (anchor: HTMLElement) => void;
  /** The top bar's pin button while the Pins section shows but leaves out global pins; the menu drops from `anchor`. */
  onOpenGlobalPinsMenu?: (anchor: HTMLElement) => void;
  /** The top bar's pin button while the Pins section is hidden: the repo's pins and the global ones. */
  onOpenPinPicker?: (anchor: HTMLElement) => void;
  /** The panel came on screen (open or peeking) or left it. */
  onShownChange?: (shown: boolean) => void;
  onInstallHooks: (agent: AgentId) => void;
  onShowHelp: () => void;
  onShowSettings: () => void;
  /** The hide button closed the panel. */
  onHide?: () => void;
  /** The edge handle opened the hidden panel. */
  onReveal?: () => void;
  /** An action's formatted chords, for the top bar's and the edge handle's tooltips. */
  actionKeys?: (action: string) => string | undefined;
  /** Escape or F6 left the panel; focus goes back to the panes. */
  onLeave?: () => void;
  /** A key pressed in the panel that it does not use itself; true when a workspace action ran. */
  onKey?: (e: KeyboardEvent) => boolean;
}

const AGE_REFRESH_MS = 15_000;
/** Needs you ages read in minutes, so its rows are rebuilt on the age timer no more often than this. */
const NEEDS_AGE_MS = 60_000;

/** `getKeys` is read on hover, so the tooltip shows a rebinding without a reload. */
function topButton(
  className: string,
  text: string,
  title: string,
  getKeys: () => string | undefined,
  run: (button: HTMLButtonElement) => void,
): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = className;
  b.textContent = text;
  b.title = title;
  b.addEventListener('pointerenter', () => {
    b.title = withKeys(title, getKeys());
  });
  b.addEventListener('click', () => run(b));
  return b;
}

/**
 * The dashboard, docked on the left or right side of the window: the top bar over one or two
 * columns, each with a top slot, Pins in one of them, and a lower list; the elements sit in any
 * slot in the user's order, each shown or hidden by its setting (docs/design/dashboard.md
 * section 4.6).
 */
export class DashboardPanel {
  private open = false;
  private shown: Record<ShowableSection, boolean> = { ...ELEMENT_SHOWN_BY_DEFAULT };
  private side: DashboardSide = 'right';
  private windowShown = true;
  private readonly columns: DashboardColumnsView;
  private readonly clock = new DashboardClock();
  private clockStyle: ClockStyle = 'both';
  private readonly system = new DashboardSystem();
  private readonly wave = new DashboardWave();
  private readonly agentContexts = new AgentContexts(() => this.render());
  private panes: PaneCardInput[] = [];
  private collapsed: DashboardSection[] = [];
  private showPanePaths = false;
  private panePathsButton!: HTMLButtonElement;
  private agentPanesOnly = false;
  private agentPanesButton!: HTMLButtonElement;
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
  private repo: RepoState = { repo: null, pins: [], globalPins: [] };
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
  private readonly hooksFooter: HTMLElement;
  private readonly favoritesMenuButton: HTMLButtonElement;
  private readonly layoutsMenuButton: HTMLButtonElement;
  private readonly launchMenuButton: HTMLButtonElement;
  private readonly globalPinsMenuButton: HTMLButtonElement;
  private readonly launchSection: LaunchSection;
  private readonly pinsSection: PinsSection;
  private readonly favoritesSection: FavoritesSection;
  private readonly layoutsSection: LayoutsSection;
  private readonly containersSection: ContainersSection;
  private containersStore: ContainersStore | null = null;
  private unsubscribeContainers: (() => void) | null = null;
  private readonly portsSection: PortsSection;
  private readonly shipSection: ShipSection;
  private readonly needsSection: NeedsYouSection;
  private needsRenderedAt = 0;
  private readonly branchSection: BranchSection;
  private readonly branchController: BranchSectionController;
  /** The terminal folders last handed to the branch size store, so an unchanged list is not resent. */
  private cardFoldersKey = '';
  /** The card badges last rendered, so a store emit that changes none of them skips the re-render. */
  private cardBadgesKey = '';
  private portsStore: PortsStore | null = null;
  private unsubscribePorts: (() => void) | null = null;
  private readonly localModelsSection = new LocalModelsSection();
  private localModelsStore: LocalModelsStore | null = null;
  private unsubscribeLocalModels: (() => void) | null = null;
  private minContext = 64000;
  private readonly terminalList: HTMLElement;
  private readonly sessionList: HTMLElement;

  constructor(
    root: HTMLElement,
    private readonly callbacks: DashboardCallbacks,
  ) {
    this.launchSection = new LaunchSection({
      onLaunch: (kind) => this.callbacks.onLaunch?.(kind),
      onPreview: (kind) => this.callbacks.onLaunchPreview?.(kind),
    });
    this.pinsSection = new PinsSection({
      onOpenPin: (pin) => this.callbacks.onOpenPin?.(pin),
      onRenamePin: (index, label) => this.callbacks.onRenamePin?.(index, label),
      onEditPin: (index) => this.callbacks.onEditPin?.(index),
      onNewPin: () => this.callbacks.onNewPin?.(),
      onRemovePin: (index) => this.callbacks.onRemovePin?.(index),
      onReorderPin: (from, to) => this.callbacks.onReorderPin?.(from, to),
      onRunGlobalPin: (index) => this.callbacks.onRunGlobalPin?.(index),
      onEditGlobalPin: (index) => this.callbacks.onEditGlobalPin?.(index),
      onRemoveGlobalPin: (index) => this.callbacks.onRemoveGlobalPin?.(index),
      onReorderGlobalPin: (from, to) => this.callbacks.onReorderGlobalPin?.(from, to),
      onShowGlobalChange: (shown) => {
        this.syncGlobalPinsMenuButton();
        this.callbacks.onShowGlobalPinsChange?.(shown);
      },
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
      defaultProfile: () => this.defaultProfile(),
    });
    this.layoutsSection = new LayoutsSection({
      onOpenLayout: (name) => this.callbacks.onOpenLayout?.(name),
      onSaveLayout: (name) => this.callbacks.onSaveLayout?.(name),
      onRenameLayout: (index, name) => this.callbacks.onRenameLayout?.(index, name),
      onRemoveLayout: (index) => this.callbacks.onRemoveLayout?.(index),
    });
    const keys = (action: string) => () => this.callbacks.actionKeys?.(action);
    this.favoritesMenuButton = topButton(
      'dashboard-top-icon dashboard-svg-icon',
      '',
      'Open a favorite folder',
      keys('openFavorite'),
      (b) => this.callbacks.onOpenFavoritesMenu?.(b),
    );
    this.favoritesMenuButton.append(heartIcon());
    this.layoutsMenuButton = topButton('dashboard-top-icon dashboard-svg-icon', '', 'Open a layout', keys('openLayout'), (b) =>
      this.callbacks.onOpenLayoutsMenu?.(b),
    );
    this.layoutsMenuButton.append(gridIcon());
    this.globalPinsMenuButton = topButton('dashboard-top-icon dashboard-svg-icon', '', 'Pins', () => undefined, (b) =>
      this.shown.pins ? this.callbacks.onOpenGlobalPinsMenu?.(b) : this.callbacks.onOpenPinPicker?.(b),
    );
    this.globalPinsMenuButton.append(pinIcon());
    const spacer = document.createElement('span');
    spacer.className = 'dashboard-top-spacer';
    this.launchMenuButton = topButton('dashboard-top-icon dashboard-launch', '+', 'Launch', keys('openLaunch'), (b) =>
      this.callbacks.onOpenLaunchMenu?.(b),
    );
    const helpButton = topButton('dashboard-top-icon', '?', 'Help', keys('showHelp'), () =>
      this.callbacks.onShowHelp(),
    );
    const settingsButton = topButton('dashboard-top-icon', '⚙', 'Settings', keys('openSettings'), () =>
      this.callbacks.onShowSettings(),
    );
    const hideButton = topButton(
      'dashboard-top-icon dashboard-hide',
      '×',
      'Hide the dashboard',
      keys('toggleDashboard'),
      () => {
        this.hide();
        this.callbacks.onHide?.();
      },
    );
    document.body.append(
      dashboardRevealHandle(
        () => {
          this.setOpen(true);
          this.callbacks.onReveal?.();
        },
        keys('toggleDashboard'),
      ),
    );
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
    top.append(this.launchMenuButton, this.favoritesMenuButton, this.layoutsMenuButton, this.globalPinsMenuButton, settingsButton, helpButton, spacer, hideButton);
    // Only the hooks offer lives here: one button per detected agent without them.
    const footer = document.createElement('div');
    footer.className = 'dashboard-footer';
    this.hooksFooter = footer;
    // Pins follow the focused pane and appear or vanish with it, so they stay fixed between the
    // slots rather than among the elements, and the lower list sits at the bottom, where a focus
    // change that resizes Pins never shifts it.
    this.columns = new DashboardColumnsView(root, {
      pins: this.pinsSection.el,
      pinsHead: this.pinsSection.head,
      footer,
      shown: (id) => this.shown[id],
      keepFocus: (relayout) => {
        const focus = this.nav.capture();
        relayout();
        this.nav.restore(focus);
      },
      onChange: () => this.callbacks.onOrderChange?.(),
    });
    root.append(resizeHandle, top, this.columns.el);
    this.addElement('launch', this.launchSection.el, this.launchSection.head);
    this.needsSection = new NeedsYouSection({
      onActivate: (item) => needsYouStore.activate(item),
      onHide: (item) => needsYouStore.hide(item),
    });
    this.addSection('needs', this.needsSection.el, this.needsSection.head);
    this.register('pins', this.pinsSection.el, this.pinsSection.head);
    this.addSection('favorites', this.favoritesSection.el, this.favoritesSection.head);
    this.addSection('layouts', this.layoutsSection.el, this.layoutsSection.head);
    this.terminalList = this.panesSection();
    this.containersSection = new ContainersSection({
      onOpenContainers: (keys) => this.callbacks.onOpenContainers?.(keys),
      onStart: (row) => this.callbacks.onStart?.(row),
      onStop: (row) => this.callbacks.onStop?.(row),
      onStartEngine: (engine) => this.callbacks.onStartEngine?.(engine),
      onShowStoppedChange: (shown) => this.callbacks.onShowStoppedChange?.(shown),
    });
    this.containersSection.setVisible(false);
    this.addSection('containers', this.containersSection.el, this.containersSection.head);
    const noPorts = (): void => {};
    this.portsSection = new PortsSection(
      this.callbacks.ports ?? {
        onOpenPorts: noPorts,
        ownerTitle: () => null,
        onGoToPane: noPorts,
        onOpenUrl: noPorts,
        onCopy: noPorts,
        onStop: noPorts,
      },
    );
    this.addSection('ports', this.portsSection.el, this.portsSection.head);
    this.shipSection = new ShipSection({
      onOpenShip: (target, tab) => this.callbacks.onOpenShip?.(target, tab),
    });
    this.addSection('ship', this.shipSection.el, this.shipSection.head);
    this.branchSection = new BranchSection({
      onOpenGit: (worktree) => this.callbacks.onOpenGit?.(worktree),
      onOpenShip: (worktree, tab) => this.callbacks.onOpenShip?.(worktree, tab),
    });
    this.branchController = new BranchSectionController(this.branchSection);
    this.addSection('branch', this.branchSection.el, this.branchSection.head);
    this.addSection('localModels', this.localModelsSection.el, this.localModelsSection.head);
    this.sessionList = this.section('external', 'External sessions');
    this.addSection('system', this.system.el, this.system.head);
    this.addElement('clock', this.clock.el, this.clock.el);
    attachContextMenu(this.clock.el, () => ({
      entries: clockMenuItems(
        this.clockStyle,
        (style) => this.callbacks.onSetClockStyle?.(style),
        () => this.callbacks.onSetElementShown?.('clock', false),
      ),
    }));
    this.addElement('wave', this.wave.el, this.wave.el);
    this.nav = new DashboardNav(root, {
      onLeave: () => this.leave(),
      onKey: (e) => this.callbacks.onKey?.(e) ?? false,
    });
    this.layoutElements();
    this.renderNeeds();
    shipOverviewStore.subscribe(() => this.renderShip());
    needsYouStore.subscribe(() => this.renderNeeds());
    branchSizeStore.subscribe(() => {
      if ((this.open || this.peeking) && this.cardBadgesKey !== this.badgesKey()) this.render();
    });
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

  /** Follows the store; the section polls it only while on screen and expanded (`syncTimers`). */
  setPortsStore(store: PortsStore): void {
    this.unsubscribePorts?.();
    this.portsStore = store;
    this.unsubscribePorts = store.subscribe(() => this.renderPorts());
    this.renderPorts();
    this.syncTimers();
  }

  /** Follows the store; the section polls it only while on screen and expanded (`syncTimers`), and the Panes cards read it for a window. */
  setLocalModelsStore(store: LocalModelsStore): void {
    this.unsubscribeLocalModels?.();
    this.localModelsStore = store;
    this.unsubscribeLocalModels = store.subscribe(() => this.renderLocalModels());
    this.renderLocalModels();
    this.syncTimers();
  }

  private renderLocalModels(): void {
    const store = this.localModelsStore;
    if (!store) return;
    const focus = this.nav.capture();
    this.localModelsSection.update(store.current(), this.minContext);
    this.nav.restore(focus);
    if (this.open || this.peeking) this.render();
  }

  /** The context length of the loaded Ollama model this session runs, which fills the card's window. */
  private defaultProfile(): string {
    return this.callbacks.defaultProfile?.() ?? GIT_BASH_PROFILE.id;
  }

  private loadedWindow(sessionId: string): number | null {
    const model = this.agentContexts.get(sessionId)?.model;
    return findLoadedOllama(this.localModelsStore?.current() ?? null, model)?.contextLength ?? null;
  }

  private renderPorts(): void {
    const store = this.portsStore;
    if (!store) return;
    const focus = this.nav.capture();
    this.portsSection.update(store.current(), store.ready);
    this.nav.restore(focus);
  }

  private renderNeeds(): void {
    const focus = this.nav.capture();
    this.needsRenderedAt = Date.now();
    this.needsSection.update(needsYouStore.items(), this.needsRenderedAt);
    this.nav.restore(focus);
  }

  private renderShip(): void {
    const focus = this.nav.capture();
    this.shipSection.update();
    this.nav.restore(focus);
  }

  private renderContainers(): void {
    const store = this.containersStore;
    if (!store) return;
    const focus = this.nav.capture();
    this.containersSection.update(store.current());
    this.containersSection.setVisible(store.available);
    this.nav.restore(focus);
  }

  /**
   * Applies `dashboard.side`, `dashboard.sections`, `dashboard.clockStyle`, and `dashboard.portRows`
   * (docs/design/dashboard.md section 4.6).
   */
  applyDashboardSettings(d: Settings['dashboard'], minContext: number): void {
    this.shown = { ...d.sections };
    this.minContext = minContext;
    this.localModelsSection.update(this.localModelsStore?.current() ?? null, minContext);
    this.clockStyle = d.clockStyle;
    this.clock.setStyle(d.clockStyle);
    this.portsSection.setMaxRows(d.portRows);
    this.renderPorts();
    this.setSide(d.side);
    this.layoutElements();
    this.syncTimers();
  }

  /** Applies a saved placement without firing `onOrderChange`; absent parts keep their defaults. */
  setPlacement(saved: {
    order?: DashboardElement[];
    top?: DashboardElement[];
    right?: DashboardElement[];
    pinsColumn?: DashboardColumn;
  }): void {
    this.columns.setPlacement(saved);
  }

  sectionOrder(): DashboardElement[] {
    return this.columns.sectionOrder();
  }

  topElements(): DashboardElement[] {
    return this.columns.topElements();
  }

  /** Null until the panel first shows two columns. */
  rightElements(): DashboardElement[] | null {
    return this.columns.rightElements();
  }

  pinsColumn(): DashboardColumn {
    return this.columns.pinsColumnName();
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
   * while collapsed (docs/design/dashboard.md section 4.6). Called whenever any input changes.
   */
  private syncTimers(): void {
    const onScreen = this.isShown();
    this.clock.setRunning(this.shown.clock && onScreen && this.windowShown);
    this.wave.setRunning(this.shown.wave && onScreen && this.windowShown);
    this.portsStore?.setWanted(
      'dashboard',
      this.shown.ports && !this.collapsed.includes('ports') && onScreen && this.windowShown,
    );
    // Needs you feeds the walk and the toasts too, so Ship polls for it with the dashboard closed or
    // Ship hidden.
    shipOverviewStore.setWanted('needs', this.shown.needs && this.windowShown);
    shipOverviewStore.setWanted(
      'dashboard',
      this.shown.ship && !this.collapsed.includes('ship') && onScreen && this.windowShown,
    );
    this.localModelsStore?.setWanted(
      'dashboard',
      this.shown.localModels && !this.collapsed.includes('localModels') && onScreen && this.windowShown,
    );
    this.branchController.setWanted(
      this.shown.branch && !this.collapsed.includes('branch') && onScreen && this.windowShown,
    );
    this.syncCardFolders();
    this.system.setGate({
      enabled: this.shown.system,
      expanded: !this.collapsed.includes('system'),
      onScreen,
      windowShown: this.windowShown,
    });
    // Codex limits ride the transcript worker, so the Needs you list keeps it running too.
    this.agentContexts.setEnabled(this.shown.panes || this.shown.needs);
  }

  private layoutElements(): void {
    // A hidden section's list stays reachable from the top bar (docs/design/dashboard.md
    // section 4.6).
    this.favoritesMenuButton.hidden = this.shown.favorites;
    this.layoutsMenuButton.hidden = this.shown.layouts;
    this.launchMenuButton.hidden = this.shown.launch;
    this.pinsSection.setEnabled(this.shown.pins);
    this.syncGlobalPinsMenuButton();
    this.columns.layout();
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
   * Moves keyboard focus into the panel (docs/design/dashboard.md section 4.6). A hidden panel
   * shows as a peek that lasts until focus leaves it.
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

  /**
   * Shows an install button for each of `agents`, the detected ones whose hooks are missing;
   * `update` labels it Update when nothing is missing but existing entries or the hook program
   * are out of date.
   */
  setMissingHooks(agents: { agent: AgentId; update: boolean }[]): void {
    this.hooksFooter.replaceChildren(
      ...agents.map(({ agent, update }) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'hooks-install';
        button.textContent = `${update ? 'Update' : 'Install'} ${agentName(agent)} hooks${isPreviewAgent(agent) ? ' (preview)' : ''}`;
        button.addEventListener('click', () => this.callbacks.onInstallHooks(agent));
        return button;
      }),
    );
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
    this.syncCardFolders();
    if (this.open || this.peeking) this.render();
  }

  setFavorites(favorites: Favorite[]): void {
    this.favorites = favorites;
    if (this.open || this.peeking) this.render();
  }

  setRepo(state: RepoState): void {
    this.repo = state;
    this.branchController.setRepo(state.repo);
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

  private panesSection(): HTMLElement {
    const section = document.createElement('section');
    section.className = 'dashboard-section';
    const head = document.createElement('div');
    head.className = 'dashboard-section-head';
    const h = document.createElement('h2');
    h.textContent = 'Panes';
    const paths = document.createElement('button');
    paths.type = 'button';
    paths.className = 'panes-paths';
    paths.textContent = '↳';
    paths.setAttribute('aria-label', 'Folder paths');
    paths.addEventListener('click', () => {
      this.setShowPanePaths(!this.showPanePaths);
      this.callbacks.onPanePathsChange?.(this.showPanePaths);
    });
    this.panePathsButton = paths;
    this.syncPanePathsButton();
    const agents = document.createElement('button');
    agents.type = 'button';
    agents.className = 'panes-agents';
    agents.setAttribute('aria-label', 'AI sessions only');
    agents.addEventListener('click', () => {
      this.setAgentPanesOnly(!this.agentPanesOnly);
      this.callbacks.onAgentPanesOnlyChange?.(this.agentPanesOnly);
    });
    this.agentPanesButton = agents;
    this.syncAgentPanesButton();
    head.append(h, agents, paths);
    const list = document.createElement('div');
    list.className = 'dashboard-list';
    section.append(head, list);
    this.addSection('panes', section, head);
    return list;
  }

  private syncPanePathsButton(): void {
    this.panePathsButton.setAttribute('aria-pressed', String(this.showPanePaths));
    this.panePathsButton.title = this.showPanePaths ? 'Hide folder paths' : 'Show folder paths';
  }

  /** Applies the saved Panes path toggle without firing `onPanePathsChange`. */
  setShowPanePaths(shown: boolean): void {
    if (shown === this.showPanePaths) return;
    this.showPanePaths = shown;
    this.syncPanePathsButton();
    if (this.open || this.peeking) this.render();
  }

  panePathsShown(): boolean {
    return this.showPanePaths;
  }

  private syncAgentPanesButton(): void {
    this.agentPanesButton.setAttribute('aria-pressed', String(this.agentPanesOnly));
    this.agentPanesButton.title = this.agentPanesOnly ? 'Show all panes' : 'Show only AI sessions';
    this.agentPanesButton.replaceChildren(sparkleIcon(this.agentPanesOnly));
  }

  /** Applies the saved Panes AI filter without firing `onAgentPanesOnlyChange`. */
  setAgentPanesOnly(only: boolean): void {
    if (only === this.agentPanesOnly) return;
    this.agentPanesOnly = only;
    this.syncAgentPanesButton();
    if (this.open || this.peeking) this.render();
  }

  agentPanesOnlyShown(): boolean {
    return this.agentPanesOnly;
  }

  /** Applies the saved global pins toggle without firing `onShowGlobalPinsChange`. */
  setShowGlobalPins(shown: boolean): void {
    this.pinsSection.setShowGlobal(shown);
    this.syncGlobalPinsMenuButton();
  }

  /**
   * The pin button stands in for the global pins the Pins section leaves out, or for the whole
   * section while it is hidden (docs/design/dashboard.md section 4.6).
   */
  private syncGlobalPinsMenuButton(): void {
    this.globalPinsMenuButton.hidden = this.shown.pins && this.pinsSection.globalShown();
  }

  globalPinsShown(): boolean {
    return this.pinsSection.globalShown();
  }

  /** Applies the saved Containers stopped-groups toggle without firing `onShowStoppedChange`. */
  setShowStoppedContainers(shown: boolean): void {
    this.containersSection.setShowStopped(shown);
  }

  stoppedContainersShown(): boolean {
    return this.containersSection.stoppedShown();
  }

  private addSection(id: DashboardSection & DashboardElement, section: HTMLElement, header: HTMLElement): void {
    this.register(id, section, header);
    this.addElement(id, section, header);
  }

  private addElement(id: DashboardElement, el: HTMLElement, handle: HTMLElement): void {
    this.columns.add(id, el, handle);
  }

  /** The terminal cards' folders, wanted by the branch size store only while their cards can show. */
  private syncCardFolders(): void {
    const on = this.shown.panes && this.isShown() && this.windowShown;
    const folders = on ? this.cardFolders() : [];
    const key = JSON.stringify(folders);
    if (key === this.cardFoldersKey) return;
    this.cardFoldersKey = key;
    branchSizeStore.setWanted('cards', folders);
  }

  private cardFolders(): string[] {
    const out = new Set<string>();
    for (const p of this.panes) if (p.kind === 'terminal' && p.cwd && !p.containerName) out.add(p.cwd);
    return [...out];
  }

  private sizeBadge(folder: string): { text: string; title: string } | null {
    const size = branchSizeStore.sizeFor(folder);
    return size !== null && isOverThreshold(size, branchSizeStore.threshold())
      ? { text: badgeText(size), title: badgeTitle(size) }
      : null;
  }

  private badgesKey(): string {
    return JSON.stringify(this.cardFolders().map((f) => this.sizeBadge(f)));
  }

  private render(): void {
    const focus = this.nav.capture();
    this.renderSections();
    this.nav.restore(focus);
    // The store pushes every change; this only keeps ages current on the open panel's timer.
    if (Date.now() - this.needsRenderedAt >= NEEDS_AGE_MS) this.renderNeeds();
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
    const key = JSON.stringify([this.favorites, recents, canAdd, this.defaultProfile()]);
    if (key !== this.favoritesKey) {
      this.favoritesKey = key;
      this.favoritesSection.update(this.favorites, recents, canAdd);
    }

    const repoKey = JSON.stringify(this.repo);
    if (repoKey !== this.repoKey) {
      this.repoKey = repoKey;
      this.launchSection.update(this.repo.repo ? this.repo.repo.isGit : null);
      this.pinsSection.update(this.repo);
    }

    const layoutsKey = JSON.stringify(this.layouts.map((l) => [l.name, l.tab.panes.length]));
    if (layoutsKey !== this.layoutsKey) {
      this.layoutsKey = layoutsKey;
      this.layoutsSection.update(this.layouts);
    }

    this.cardBadgesKey = this.badgesKey();
    // Group headers appear only with two or more tabs (docs/design/dashboard.md section 4.6).
    const cardOptions = (card: (typeof cards)[number]) => ({
      now,
      agentLine:
        card.kind === 'terminal' && card.sessionId !== null
          ? agentLine(
              this.sessions.find((s) => s.sessionId === card.sessionId)?.agent ?? 'claude',
              this.agentContexts.get(card.sessionId),
              this.loadedWindow(card.sessionId),
            )
          : null,
      sizeBadge: card.kind === 'terminal' && card.path !== '' ? this.sizeBadge(card.path) : null,
      showPath: this.showPanePaths,
      defaultProfile: this.defaultProfile(),
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
    // The AI filter leaves each tab's count and status alone; only the card list narrows. A
    // group header already shows its tab's pane count, so the folded row appears only without
    // headers, where it is the sole sign the filtered-out panes exist.
    const renderCards = (list: PaneCard[], withHeader: boolean): HTMLElement[] => {
      const { cards: kept, others } = agentCards(list, this.agentPanesOnly);
      const els = kept.map((card) => renderPaneCard(card, cardOptions(card)));
      if (others > 0 && !withHeader) {
        const row = document.createElement('div');
        row.className = 'panes-others';
        row.textContent = otherPanesLabel(others, kept.length === 0);
        els.push(row);
      }
      return els;
    };
    const groups = groupCardsByTab(cards, this.tabs);
    const showHeaders = groups.length > 1;
    // A status or age refresh would destroy a group header's open rename field; the commit
    // re-renders once the field is gone.
    const renaming = this.terminalList.querySelector('.favorite-rename') !== null;
    if (!renaming) this.terminalList.replaceChildren(
      ...(showHeaders
        ? groups.map((g) =>
            renderPaneGroup(
              g,
              renderCards(g.cards, true),
              {
                onSwitchTab: (tabId) => this.callbacks.onSwitchTab?.(tabId),
                onRename: (tabId, name) => this.callbacks.onRenameTab?.(tabId, name),
              },
            ),
          )
        : renderCards(cards, false)),
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
