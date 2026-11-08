import { samePath } from './favorites';
import { FilesPane } from './filesPane';
import { pathInsertText, pathProfileFor } from './filesRouting';
import { recentTerminal } from './focusHistory';
import { TerminalPane } from './pane';
import { PathDragLayer, sameDropTarget, type PathDrag, type PathDropTarget } from './pathDragLayer';
import type { PaneView } from './paneView';
import { repoRoot } from './repoFiles';
import { ScratchPane } from './scratchPane';
import { showToast } from './toast';
import type { TabStore } from './tabStore';
import type { TabState } from './tabs';

/** What `PathDrop` reads of the workspace and asks it to do. */
export interface PathDropContext {
  readonly store: TabStore;
  readonly paneViews: ReadonlyMap<string, PaneView>;
  readonly hosts: ReadonlyMap<string, HTMLElement>;
  /** Pane ids, most recently focused first. */
  focusOrder(): readonly string[];
  terminal(id: string): TerminalPane | undefined;
  scratch(id: string): ScratchPane | undefined;
  /** Whether an agent session is bound to the pty. */
  isBound(ptyId: number | null): boolean;
  defaultProfile(): string;
  focusPane(id: string): void;
  expandPane(id: string): void;
  onDragHover(pos: { x: number; y: number } | null): void;
}

/**
 * Paths and text going into panes: the in-app path drag (docs/design/files.md section 4.12) with
 * its drop highlights, Insert path and Insert name from Files, Git, and Search panes, and a
 * scratch pad's Send (docs/design/files.md section 4.15), each into a tab's most recently
 * focused terminal.
 */
export class PathDrop {
  private readonly layer: PathDragLayer;
  /** The pane host showing the path drop highlight. */
  private highlightId: string | null = null;
  private dropHighlight: PathDropTarget | null = null;

  constructor(private readonly ctx: PathDropContext) {
    this.layer = new PathDragLayer({
      targetAt: (x, y, drag) => this.dropTargetAt(x, y, drag),
      highlight: (target) => this.setDropHighlight(target),
      onHover: (pos) => ctx.onDragHover(pos),
      onDrop: (target, drag) => {
        if (target.kind === 'insert') void this.insertPaths(target.paneId, drag.paths);
        else void this.moveDropped(drag, target.folder);
      },
      onCancel: () => ctx.paneViews.get(ctx.store.focusedId)?.focus(),
    });
  }

  /** Starts an in-app path drag (v0.2.0 design section 6) from a row's pointerdown. */
  startPathDrag(paths: string[], e: PointerEvent, move?: PathDrag['move']): void {
    if (paths.length === 0) return;
    this.layer.begin(e, { paths, move });
  }

  /** The expanded terminal or scratch pad in the active tab under the point, or null. */
  pathTargetAt(x: number, y: number): string | null {
    const at = this.paneAtPoint(x, y);
    if (!at) return null;
    const view = this.ctx.paneViews.get(at.id);
    return view instanceof TerminalPane || view instanceof ScratchPane ? at.id : null;
  }

  setPathHighlight(id: string | null): void {
    if (id === this.highlightId) return;
    if (this.highlightId) this.ctx.hosts.get(this.highlightId)?.classList.remove('path-drop-target');
    this.highlightId = id;
    if (id) this.ctx.hosts.get(id)?.classList.add('path-drop-target');
  }

  /**
   * Inserts paths into a terminal (bracketed paste, no Enter) or at a scratch pad's caret, then
   * shows the target. `baseRoot` undefined makes paths relative to the target terminal's repo, as
   * a drop does; Insert path passes its Files pane's root.
   */
  async insertPaths(targetId: string, paths: string[], baseRoot?: string | null): Promise<void> {
    const { ctx } = this;
    if (ctx.terminal(targetId)) {
      const text = await this.pathTextFor(targetId, paths, baseRoot);
      const term = ctx.terminal(targetId);
      if (!term) return;
      term.pasteText(text);
      if (ctx.store.isCollapsed(targetId)) ctx.expandPane(targetId);
      else ctx.focusPane(targetId);
      return;
    }
    if (!ctx.scratch(targetId)) return;
    const tab = ctx.store.tabOf(targetId);
    const termId = tab ? this.recentTerminalIn(tab) : null;
    const text = await this.pathTextFor(termId ?? null, paths, baseRoot);
    const pad = ctx.scratch(targetId);
    if (!pad) return;
    pad.insertAtCaret(text);
    ctx.focusPane(targetId);
  }

  /** Insert path from a Files, Git, or Search pane: into the tab's most recently focused terminal. */
  insertPathIntoTab(paneId: string, paths: string[], baseRoot: string): void {
    const tab = this.ctx.store.tabOf(paneId);
    const targetId = tab ? this.recentTerminalIn(tab) : null;
    if (!targetId) showToast('No terminal in this tab to insert the path into');
    else void this.insertPaths(targetId, paths, baseRoot);
  }

  /** Insert name from a Git pane's branch row: as typed, into the tab's most recently focused terminal. */
  insertTextIntoTab(paneId: string, text: string): void {
    const { ctx } = this;
    const tab = ctx.store.tabOf(paneId);
    const targetId = tab ? this.recentTerminalIn(tab) : null;
    const term = targetId ? ctx.terminal(targetId) : undefined;
    if (!targetId || !term) {
      showToast('No terminal in this tab to insert the name into');
      return;
    }
    term.pasteText(text);
    if (ctx.store.isCollapsed(targetId)) ctx.expandPane(targetId);
    else ctx.focusPane(targetId);
  }

  /**
   * Design 4.15 Send: pastes into the tab's most recently focused terminal, then focuses it, or
   * expands it when it is collapsed.
   */
  send(padId: string, text: string): void {
    const tab = this.ctx.store.tabOf(padId);
    if (tab) this.pasteIntoTab(tab, text);
  }

  /** Bracketed paste into the tab's most recently focused terminal, then shows it; false with none. */
  private pasteIntoTab(tab: TabState, text: string): boolean {
    const { ctx } = this;
    const targetId = this.recentTerminalIn(tab);
    const target = targetId ? ctx.terminal(targetId) : undefined;
    if (!targetId || !target) return false;
    target.pasteText(text);
    if (ctx.store.isCollapsed(targetId)) ctx.expandPane(targetId);
    else ctx.focusPane(targetId);
    return true;
  }

  private recentTerminalIn(tab: TabState): string | null {
    return recentTerminal(this.ctx.focusOrder(), tab.panes, (id) => this.ctx.terminal(id) !== undefined);
  }

  /**
   * The topmost element under the point and the expanded pane in the active tab holding it.
   * Only the topmost element counts, so the dashboard, a dialog, or the tab strip over a pane
   * blocks it.
   */
  private paneAtPoint(x: number, y: number): { id: string; top: Element } | null {
    const top = document.elementsFromPoint(x, y).find((el) => !el.closest('.path-drag-layer'));
    const host = top?.closest('.pane');
    if (!top || !host) return null;
    let id: string | null = null;
    for (const [hid, h] of this.ctx.hosts) {
      if (h === host) {
        id = hid;
        break;
      }
    }
    if (!id) return null;
    const tab = this.ctx.store.active;
    return tab.panes.includes(id) && !tab.collapsed.includes(id) ? { id, top } : null;
  }

  /**
   * Where an in-app path drag would drop: a folder in a Files pane for files dragged out of one
   * (other than the folder they are in), else a terminal or scratch pad.
   */
  private dropTargetAt(x: number, y: number, drag: PathDrag): PathDropTarget | null {
    if (drag.move) {
      const at = this.paneAtPoint(x, y);
      const view = at ? this.ctx.paneViews.get(at.id) : undefined;
      if (at && view instanceof FilesPane) {
        const t = view.moveTargetAt(at.top);
        if (!t || samePath(t.folder, drag.move.folder)) return null;
        return { kind: 'move', folder: t.folder, el: t.el };
      }
    }
    const id = this.pathTargetAt(x, y);
    return id ? { kind: 'insert', paneId: id } : null;
  }

  private setDropHighlight(target: PathDropTarget | null): void {
    if (sameDropTarget(this.dropHighlight, target)) return;
    if (this.dropHighlight?.kind === 'move') this.dropHighlight.el.classList.remove('path-move-target');
    this.dropHighlight = target;
    this.setPathHighlight(target?.kind === 'insert' ? target.paneId : null);
    if (target?.kind === 'move') target.el.classList.add('path-move-target');
  }

  /** Files dropped on a folder move through the Files pane they came from. */
  private async moveDropped(drag: PathDrag, folder: string): Promise<void> {
    if (!drag.move) return;
    const source = this.ctx.paneViews.get(drag.move.paneId);
    if (!(source instanceof FilesPane)) return;
    await source.movePaths(drag.paths, folder);
    if (this.ctx.store.focusedId === drag.move.paneId) source.focus();
  }

  /** Formats paths for a terminal's profile and repo; with no terminal, absolute for the default profile. */
  private async pathTextFor(terminalId: string | null, paths: string[], baseRoot?: string | null): Promise<string> {
    const term = terminalId ? this.ctx.terminal(terminalId) : undefined;
    const fallback = this.ctx.defaultProfile();
    let root: string | null = baseRoot ?? null;
    if (baseRoot === undefined && term?.folder) {
      try {
        root = (await repoRoot(term.folder)).root;
      } catch {
        root = null;
      }
    }
    const profile = term
      ? pathProfileFor(term.profile, fallback, this.ctx.isBound(term.ptyId))
      : pathProfileFor(undefined, fallback, false);
    return pathInsertText(paths, root, profile);
  }
}
