import { attachContextMenu } from './contextMenu';
import { copyPath } from './copyText';
import { formatAge, type PaneCard } from './dashboardModel';
import { setPathText } from './displayPath';
import { folderButton, openFolder } from './folderButton';
import { openInMenuItems, openMenuButton, type OpenInHandler } from './openMenu';
import { paneCardMenuItems } from './paneCardMenus';
import { paneKindInfo } from './paneKinds';
import { profileBadge } from './profiles';

export interface PaneCardOptions {
  now: number;
  /** The bound Claude session's model and context size, shown under the path; null for none. */
  agentLine: string | null;
  /** Shows the folder path under the title; hidden, the path moves into the title's tooltip. */
  showPath: boolean;
  /** `shell.defaultProfile`; a terminal running it shows no profile badge. */
  defaultProfile: string;
  /** True while the card shows its inline close confirmation. */
  confirming: boolean;
  onFocus: (paneId: string) => void;
  onClose: (paneId: string) => void;
  /** Collapses or expands the pane; omitted, the card's menu has no such item. */
  onToggleCollapse?: (paneId: string) => void;
  onConfirmChange: (paneId: string, confirming: boolean) => void;
  /** Called once the pointer moves past the drag threshold; the card then swallows the click. */
  onDragStart?: (paneId: string, e: PointerEvent) => void;
  /** Open menu beside the folder button; omitted, the card shows none. */
  onOpenIn?: OpenInHandler;
}

const DRAG_THRESHOLD = 4;
/** Must match the `card-waiting` animation's duration in styles.css. */
const WAITING_PULSE_MS = 2400;

function button(label: string, className: string, onClick: () => void): HTMLButtonElement {
  const el = document.createElement('button');
  el.type = 'button';
  el.className = className;
  el.textContent = label;
  el.addEventListener('click', (e) => {
    // The card itself focuses its pane on click.
    e.stopPropagation();
    onClick();
  });
  return el;
}

/** One card in the dashboard's Panes section (docs/design/dashboard.md section 4.6). */
export function renderPaneCard(card: PaneCard, opts: PaneCardOptions): HTMLElement {
  const el = document.createElement('div');
  el.className = 'terminal-card';
  el.classList.toggle('focused', card.focused);
  el.dataset.paneId = card.paneId;
  el.classList.toggle('collapsed', card.collapsed);
  el.classList.toggle('attention', card.attention);
  if (card.kind === 'terminal' && card.status === 'waiting') {
    el.classList.add('waiting');
    // The panel rebuilds its cards often; phasing the pulse off the wall clock keeps it smooth across rebuilds.
    el.style.setProperty('--waiting-phase', `-${Date.now() % WAITING_PULSE_MS}ms`);
  }

  let dragged = false;
  el.addEventListener('click', () => {
    // The click that ends a drag must not also focus or expand.
    if (dragged) {
      dragged = false;
      return;
    }
    opts.onFocus(card.paneId);
  });
  if (opts.onDragStart) {
    const onDragStart = opts.onDragStart;
    el.addEventListener('pointerdown', (down) => {
      // A drag the overlay consumed never reaches this card's click, so reset here.
      dragged = false;
      if (down.button !== 0 || (down.target as HTMLElement).closest('button')) return;
      const startX = down.clientX;
      const startY = down.clientY;
      // Keeps the moves coming once the pointer leaves the card; the overlay takes capture over.
      el.setPointerCapture(down.pointerId);
      const cleanup = () => {
        if (el.hasPointerCapture(down.pointerId)) el.releasePointerCapture(down.pointerId);
        el.removeEventListener('pointermove', onMove);
        el.removeEventListener('pointerup', cleanup);
        el.removeEventListener('pointercancel', cleanup);
      };
      const onMove = (move: PointerEvent) => {
        if (Math.hypot(move.clientX - startX, move.clientY - startY) < DRAG_THRESHOLD) return;
        cleanup();
        dragged = true;
        onDragStart(card.paneId, move);
      };
      el.addEventListener('pointermove', onMove);
      el.addEventListener('pointerup', cleanup);
      el.addEventListener('pointercancel', cleanup);
    });
  }

  // What the × does: a busy card asks inline first.
  const requestClose = (): void => {
    if (card.busy) opts.onConfirmChange(card.paneId, true);
    else opts.onClose(card.paneId);
  };
  const onToggleCollapse = opts.onToggleCollapse;
  attachContextMenu(el, async () => {
    const openItems = card.path && opts.onOpenIn ? await openInMenuItems(card.path, opts.onOpenIn) : [];
    return {
      target: el,
      entries: paneCardMenuItems(card, openItems, {
        onFocus: () => opts.onFocus(card.paneId),
        onToggleCollapse: onToggleCollapse && (() => onToggleCollapse(card.paneId)),
        onOpenInExplorer: openFolder,
        onCopyPath: (path) => void copyPath(path),
        onClose: requestClose,
      }),
    };
  });

  const head = document.createElement('div');
  head.className = 'card-head';

  let lead: HTMLElement;
  if (card.kind === 'terminal') {
    lead = document.createElement('span');
    lead.className = `status-dot ${card.status}`;
    lead.title = card.status;
  } else {
    const info = paneKindInfo(card.kind);
    lead = document.createElement('span');
    lead.className = 'kind-icon';
    lead.textContent = info.icon;
    lead.title = info.label;
  }

  const title = document.createElement('span');
  title.className = 'card-title';
  title.textContent = card.title;
  title.title = card.path && !opts.showPath ? `${card.title}\n${card.path}` : card.title;

  head.append(lead, title);
  if (card.collapsed) {
    const marker = document.createElement('span');
    marker.className = 'card-collapsed';
    marker.textContent = 'collapsed';
    head.append(marker);
  }
  if (card.kind === 'terminal') {
    const badge = card.containerName ? null : profileBadge(card.profile, opts.defaultProfile);
    if (badge) head.append(badge);
    const age = document.createElement('span');
    age.className = 'card-age';
    age.textContent = formatAge(opts.now - card.statusChangedAt);
    head.append(age);
  }
  if (card.path) head.append(folderButton(card.path));
  if (card.path && opts.onOpenIn) head.append(openMenuButton(card.path, opts.onOpenIn));

  if (opts.confirming) {
    const confirm = document.createElement('span');
    confirm.className = 'card-confirm';
    const label = document.createElement('span');
    label.textContent = 'Close?';
    confirm.append(
      label,
      button('Yes', 'card-confirm-yes', () => opts.onClose(card.paneId)),
      button('No', 'card-confirm-no', () => opts.onConfirmChange(card.paneId, false)),
    );
    head.append(confirm);
  } else {
    const close = button('×', 'card-close', requestClose);
    close.title = card.kind === 'terminal' ? 'Close terminal' : 'Close pane';
    head.append(close);
  }

  el.append(head);
  if (card.kind === 'terminal' && card.reason !== null) {
    const reason = document.createElement('div');
    reason.className = 'card-reason';
    reason.textContent = card.reason;
    reason.title = card.reason;
    el.append(reason);
  } else if (card.path && opts.showPath) {
    const path = document.createElement('div');
    path.className = 'card-path';
    setPathText(path, card.path);
    el.append(path);
  }
  if (opts.agentLine !== null) {
    const line = document.createElement('div');
    line.className = 'card-agent';
    const text = document.createElement('span');
    text.className = 'card-agent-text';
    text.textContent = opts.agentLine;
    text.title = opts.agentLine;
    line.append(text);
    el.append(line);
  }
  return el;
}
