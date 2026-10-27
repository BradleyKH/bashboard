import { type Layout, close, findPath } from './layout';
import { focusAfterRemoval } from './docking';
import { addPane, removePane, replacePane, tabOf, type TabState, type TabsState } from './tabs';

/**
 * The workspace's tabs (docs/design.md section 4.10) with the active tab's tree and focus
 * exposed directly, since every layout operation acts on the active tab. No DOM.
 */
export class TabStore {
  state: TabsState;
  private nextTabId = 1;

  constructor() {
    this.state = this.emptyState();
  }

  /** Back to one empty tab. */
  reset(): void {
    this.state = this.emptyState();
  }

  takeTabId(): string {
    return `t${this.nextTabId++}`;
  }

  emptyTab(): TabState {
    return { id: this.takeTabId(), name: null, tree: null, focusedId: '', collapsed: [], panes: [] };
  }

  get activeId(): string {
    return this.state.activeId;
  }

  get active(): TabState {
    return this.state.tabs.find((t) => t.id === this.state.activeId)!;
  }

  get tree(): Layout | null {
    return this.active.tree;
  }

  set tree(tree: Layout | null) {
    this.update(this.state.activeId, { tree });
  }

  get focusedId(): string {
    return this.active.focusedId;
  }

  set focusedId(focusedId: string) {
    this.update(this.state.activeId, { focusedId });
  }

  find(id: string): TabState | undefined {
    return this.state.tabs.find((t) => t.id === id);
  }

  tabOf(paneId: string): TabState | null {
    return tabOf(this.state, paneId);
  }

  update(id: string, patch: Partial<Omit<TabState, 'id'>>): void {
    this.state = {
      ...this.state,
      tabs: this.state.tabs.map((t) => (t.id === id ? { ...t, ...patch } : t)),
    };
  }

  /** Records a new pane in the active tab. */
  addToActive(paneId: string, collapsed: boolean): void {
    this.state = addPane(this.state, this.state.activeId, paneId, collapsed);
  }

  isCollapsed(paneId: string): boolean {
    return this.tabOf(paneId)?.collapsed.includes(paneId) ?? false;
  }

  setCollapsed(paneId: string, collapsed: boolean): void {
    const tab = this.tabOf(paneId);
    if (!tab) return;
    if (collapsed) this.state = addPane(this.state, tab.id, paneId, true);
    else this.update(tab.id, { collapsed: tab.collapsed.filter((c) => c !== paneId) });
  }

  /** Closes the pane's leaf in its tab's tree, moving that tab's focus as closing does; true if it had one. */
  removeFromTree(paneId: string): boolean {
    const tab = this.tabOf(paneId);
    if (!tab?.tree || !findPath(tab.tree, paneId)) return false;
    const target = focusAfterRemoval(tab.tree, paneId, tab.focusedId);
    const tree = close(tab.tree, paneId);
    this.update(tab.id, { tree, focusedId: tree ? target : '' });
    return true;
  }

  /**
   * Drops the pane from its tab, closing the tab when it empties. False when that was the last
   * tab, which leaves the state unchanged for the caller to close the window.
   */
  removePane(paneId: string): boolean {
    const next = removePane(this.state, paneId);
    if (!next) return false;
    this.state = next;
    return true;
  }

  /** Design 4.2: a pane docked from another tab leaves that tab's tree and lists for the active tab's. */
  moveToActive(paneId: string): void {
    const source = this.tabOf(paneId);
    if (!source || source.id === this.state.activeId) return;
    this.removeFromTree(paneId);
    // The active tab still holds panes, so this never empties the last tab.
    this.removePane(paneId);
    this.addToActive(paneId, false);
  }

  /** Swaps a pane for one of another kind in place, as `replacePane` in tabs.ts. */
  replacePane(oldId: string, newId: string): void {
    this.state = replacePane(this.state, oldId, newId);
  }

  private emptyState(): TabsState {
    const tab = this.emptyTab();
    return { tabs: [tab], activeId: tab.id };
  }
}
