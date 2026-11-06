import type { ConfirmOptions } from './confirmDialog';
import { asForgeError, forgeAuthStatus, onForgeAuthChanged, type HostAuth, type KnownTargets } from './forgeApi';
import { azureOrgsFromRepoIds, guessProvider, hostCard, normalizeOrg, splitByDetection } from './forgeAccountsModel';
import { ForgeHostCard } from './forgeHostCard';
import { shipOverviewStore } from './shipOverviewStore';

/**
 * What the tab needs from the workspace: the core's `KnownTargets`, plus the repo ids
 * (`<host>/<path>`) of open Ship panes, which name the Azure DevOps organizations to test.
 * Pinned repos are read from the Overview store, so `repos` may leave them out.
 */
export interface KnownForAccounts extends KnownTargets {
  repos?: string[];
}

export interface AccountsTabOptions {
  onRunTerminal(argv: string[]): void;
  onOpenUrl(url: string): void;
  confirm(o: ConfirmOptions): Promise<boolean>;
  known(): KnownForAccounts;
}

interface FocusRequest {
  host: string;
  openTokenForm: boolean;
  org: string | undefined;
  /** Already reloaded once with the host added, so a still-missing card ends the request. */
  retried: boolean;
}

/** The app dialog's Accounts tab: one card per code host, showing where its token comes from (docs/design.md section 4.20). */
export class AccountsTab {
  private root: HTMLElement | null = null;
  private list: HTMLElement | null = null;
  private moreToggle: HTMLButtonElement | null = null;
  private moreList: HTMLElement | null = null;
  private error: HTMLElement | null = null;
  private cards = new Map<string, ForgeHostCard>();
  private detected = new Set<string>();
  private expanded = false;
  private loaded = false;
  private generation = 0;
  private pending: FocusRequest | null = null;
  /** Hosts a focus request named that the core had not reported; kept for this mount's later loads. */
  private extraHosts: KnownTargets['hosts'] = [];
  private unlisten: (() => void) | null = null;
  private readonly onWindowFocus = () => void this.load();

  constructor(private readonly options: AccountsTabOptions) {}

  mount(host: HTMLElement): void {
    const root = document.createElement('div');
    root.className = 'accounts-tab app-dialog-scroll';
    const intro = document.createElement('p');
    intro.textContent = 'Where each code host gets its token. Ship panes use these to read pull requests and pipelines.';
    const error = document.createElement('p');
    error.className = 'accounts-error';
    error.hidden = true;
    const list = document.createElement('div');
    list.className = 'accounts-list';
    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'accounts-more-toggle';
    toggle.hidden = true;
    toggle.setAttribute('aria-expanded', 'false');
    toggle.addEventListener('click', () => this.setExpanded(!this.expanded));
    const more = document.createElement('div');
    more.className = 'accounts-list accounts-more';
    more.hidden = true;
    root.append(intro, error, list, toggle, more);
    host.append(root);
    this.root = root;
    this.list = list;
    this.moreToggle = toggle;
    this.moreList = more;
    this.error = error;
    this.expanded = false;

    window.addEventListener('focus', this.onWindowFocus);
    // Tolerates a plain browser, where there is no event channel to join.
    onForgeAuthChanged(() => void this.load())
      .then((un) => {
        // Unmounted while the listen call was in flight.
        if (this.root) this.unlisten = un;
        else un();
      })
      .catch(() => {});
    void this.load();
  }

  show(): void {
    void this.load();
  }

  hide(): void {
    this.closeForms();
  }

  unmount(): void {
    window.removeEventListener('focus', this.onWindowFocus);
    this.unlisten?.();
    this.unlisten = null;
    for (const card of this.cards.values()) card.dispose();
    this.cards.clear();
    this.detected.clear();
    this.root?.remove();
    this.root = null;
    this.list = null;
    this.moreToggle = null;
    this.moreList = null;
    this.error = null;
    this.loaded = false;
    this.pending = null;
    this.extraHosts = [];
    // Drops any in-flight load's result.
    this.generation++;
  }

  /** Escape cancels an open token form instead of closing the dialog. */
  onKey(e: KeyboardEvent): boolean {
    if (e.key === 'Escape' && this.closeForms()) return true;
    return false;
  }

  /**
   * Scrolls `host`'s card into view, expanding More hosts when it is folded there, and opens the
   * token form on request with `org` prefilled. Waits for the cards if they are not drawn yet, and
   * asks the core about a host it has not reported, so the request always lands on a card.
   */
  focusHost(host: string, opts?: { openTokenForm?: boolean; org?: string }): void {
    this.pending = {
      host,
      openTokenForm: opts?.openTokenForm ?? false,
      org: opts?.org ? normalizeOrg(opts.org) : undefined,
      retried: false,
    };
    if (this.loaded) this.applyPending();
  }

  private setExpanded(on: boolean): void {
    this.expanded = on;
    if (this.moreList) this.moreList.hidden = !on;
    this.moreToggle?.setAttribute('aria-expanded', String(on));
  }

  private closeForms(): boolean {
    let closed = false;
    for (const card of this.cards.values()) {
      if (card.isTokenFormOpen()) {
        card.closeTokenForm();
        closed = true;
      }
    }
    return closed;
  }

  private applyPending(): void {
    const req = this.pending;
    if (!req) return;
    const card = this.cards.get(req.host);
    if (!card) {
      if (req.retried) {
        this.pending = null;
        return;
      }
      req.retried = true;
      this.extraHosts.push({ provider: guessProvider(req.host), host: req.host });
      void this.load();
      return;
    }
    this.pending = null;
    if (!this.detected.has(req.host)) this.setExpanded(true);
    card.element.scrollIntoView({ block: 'nearest' });
    if (req.openTokenForm) card.openTokenForm(req.org);
  }

  private knownTargets(): KnownTargets {
    const known = this.options.known();
    const hosts = [...known.hosts];
    for (const extra of this.extraHosts) {
      if (!hosts.some((h) => h.host === extra.host)) hosts.push(extra);
    }
    return { hosts, dirs: known.dirs };
  }

  private knownOrgs(): string[] {
    const pins = shipOverviewStore.rows().map((e) => e.pin.repo);
    return azureOrgsFromRepoIds([...pins, ...(this.options.known().repos ?? [])]);
  }

  private async load(): Promise<void> {
    if (!this.root) return;
    const generation = ++this.generation;
    let hosts: HostAuth[];
    try {
      hosts = await forgeAuthStatus(this.knownTargets());
    } catch (err) {
      if (generation !== this.generation || !this.error) return;
      this.error.textContent = `Could not read the sign-in state: ${asForgeError(err).message}`;
      this.error.hidden = false;
      return;
    }
    if (generation !== this.generation || !this.list || !this.moreList || !this.moreToggle || !this.error) return;
    this.error.hidden = true;
    const split = splitByDetection(hosts);
    this.detected = new Set(split.detected.map((h) => h.host));
    this.render(split.detected, this.list);
    this.render(split.more, this.moreList);
    this.moreToggle.textContent = split.moreLabel ?? '';
    this.moreToggle.hidden = split.moreLabel === null;
    this.disposeMissing(hosts);
    this.loaded = true;
    this.applyPending();
  }

  private render(hosts: HostAuth[], list: HTMLElement): void {
    hosts.forEach((h, i) => {
      let card = this.cards.get(h.host);
      if (!card) {
        card = new ForgeHostCard({
          ...this.options,
          onChanged: () => void this.load(),
          knownOrgs: () => this.knownOrgs(),
        });
        this.cards.set(h.host, card);
      }
      card.update(h, hostCard(h));
      // Reinserting a card that is already in place would drop focus from its token field.
      if (list.children[i] !== card.element) list.insertBefore(card.element, list.children[i] ?? null);
    });
  }

  private disposeMissing(hosts: HostAuth[]): void {
    const seen = new Set(hosts.map((h) => h.host));
    for (const [host, card] of this.cards) {
      if (seen.has(host)) continue;
      card.dispose();
      this.cards.delete(host);
    }
  }
}
