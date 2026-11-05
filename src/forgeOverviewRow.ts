import { attachContextMenu } from './contextMenu';
import type { MenuEntry } from './contextMenuModel';
import { noticeFor, relativeTime, statusInfo, type ForgeTab } from './forgeModel';
import { targetKey } from './forgeOverviewModel';
import { providerBadge, pullSummary, repoLabel } from './forgeOverviewText';
import { forgeOverviewStore, type OverviewEntry } from './forgeOverviewStore';

export interface OverviewRowHandlers {
  /** Opens the pinned repo's own Forge view on `tab`; `target` is a clone's path or `remote:<repo>`. */
  onDrill: (target: string, tab: ForgeTab) => void;
  onRunTerminal: (argv: string[]) => void;
  onOpenTerminal: (root: string) => void;
  onOpenUrl: (url: string) => void;
  onCopy: (text: string) => void;
}

function setText(el: HTMLElement, text: string): void {
  if (el.textContent !== text) el.textContent = text;
}

/** One pinned repo in the Overview: deploy-branch health, open pull requests, and its last error. */
export class ForgeOverviewRow {
  readonly el: HTMLElement;
  private current: OverviewEntry;

  private readonly badge: HTMLElement;
  private readonly name: HTMLElement;
  private readonly pulls: HTMLButtonElement;
  private readonly health: HTMLElement;
  private readonly error: HTMLElement;
  // What the health and error areas last drew, so an update that changed nothing touches no DOM.
  private healthKey = '';
  private errorKey = '';

  constructor(
    entry: OverviewEntry,
    private readonly handlers: OverviewRowHandlers,
  ) {
    this.current = entry;
    this.el = document.createElement('div');
    this.el.className = 'forge-ov-row';
    this.el.tabIndex = 0;
    this.el.setAttribute('role', 'button');

    const head = document.createElement('div');
    head.className = 'forge-ov-head';
    this.badge = document.createElement('span');
    this.badge.className = 'forge-ov-provider';
    this.name = document.createElement('span');
    this.name.className = 'forge-ov-name';
    this.pulls = document.createElement('button');
    this.pulls.type = 'button';
    this.pulls.className = 'forge-ov-pulls';
    this.pulls.addEventListener('click', (e) => {
      e.stopPropagation();
      this.drill('pulls');
    });
    head.append(this.badge, this.name, this.pulls);

    this.health = document.createElement('div');
    this.health.className = 'forge-ov-health';
    this.error = document.createElement('div');
    this.error.className = 'forge-ov-error';
    this.el.append(head, this.health, this.error);

    this.el.addEventListener('click', () => this.drill('pipelines'));
    this.el.addEventListener('keydown', (e) => {
      if (e.target !== this.el || (e.key !== 'Enter' && e.key !== ' ')) return;
      e.preventDefault();
      this.drill('pipelines');
    });
    attachContextMenu(this.el, () => ({ entries: this.menu(), target: this.el }));

    this.update(entry, Date.now());
  }

  get repo(): string {
    return this.current.pin.repo;
  }

  /** `nowMs` is epoch milliseconds, for the branch ages. */
  update(entry: OverviewEntry, nowMs: number): void {
    this.current = entry;
    const { pin, row } = entry;

    const badge = providerBadge(pin.repo);
    setText(this.badge, badge?.letters ?? '');
    this.badge.hidden = badge === null;
    this.badge.title = badge?.name ?? '';
    setText(this.name, repoLabel(pin.repo));
    this.name.title = pin.repo;

    if (row) {
      const pulls = row.overview.pulls.items;
      this.pulls.hidden = false;
      setText(this.pulls, pullSummary(pulls, row.overview.repo.capabilities.prNoun));
      this.pulls.classList.toggle('needs-you', pulls.some((p) => p.state === 'open' && p.reviewRequested));
    } else {
      this.pulls.hidden = true;
    }

    this.renderHealth(entry, nowMs);
    this.renderError(entry);
  }

  private renderHealth(entry: OverviewEntry, nowMs: number): void {
    const parts = (entry.row?.health ?? []).map((h) => ({
      branch: h.branch,
      status: h.run ? statusInfo(h.run.status) : null,
      title: h.run?.title ?? '',
      age: h.run ? relativeTime(h.run.createdAt, nowMs) : '',
    }));
    // Before the first poll lands there is nothing to show but the wait; a failed first poll shows the error line instead.
    const waiting = !entry.row && !entry.error;
    const key = JSON.stringify([parts, waiting]);
    if (key === this.healthKey) return;
    this.healthKey = key;

    const nodes: HTMLElement[] = parts.map((p) => {
      const item = document.createElement('span');
      item.className = 'forge-ov-branch';
      item.title = p.status ? `${p.status.label}: ${p.title}` : 'No recent run';
      const icon = document.createElement('span');
      icon.className = `forge-status forge-status--${p.status?.modifier ?? 'other'}`;
      icon.setAttribute('aria-hidden', 'true');
      const branch = document.createElement('span');
      branch.className = 'forge-ov-branch-name';
      branch.textContent = p.branch;
      item.append(icon, branch);
      if (p.age) {
        const age = document.createElement('span');
        age.className = 'forge-ov-age';
        age.textContent = p.age;
        item.append(age);
      }
      return item;
    });
    if (waiting) {
      const note = document.createElement('span');
      note.className = 'forge-ov-age';
      note.textContent = 'Loading';
      nodes.push(note);
    }
    this.health.replaceChildren(...nodes);
    this.health.hidden = nodes.length === 0;
  }

  private renderError(entry: OverviewEntry): void {
    const { error, row } = entry;
    const notice = error ? noticeFor(error, row?.overview.repo ?? null) : null;
    const key = JSON.stringify([notice?.title ?? null, notice?.actions.map((a) => a.label) ?? []]);
    if (key === this.errorKey) return;
    this.errorKey = key;
    this.error.hidden = notice === null;
    if (!notice) {
      this.error.replaceChildren();
      return;
    }
    const text = document.createElement('span');
    text.className = 'forge-ov-error-text';
    text.textContent = notice.title;
    const nodes: HTMLElement[] = [text];
    for (const action of notice.actions) {
      if (action.kind !== 'runTerminal') continue;
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'forge-run-btn';
      button.textContent = action.label;
      button.addEventListener('click', (e) => {
        e.stopPropagation();
        this.handlers.onRunTerminal(action.argv);
      });
      nodes.push(button);
    }
    this.error.replaceChildren(...nodes);
  }

  private drill(tab: ForgeTab): void {
    this.handlers.onDrill(targetKey(this.current.pin), tab);
  }

  private menu(): MenuEntry[] {
    const { pin, row } = this.current;
    // Both need the resolved repo's link, which a row still loading or failed on its first poll lacks.
    const webUrl = row?.overview.repo.webUrl ?? null;
    const entries: MenuEntry[] = [
      { kind: 'item', label: 'Open Pipelines', run: () => this.drill('pipelines') },
      { kind: 'item', label: 'Open Pull requests', run: () => this.drill('pulls') },
      {
        kind: 'item',
        label: 'Open in browser',
        enabled: webUrl !== null,
        run: () => webUrl && this.handlers.onOpenUrl(webUrl),
      },
    ];
    if (pin.root) {
      const root = pin.root;
      entries.push({ kind: 'item', label: 'Open terminal here', run: () => this.handlers.onOpenTerminal(root) });
    }
    entries.push(
      { kind: 'item', label: 'Copy link', enabled: webUrl !== null, run: () => webUrl && this.handlers.onCopy(webUrl) },
      { kind: 'separator' },
      { kind: 'item', label: 'Unpin from Overview', run: () => void forgeOverviewStore.unpin(pin.repo) },
    );
    return entries;
  }
}
