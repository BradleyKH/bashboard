import type { MenuEntry } from './contextMenuModel';
import type { PullRequest } from './forgeApi';
import { groupPulls, type PullGroupKey } from './shipModel';
import { ShipPullRow } from './shipPullRow';

export interface ShipPullListOptions {
  onOpen: (pull: PullRequest) => void;
  menuItems: (pull: PullRequest) => MenuEntry[];
}

/**
 * The Pull requests list, grouped under small headers (docs/design.md section 4.20). Like the run
 * list, `update` reuses elements, so it is cheap to call on a tick.
 */
export class ShipPullList {
  readonly el: HTMLElement;
  private readonly rows = new Map<string, ShipPullRow>();
  private readonly headers = new Map<PullGroupKey, HTMLElement>();
  private readonly note: HTMLElement;
  private readonly limitNote: HTMLElement;

  constructor(private readonly opts: ShipPullListOptions) {
    this.el = document.createElement('div');
    this.el.className = 'ship-pulls';
    this.note = document.createElement('div');
    this.note.className = 'ship-note';
    this.limitNote = document.createElement('div');
    this.limitNote.className = 'ship-note';
  }

  /**
   * `emptyText` is shown when `pulls` is empty ("Loading…", "No open pull requests."); `limitText`,
   * when set, is a note after the groups saying the list is partial.
   */
  update(pulls: readonly PullRequest[], nowMs: number, emptyText: string, limitText: string | null): void {
    const seen = new Set<string>();
    const children: HTMLElement[] = [];
    for (const group of groupPulls(pulls)) {
      let header = this.headers.get(group.key);
      if (!header) {
        header = document.createElement('div');
        header.className = 'ship-group';
        this.headers.set(group.key, header);
      }
      const text = `${group.title} (${group.pulls.length})`;
      if (header.textContent !== text) header.textContent = text;
      children.push(header);
      for (const pull of group.pulls) {
        seen.add(pull.id);
        let row = this.rows.get(pull.id);
        if (row) row.update(pull, nowMs);
        else {
          row = new ShipPullRow(pull, { onOpen: this.opts.onOpen, menuItems: this.opts.menuItems });
          this.rows.set(pull.id, row);
        }
        children.push(row.el);
      }
    }
    for (const id of [...this.rows.keys()]) if (!seen.has(id)) this.rows.delete(id);

    if (limitText !== null && children.length > 0) {
      if (this.limitNote.textContent !== limitText) this.limitNote.textContent = limitText;
      children.push(this.limitNote);
    }
    if (children.length === 0) {
      if (this.note.textContent !== emptyText) this.note.textContent = emptyText;
      children.push(this.note);
    }
    const current = Array.from(this.el.children);
    if (current.length !== children.length || current.some((c, i) => c !== children[i])) {
      this.el.replaceChildren(...children);
    }
  }
}
