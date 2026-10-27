// Pane zoom state (docs/design.md section 4.2 "Zoom"). Pure data, no DOM.
import { type Layout, leaves } from './layout';

/** True when the tab has two or more expanded panes and `focusedId` is one of them. */
export function canZoom(tree: Layout | null, focusedId: string): boolean {
  return tree !== null && tree.kind === 'split' && leaves(tree).includes(focusedId);
}

/** Per-tab zoom. An entry remembers the tree and the focused pane at zoom time. */
export class PaneZoom {
  private readonly entries = new Map<string, { paneId: string; tree: Layout }>();

  /** Zooms the focused pane when the tab is not zoomed and can zoom, else unzooms.
   *  Returns true when the state changed. */
  toggle(tabId: string, tree: Layout | null, focusedId: string): boolean {
    if (this.entries.delete(tabId)) return true;
    if (!tree || !canZoom(tree, focusedId)) return false;
    this.entries.set(tabId, { paneId: focusedId, tree });
    return true;
  }

  /** The zoomed pane id, or null. Identity comparison is deliberate: every tree edit in
   *  TabStore and layout.ts produces a new object, so "the tree changed" is "not the same
   *  reference". A changed tree or a focus move drops the entry. */
  zoomed(tabId: string, tree: Layout | null, focusedId: string): string | null {
    const entry = this.entries.get(tabId);
    if (!entry) return null;
    if (tree !== entry.tree || focusedId !== entry.paneId) {
      this.entries.delete(tabId);
      return null;
    }
    return entry.paneId;
  }

  /** Ends the tab's zoom; true when it was zoomed. */
  end(tabId: string): boolean {
    return this.entries.delete(tabId);
  }

  forget(tabId: string): void {
    this.entries.delete(tabId);
  }
}
