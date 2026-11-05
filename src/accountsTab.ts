import type { ConfirmOptions } from './confirmDialog';
import { asForgeError, forgeAuthStatus, onForgeAuthChanged, type HostAuth } from './forgeApi';
import { hostCard } from './forgeAccountsModel';
import { ForgeHostCard } from './forgeHostCard';

export interface AccountsTabOptions {
  onRunTerminal(argv: string[]): void;
  onOpenUrl(url: string): void;
  confirm(o: ConfirmOptions): Promise<boolean>;
}

interface FocusRequest {
  host: string;
  openTokenForm: boolean;
}

/** The app dialog's Accounts tab: one card per code host, showing where its token comes from (docs/design.md section 4.20). */
export class AccountsTab {
  private root: HTMLElement | null = null;
  private list: HTMLElement | null = null;
  private error: HTMLElement | null = null;
  private cards = new Map<string, ForgeHostCard>();
  private loaded = false;
  private generation = 0;
  private pending: FocusRequest | null = null;
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
    root.append(intro, error, list);
    host.append(root);
    this.root = root;
    this.list = list;
    this.error = error;

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
    this.root?.remove();
    this.root = null;
    this.list = null;
    this.error = null;
    this.loaded = false;
    this.pending = null;
    // Drops any in-flight load's result.
    this.generation++;
  }

  /** Escape cancels an open token form instead of closing the dialog. */
  onKey(e: KeyboardEvent): boolean {
    if (e.key === 'Escape' && this.closeForms()) return true;
    return false;
  }

  /** Scrolls `host`'s card into view, opening the Bitbucket token form on request; waits for the cards if they are not drawn yet. */
  focusHost(host: string, opts?: { openTokenForm?: boolean }): void {
    this.pending = { host, openTokenForm: opts?.openTokenForm ?? false };
    if (this.loaded) this.applyPending();
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
    if (!card) return;
    this.pending = null;
    card.element.scrollIntoView({ block: 'nearest' });
    if (req.openTokenForm) card.openTokenForm();
  }

  private async load(): Promise<void> {
    if (!this.root) return;
    const generation = ++this.generation;
    let hosts: HostAuth[];
    try {
      hosts = await forgeAuthStatus();
    } catch (err) {
      if (generation !== this.generation || !this.error) return;
      this.error.textContent = `Could not read the sign-in state: ${asForgeError(err).message}`;
      this.error.hidden = false;
      return;
    }
    if (generation !== this.generation || !this.list || !this.error) return;
    this.error.hidden = true;
    this.render(hosts, this.list);
    this.loaded = true;
    this.applyPending();
  }

  private render(hosts: HostAuth[], list: HTMLElement): void {
    const seen = new Set<string>();
    hosts.forEach((h, i) => {
      seen.add(h.host);
      let card = this.cards.get(h.host);
      if (!card) {
        card = new ForgeHostCard(h.provider, {
          ...this.options,
          onChanged: () => void this.load(),
        });
        this.cards.set(h.host, card);
      }
      card.update(hostCard(h));
      // Reinserting a card that is already in place would drop focus from its token field.
      if (list.children[i] !== card.element) list.insertBefore(card.element, list.children[i] ?? null);
    });
    for (const [host, card] of this.cards) {
      if (seen.has(host)) continue;
      card.dispose();
      this.cards.delete(host);
    }
  }
}
