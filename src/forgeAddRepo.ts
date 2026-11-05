import { parseFavorites, samePath } from './favorites';
import { asForgeError, forgeRepo } from './forgeApi';
import { repoId } from './forgeOverviewModel';
import { forgeOverviewStore } from './forgeOverviewStore';
import { normalizeRepoInput, providerBadge, repoLabel } from './forgeOverviewText';
import { favoritesLoad, reposLoad } from './persistence';
import { parseRepos } from './repos';

/** How many folders resolve at once; each one runs git and may ask the host who is signed in. */
const RESOLVE_PARALLEL = 4;

const ADD_REPO_HELP =
  'Name the repo the way its address does, as owner/name: for github.com/octocat/hello-world, ' +
  'type octocat/hello-world. That means GitHub, or Bitbucket when every pinned repo is on Bitbucket. ' +
  'To name the host yourself, type bitbucket.org/keysys/kweb, or paste any link into the repo: ' +
  'its web page, or the https or ssh address you clone it with.';

interface Suggestion {
  /** The pin identity, `host/owner/name`. */
  id: string;
  root: string;
}

/** The Overview's Add repo box: a typed repo or link, plus the known folders that are on a supported host. */
export class ForgeAddRepo {
  readonly el: HTMLElement;
  private readonly input: HTMLInputElement;
  private readonly addButton: HTMLButtonElement;
  private readonly message: HTMLElement;
  private readonly list: HTMLElement;
  private suggestions: Suggestion[] = [];
  private loaded = false;
  private busy = false;
  private disposed = false;
  private readonly unsubscribe: () => void;

  constructor() {
    this.el = document.createElement('div');
    this.el.className = 'forge-add';

    const row = document.createElement('div');
    row.className = 'forge-add-row';
    this.input = document.createElement('input');
    this.input.type = 'text';
    this.input.className = 'forge-add-input';
    this.input.placeholder = 'Add a repo: owner/name or a link';
    this.input.setAttribute('aria-label', 'Repo to pin to Overview');
    this.input.spellcheck = false;
    this.addButton = document.createElement('button');
    this.addButton.type = 'button';
    this.addButton.className = 'forge-button';
    this.addButton.textContent = 'Pin to Overview';
    const help = document.createElement('button');
    help.type = 'button';
    help.className = 'forge-add-help';
    help.textContent = '?';
    help.title = ADD_REPO_HELP;
    help.setAttribute('aria-label', 'How to name a repo');
    // A tooltip is slow to appear, so a click puts the same text under the box.
    help.addEventListener('click', () => this.showMessage(ADD_REPO_HELP, false));
    row.append(this.input, help, this.addButton);

    this.message = document.createElement('div');
    this.message.className = 'forge-add-message';
    this.message.setAttribute('role', 'status');
    this.message.hidden = true;
    this.list = document.createElement('div');
    this.list.className = 'forge-add-list';
    this.el.append(row, this.message, this.list);

    this.input.addEventListener('input', () => {
      this.showMessage('', false);
      this.renderSuggestions();
    });
    this.input.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      void this.submit();
    });
    this.addButton.addEventListener('click', () => void this.submit());
    // A pin or unpin elsewhere changes which suggestions are still offered.
    this.unsubscribe = forgeOverviewStore.subscribe(() => this.renderSuggestions());
    this.renderSuggestions();
  }

  /** Resolves the known folders once; the first call does the work. */
  load(): void {
    if (this.loaded) return;
    this.loaded = true;
    void this.resolveFolders();
  }

  dispose(): void {
    this.disposed = true;
    this.unsubscribe();
  }

  private async resolveFolders(): Promise<void> {
    let roots: string[] = [];
    try {
      const [repos, favorites] = await Promise.all([reposLoad(), favoritesLoad()]);
      for (const path of [...parseRepos(repos).map((r) => r.root), ...parseFavorites(favorites).map((f) => f.path)]) {
        if (!roots.some((r) => samePath(r, path))) roots.push(path);
      }
    } catch {
      roots = [];
    }
    const queue = [...roots];
    const worker = async (): Promise<void> => {
      for (let root = queue.shift(); root !== undefined && !this.disposed; root = queue.shift()) {
        try {
          const id = repoId(await forgeRepo(root));
          // Two clones of one repo offer it once.
          if (!this.suggestions.some((s) => s.id === id)) {
            this.suggestions.push({ id, root });
            this.renderSuggestions();
          }
        } catch {
          // Not a repo on a supported host, or not signed in; it simply is not suggested.
        }
      }
    };
    await Promise.all(Array.from({ length: RESOLVE_PARALLEL }, worker));
  }

  private renderSuggestions(): void {
    const typed = this.input.value.trim().toLowerCase();
    const shown = this.suggestions.filter(
      (s) => !forgeOverviewStore.isPinned(s.id) && (typed === '' || s.id.toLowerCase().includes(typed)),
    );
    this.list.hidden = shown.length === 0;
    this.list.replaceChildren(
      ...shown.map((s) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'forge-add-item';
        button.title = s.root;
        const badge = document.createElement('span');
        badge.className = 'forge-ov-provider';
        badge.textContent = providerBadge(s.id)?.letters ?? '';
        const name = document.createElement('span');
        name.className = 'forge-add-item-name';
        name.textContent = repoLabel(s.id);
        const path = document.createElement('span');
        path.className = 'forge-ov-age';
        path.textContent = s.root;
        button.append(badge, name, path);
        button.addEventListener('click', () => void this.pin(s.id, s.root));
        return button;
      }),
    );
  }

  private showMessage(text: string, isError: boolean): void {
    this.message.textContent = text;
    this.message.hidden = text === '';
    this.message.classList.toggle('error', isError);
  }

  private setBusy(on: boolean): void {
    this.busy = on;
    this.addButton.disabled = on;
    this.input.disabled = on;
  }

  private async pin(id: string, root?: string): Promise<void> {
    this.showMessage('', false);
    try {
      await forgeOverviewStore.pin(id, root);
    } catch (e) {
      this.showMessage(e instanceof Error ? e.message : String(e), true);
    }
  }

  private async submit(): Promise<void> {
    const pinned = forgeOverviewStore.rows().map((e) => e.pin.repo);
    const text = normalizeRepoInput(this.input.value, pinned);
    if (text === null || this.busy) return;
    this.setBusy(true);
    this.showMessage('Looking up the repo...', false);
    try {
      // Pin the resolved identity, never the typed text, which can carry credentials or a page suffix.
      const id = repoId(await forgeRepo(`remote:${text}`));
      if (this.disposed) return;
      if (forgeOverviewStore.isPinned(id)) {
        this.showMessage(`${repoLabel(id)} is already on the Overview.`, false);
        return;
      }
      await forgeOverviewStore.pin(id);
      this.input.value = '';
      this.showMessage('', false);
    } catch (e) {
      if (!this.disposed) this.showMessage(asForgeError(e).message, true);
    } finally {
      if (!this.disposed) {
        this.setBusy(false);
        this.renderSuggestions();
      }
    }
  }
}
