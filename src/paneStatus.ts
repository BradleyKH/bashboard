import { cloudContextStore } from './cloudContextStore';
import { isBusy, lastFolder, type PaneCardInput } from './dashboardModel';
import { TerminalPane } from './pane';
import type { PaneRun } from './paneRunModel';
import { viewCardInput, viewTitle } from './paneInfo';
import type { PaneView } from './paneView';
import { combinedStatus, tabTitle, type TabState } from './tabs';
import type { TabStore } from './tabStore';
import type { TerminalStatus } from './terminalStatus';
import type { TitleStrip } from './titleStrip';
import type { WorkspaceSessions } from './workspaceSessions';
import type { TabInfo, TerminalInfo } from './workspaceTypes';

/** What pane titles and statuses read of the workspace. */
export interface PaneStatusContext {
  readonly store: TabStore;
  readonly paneViews: ReadonlyMap<string, PaneView>;
  readonly hosts: ReadonlyMap<string, HTMLElement>;
  readonly containerShells: ReadonlyMap<string, string>;
  readonly sessions: WorkspaceSessions;
  defaultProfile(): string;
  hasAttention(id: string): boolean;
  /** Feeds a terminal's status to attention; true when that raised it. */
  observeAttention(id: string, status: TerminalStatus): boolean;
  /** The CI run bound to a terminal (docs/design/ship.md section 4.26). */
  paneRun(id: string): PaneRun | null;
}

/**
 * Each pane's title, its terminal status (docs/design/terminal.md section 4.8), and the title
 * strip that shows them, plus the dashboard card input built from the same facts.
 */
export class PaneStatus {
  private readonly strips = new Map<string, TitleStrip>();
  /** What each terminal's strip last showed; a change in a background tab must still redraw the tab strip. */
  private readonly stripShown = new Map<string, string>();
  private readonly opened = new Map<string, number>();

  constructor(private readonly ctx: PaneStatusContext) {}

  /** Takes on a new pane's strip, marking it opened now. */
  register(id: string, strip: TitleStrip): void {
    this.strips.set(id, strip);
    this.opened.set(id, Date.now());
  }

  forget(id: string): void {
    this.strips.delete(id);
    this.stripShown.delete(id);
    this.opened.delete(id);
  }

  strip(id: string): TitleStrip | undefined {
    return this.strips.get(id);
  }

  /** The status and reason the terminal's strip last showed, for spotting a change. */
  shown(id: string): string | undefined {
    return this.stripShown.get(id);
  }

  /** Epoch ms the pane opened, or 0 for an unknown pane. */
  openedAt(id: string): number {
    return this.opened.get(id) ?? 0;
  }

  resolved(id: string): { status: TerminalStatus; changedAt: number } {
    return this.ctx.sessions.resolve(id, this.terminal(id), this.openedAt(id));
  }

  status(id: string): TerminalStatus {
    return this.resolved(id).status;
  }

  mark(id: string): TerminalInfo['mark'] {
    const { status, changedAt } = this.resolved(id);
    return status === 'done' || status === 'failed' ? { status, at: changedAt } : null;
  }

  waitingReason(id: string): string {
    return this.ctx.sessions.waitingReason(this.terminal(id));
  }

  /** Design 4.11: a tab's name follows this, so a pad's first line names its tab. */
  title(id: string): string {
    const pane = this.ctx.paneViews.get(id);
    const own = viewTitle(pane);
    if (own !== null) return own;
    if (!(pane instanceof TerminalPane)) return '~';
    const container = this.ctx.containerShells.get(id);
    if (container !== undefined) return container;
    const session = this.ctx.sessions.bound(pane.ptyId);
    return session?.name || (pane.cwd ? lastFolder(pane.cwd) : '') || '~';
  }

  /** Every status change passes through here, so it also feeds attention; true when raised. */
  refresh(id: string): boolean {
    const strip = this.strips.get(id);
    const pane = this.ctx.paneViews.get(id);
    if (!strip || !pane) return false;
    if (!(pane instanceof TerminalPane)) {
      strip.update({ title: this.title(id), path: pane.folder ?? '' });
      return false;
    }
    const status = this.status(id);
    const reason = status === 'waiting' ? this.waitingReason(id) : '';
    const cloud = cloudContextStore.chipsFor(pane.cloudState());
    strip.update({
      title: this.title(id),
      path: this.ctx.containerShells.get(id) ?? pane.cwd ?? '',
      status,
      ...(status === 'waiting' && { reason }),
      cloud,
    });
    this.stripShown.set(id, `${status}|${reason}|${cloud.map((c) => c.text).join('|')}`);
    // Agent glow (design 4.23) is for an agent at work, not a busy shell command.
    const agentBusy = this.ctx.sessions.agentWorking(pane);
    this.ctx.hosts.get(id)?.classList.toggle('agent-working', agentBusy);
    return this.ctx.observeAttention(id, status);
  }

  cardInput(tab: TabState, paneId: string): PaneCardInput | null {
    const { ctx } = this;
    const pane = ctx.paneViews.get(paneId);
    if (!pane) return null;
    const common = {
      paneId,
      tabId: tab.id,
      focused: paneId === ctx.store.focusedId,
      openedAt: this.openedAt(paneId),
      collapsed: tab.collapsed.includes(paneId),
    };
    if (pane instanceof TerminalPane) {
      return {
        ...common,
        kind: 'terminal',
        ptyId: pane.ptyId,
        cwd: pane.cwd,
        profile: pane.profile ?? ctx.defaultProfile(),
        shell: ctx.sessions.shellOf(pane, this.openedAt(paneId)),
        program: pane.programState(),
        cloud: cloudContextStore.chipsFor(pane.cloudState()),
        attention: ctx.hasAttention(paneId),
        mark: this.mark(paneId),
        run: ctx.paneRun(paneId),
        ...(ctx.containerShells.has(paneId) && { containerName: ctx.containerShells.get(paneId) }),
      };
    }
    return viewCardInput(pane, common);
  }

  /** One tab as the tab strip and dashboard show it (docs/design/workspace.md section 4.10). */
  tabInfo(tab: TabState): TabInfo {
    return {
      id: tab.id,
      title: tabTitle(tab, this.title(tab.focusedId || (tab.panes[0] ?? ''))),
      name: tab.name,
      active: tab.id === this.ctx.store.activeId,
      paneCount: tab.panes.length,
      status: combinedStatus(tab.panes.filter((id) => this.terminal(id)).map((id) => this.status(id))),
      attention: tab.panes.some((id) => this.ctx.hasAttention(id)),
      waiting: tab.panes
        .filter((id) => this.terminal(id) && this.status(id) === 'waiting')
        .map((id) => ({ title: this.title(id), reason: this.waitingReason(id) })),
    };
  }

  /** Closing would lose work: a busy terminal, or a pane whose card asks first. */
  losesWork(p: PaneCardInput): boolean {
    return p.kind === 'terminal' ? isBusy(p, this.ctx.sessions.sessions) : p.confirmClose;
  }

  private terminal(id: string): TerminalPane | undefined {
    const pane = this.ctx.paneViews.get(id);
    return pane instanceof TerminalPane ? pane : undefined;
  }
}
