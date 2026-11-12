import { ContainersPane } from './containersPane';
import { FilesPane } from './filesPane';
import { GitPane } from './gitPane';
import type { Layout } from './layout';
import { LocalBrowserPane } from './localBrowserPane';
import { TerminalPane } from './pane';
import type { PaneKind } from './paneKinds';
import { fallbackSpec, restoredSpec } from './paneSpecModel';
import { reportError } from './errorReport';
import { showToast } from './toast';
import type { PaneView } from './paneView';
import { scratchLoad, scrollbackLoad, scrollbackSave, scrollbackSaveAll, type ScrollbackEntry } from './persistence';
import { PortsPane } from './portsPane';
import { restoredTab, snapshotTabs } from './savedTabs';
import { resumeCommand, type PtyRef, type SavedPane, type SavedTab, type SavedWorkspace } from './savedWorkspace';
import { ScratchPane } from './scratchPane';
import { SearchPane } from './searchPane';
import { ShipPane } from './shipPane';
import { addTab, type TabState } from './tabs';
import type { TabStore } from './tabStore';
import type { WorkspaceSessions } from './workspaceSessions';
import type { PaneSpec } from './workspaceTypes';

/** What saving and restoring read of the workspace and the pane lifecycle steps they drive. */
export interface PersistenceContext {
  readonly store: TabStore;
  readonly paneViews: ReadonlyMap<string, PaneView>;
  readonly hosts: ReadonlyMap<string, HTMLElement>;
  readonly containerShells: ReadonlyMap<string, string>;
  readonly sessions: WorkspaceSessions;
  takeId(): string;
  takeIdFor(kind: PaneKind): string;
  terminal(id: string): TerminalPane | undefined;
  createHost(id: string): HTMLElement;
  render(): void;
  mount(id: string, tree: Layout, spec: PaneSpec): void;
  buildPane(id: string, host: HTMLElement, spec: PaneSpec, expanded: boolean, onReady?: () => void): PaneView;
  startPane(id: string, pane: PaneView): void;
  openOffscreen(id: string, spec: PaneSpec, onReady?: () => void): void;
  hideTab(tab: TabState): void;
  expandPane(id: string): void;
  notify(): void;
}

// Saving the workspace, its scrollback, and its pads' text, and building it back from
// workspace.json or a saved layout (docs/design/workspace.md section 4.9).

/** Design 4.9: layout leaves already hold pane ids, which double as saved keys. */
export function snapshot(ctx: PersistenceContext): SavedWorkspace {
  return snapshotTabs(ctx.store.state, (id, collapsed): SavedPane | null => {
    const pane = ctx.paneViews.get(id);
    if (ctx.containerShells.has(id)) return null;
    if (pane instanceof TerminalPane) {
      return {
        key: id,
        kind: 'terminal',
        cwd: pane.cwd ?? '',
        collapsed,
        ...ctx.sessions.saved(id, pane.ptyId),
        ...(pane.profile !== undefined && { profile: pane.profile }),
        scrollbackId: pane.scrollbackId,
        ...(pane.pty && { pty: pane.pty }),
      };
    }
    if (pane instanceof ScratchPane) return { key: id, collapsed, kind: 'scratch', scratchId: pane.scratchId };
    if (pane instanceof FilesPane) return { key: id, collapsed, kind: 'files', ...pane.saved() };
    if (pane instanceof GitPane) return { key: id, collapsed, kind: 'git', ...pane.saved() };
    if (pane instanceof ShipPane) return { key: id, collapsed, kind: 'ship', ...pane.saved() };
    if (pane instanceof SearchPane) return { key: id, collapsed, kind: 'search', ...pane.saved() };
    if (pane instanceof ContainersPane) return { key: id, collapsed, kind: 'containers' };
    if (pane instanceof PortsPane) return { key: id, collapsed, kind: 'ports' };
    if (pane instanceof LocalBrowserPane) return { key: id, collapsed, kind: 'browser', ...pane.state() };
    return null;
  });
}

/**
 * Design 4.9: each saved terminal reattached to its pty when `livePtys` has it, else a new shell,
 * and each pad with its saved text, tab by tab in saved order. Expects an empty workspace and at
 * least one saved tab.
 */
export function restore(
  ctx: PersistenceContext,
  saved: SavedWorkspace,
  opts: { resumeSessions: boolean; scrollback: boolean; livePtys: readonly PtyRef[] },
): void {
  if (saved.tabs.length === 0) return;
  const built = saved.tabs.map((t) => ({
    saved: t,
    ...restoredTab(t, ctx.store.takeTabId(), t.name, (p) => ctx.takeIdFor(p.kind)),
  }));
  const active = built[Math.min(Math.max(saved.activeTab, 0), built.length - 1)];
  ctx.store.state = { tabs: built.map((b) => b.tab), activeId: active.tab.id };
  // Every expanded host must be attached and sized before its pane opens, since start() fits to it.
  for (const p of active.saved.panes) if (!p.collapsed) ctx.createHost(active.ids.get(p.key)!);
  ctx.render();
  for (const b of built) {
    buildTab(ctx, b.saved, b.ids, b === active, {
      resumeSessions: opts.resumeSessions,
      loadScratch: true,
      loadScrollback: opts.scrollback,
      livePtys: opts.livePtys,
    });
  }
  for (const [hid, host] of ctx.hosts) host.classList.toggle('focused', hid === ctx.store.focusedId);
  ctx.paneViews.get(ctx.store.focusedId)?.focus();
  ctx.notify();
}

/**
 * Design 4.6, 4.9, and 4.11: appends the saved tab as the active tab, fixed to `name`, without
 * resuming Claude sessions; its scratch pads open fresh.
 */
export function openLayout(ctx: PersistenceContext, saved: SavedTab, name: string): void {
  const prev = ctx.store.active;
  const { tab, ids } = restoredTab(saved, ctx.store.takeTabId(), name, (p) => ctx.takeIdFor(p.kind));
  ctx.store.state = addTab(ctx.store.state, tab);
  ctx.hideTab(prev);
  if (saved.panes.length === 0) {
    const id = ctx.takeId();
    ctx.mount(id, { kind: 'pane', paneId: id }, { kind: 'terminal' });
    return;
  }
  // Every expanded host must be attached and sized before its pane opens, since start() fits to it.
  for (const p of saved.panes) if (!p.collapsed) ctx.createHost(ids.get(p.key)!);
  ctx.render();
  buildTab(ctx, saved, ids, true, { resumeSessions: false, loadScratch: false, loadScrollback: false });
  // A layout of only collapsed panes would leave nothing to type into.
  if (!ctx.store.tree) {
    ctx.expandPane(tab.panes[0]);
    return;
  }
  ctx.paneViews.get(ctx.store.focusedId)?.focus();
  ctx.notify();
}

/** Builds a saved tab's panes; for a visible tab the caller has already attached the expanded hosts. */
function buildTab(
  ctx: PersistenceContext,
  saved: SavedTab,
  ids: Map<string, string>,
  visible: boolean,
  opts: { resumeSessions: boolean; loadScratch: boolean; loadScrollback: boolean; livePtys?: readonly PtyRef[] },
): void {
  for (const p of saved.panes) {
    const id = ids.get(p.key)!;
    let onReady: (() => void) | undefined;
    if (p.kind === 'terminal' && p.sessionId) {
      const { sessionId, permissionMode, agent, resumeModel } = p;
      ctx.sessions.restore(id, {
        sessionId,
        ...(permissionMode !== undefined && { permissionMode }),
        ...(agent !== undefined && { agent }),
        ...(resumeModel !== undefined && { resumeModel }),
      });
      if (opts.resumeSessions) {
        const command = resumeCommand(sessionId, permissionMode, agent, resumeModel);
        onReady = () => ctx.terminal(id)?.typeText(`${command}\r`);
      }
    }
    const open = (spec: PaneSpec): void => {
      if (visible && !p.collapsed) ctx.startPane(id, ctx.buildPane(id, ctx.hosts.get(id)!, spec, true, onReady));
      else ctx.openOffscreen(id, spec, onReady);
    };
    // One pane that cannot be rebuilt, from saved data its kind no longer accepts or a bug,
    // must not abort the panes and tabs after it.
    try {
      open(restoredSpec(p, opts, { scratch: scratchLoad, scrollback: scrollbackLoad }));
    } catch (e) {
      reportError(`could not restore a ${p.kind} pane`, e);
      showToast(`Could not restore a ${p.kind} pane; opened a terminal in its place.`);
      try {
        open(fallbackSpec(p, opts.livePtys));
      } catch (e2) {
        reportError('could not open a terminal in place of a pane', e2);
      }
    }
  }
}

/**
 * Design 4.9: saves each saved terminal's scrollback for the next launch and removes any other
 * saved scrollback. Off, it saves none, so stale files go too.
 */
export async function saveScrollback(ctx: PersistenceContext, enabled: boolean): Promise<void> {
  const entries: ScrollbackEntry[] = [];
  if (enabled) {
    for (const [id, pane] of ctx.paneViews) {
      if (pane instanceof TerminalPane && !ctx.containerShells.has(id)) {
        entries.push({ id: pane.scrollbackId, text: pane.serialize() });
      }
    }
  }
  await scrollbackSaveAll(entries);
}

/**
 * Design 4.9: saves the scrollback of each terminal that had output since the last pass, one at
 * a time after `idle` resolves, so a core that dies without closing still leaves recent output
 * for the next launch. The close-time save stays the one that removes stale files.
 */
export async function saveChangedScrollback(ctx: PersistenceContext, idle: () => Promise<void>): Promise<void> {
  for (const [id, pane] of [...ctx.paneViews]) {
    if (!(pane instanceof TerminalPane) || ctx.containerShells.has(id) || !pane.takeUnsavedOutput()) continue;
    await idle();
    // Empty once the pane closed while this pass waited.
    const text = pane.serialize();
    if (text) await scrollbackSave({ id: pane.scrollbackId, text });
  }
}

/** Saves every pad's and Files editor's pending text now, for the window closing. */
export async function flushPanes(ctx: PersistenceContext): Promise<void> {
  const panes = [...ctx.paneViews.values()].filter(
    (p): p is ScratchPane | FilesPane | SearchPane =>
      p instanceof ScratchPane || p instanceof FilesPane || p instanceof SearchPane,
  );
  await Promise.all(panes.map((p) => p.flush()));
}
