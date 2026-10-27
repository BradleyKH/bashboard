import type { PaneKind } from './paneKinds';
import { sessionHue } from './sessionHue';
import type { Session, SessionStatus } from './sessions';
import { terminalStatus, type ShellStatus, type TerminalStatus } from './terminalStatus';

export type { TerminalStatus };

export interface TerminalCardInput {
  kind: 'terminal';
  paneId: string;
  tabId: string;
  ptyId: number | null;
  cwd: string | null;
  profile: string;
  focused: boolean;
  openedAt: number;
  collapsed: boolean;
  shell: ShellStatus;
  attention: boolean;
  /** An unseen Stop is pending (docs/design.md section 4.8); shows an idle terminal as done. */
  done: boolean;
  /** Set for a container shell, which the card titles by the container's name. */
  containerName?: string;
}

/** A pane of any kind other than a terminal (docs/design.md section 4.11). */
export interface OtherCardInput {
  kind: Exclude<PaneKind, 'terminal'>;
  paneId: string;
  tabId: string;
  title: string;
  folder: string | null;
  /** A Files pane's repo, which the Repo section follows instead of the folder shown. */
  root?: string;
  focused: boolean;
  collapsed: boolean;
  /** Epoch ms. */
  openedAt: number;
  /** Closing would lose content, so the card asks first. */
  confirmClose: boolean;
}

export type PaneCardInput = TerminalCardInput | OtherCardInput;

export interface TerminalCard {
  kind: 'terminal';
  paneId: string;
  tabId: string;
  title: string;
  path: string;
  profile: string;
  status: TerminalStatus;
  statusChangedAt: number;
  focused: boolean;
  sessionId: string | null;
  /** See `isBusy`; closing the card asks first. */
  busy: boolean;
  collapsed: boolean;
  attention: boolean;
  hue: number | null;
  containerName: string | null;
}

export interface OtherCard {
  kind: Exclude<PaneKind, 'terminal'>;
  paneId: string;
  tabId: string;
  title: string;
  /** Empty when the pane has no folder. */
  path: string;
  focused: boolean;
  collapsed: boolean;
  busy: boolean;
  attention: false;
}

export type PaneCard = TerminalCard | OtherCard;

const EXTERNAL_ORDER: Record<SessionStatus, number> = {
  waiting: 0,
  busy: 1,
  idle: 2,
  unknown: 3,
};

/** Last folder of a Windows or POSIX path; a drive root `C:\` gives `C:`. */
export function lastFolder(path: string): string {
  const parts = path.split(/[\\/]+/).filter((p) => p.length > 0);
  return parts.length > 0 ? parts[parts.length - 1] : '';
}

export function formatAge(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 10) return 'now';
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

export function boundSession(ptyId: number | null, sessions: Session[]): Session | null {
  if (ptyId === null) return null;
  let best: Session | null = null;
  for (const s of sessions) {
    if (s.paneId === ptyId && (best === null || s.startedAt > best.startedAt)) best = s;
  }
  return best;
}

/** Closing would interrupt it: a bound Claude session or a running command. */
export function isBusy(t: TerminalCardInput, sessions: Session[]): boolean {
  return boundSession(t.ptyId, sessions) !== null || t.shell.status === 'working';
}

function terminalCard(t: TerminalCardInput, sessions: Session[]): TerminalCard {
  const session = boundSession(t.ptyId, sessions);
  const folder = t.cwd ? lastFolder(t.cwd) : '';
  const base = terminalStatus(session, t.shell);
  const { status, changedAt } = t.done && base.status === 'idle' ? { ...base, status: 'done' as const } : base;
  return {
    kind: 'terminal',
    paneId: t.paneId,
    tabId: t.tabId,
    title: t.containerName || session?.name || folder || '~',
    path: t.containerName ? '' : (t.cwd ?? ''),
    profile: t.profile,
    status,
    statusChangedAt: changedAt,
    focused: t.focused,
    sessionId: session ? session.sessionId : null,
    busy: isBusy(t, sessions),
    collapsed: t.collapsed,
    attention: t.attention,
    hue: session ? sessionHue(session) : null,
    containerName: t.containerName ?? null,
  };
}

export function paneCards(panes: PaneCardInput[], sessions: Session[]): PaneCard[] {
  return panes.map((p): PaneCard =>
    p.kind === 'terminal'
      ? terminalCard(p, sessions)
      : {
          kind: p.kind,
          paneId: p.paneId,
          tabId: p.tabId,
          title: p.title,
          path: p.folder ?? '',
          focused: p.focused,
          collapsed: p.collapsed,
          busy: p.confirmClose,
          attention: false,
        },
  );
}

export function externalSessions(
  sessions: Session[],
  panes: PaneCardInput[],
): Session[] {
  const ptys = new Set<number>();
  for (const t of panes) if (t.kind === 'terminal' && t.ptyId !== null) ptys.add(t.ptyId);
  return sessions
    .filter((s) => s.paneId === null || !ptys.has(s.paneId))
    .sort(
      (a, b) =>
        EXTERNAL_ORDER[a.status] - EXTERNAL_ORDER[b.status] ||
        b.statusChangedAt - a.statusChangedAt,
    );
}

/** The tab fields a group header needs; `TabInfo` satisfies it. */
export interface TabGroupInput {
  id: string;
  title: string;
  active: boolean;
  status: TerminalStatus;
  attention: boolean;
}

export interface PaneGroup {
  tabId: string;
  title: string;
  count: number;
  status: TerminalStatus;
  active: boolean;
  attention: boolean;
  cards: PaneCard[];
}

/** Cards grouped by tab in tab-strip order; each group keeps its cards' incoming order. */
export function groupCardsByTab(cards: PaneCard[], tabs: TabGroupInput[]): PaneGroup[] {
  return tabs.map((tab) => {
    const own = cards.filter((c) => c.tabId === tab.id);
    return {
      tabId: tab.id,
      title: tab.title,
      count: own.length,
      status: tab.status,
      active: tab.active,
      attention: tab.attention,
      cards: own,
    };
  });
}
