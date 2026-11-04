import { getVersion } from '@tauri-apps/api/app';
import { linkButton } from './dialogLink';

const REPO_URL = 'https://github.com/BradleyKH/bashboard';

export interface AboutTabCallbacks {
  onCheckForUpdates(): void;
}

/** The app dialog's About tab: the version, the update check, and links. */
export class AboutTab {
  private root: HTMLElement | null = null;

  constructor(private readonly callbacks: AboutTabCallbacks) {}

  mount(host: HTMLElement): void {
    const root = document.createElement('div');
    root.className = 'about-tab app-dialog-scroll';

    const name = document.createElement('h2');
    name.className = 'about-tab-name';
    name.textContent = 'Bashboard';
    const tagline = document.createElement('p');
    tagline.textContent = 'A terminal for Claude Code over a living backdrop.';
    const version = document.createElement('p');
    version.className = 'app-dialog-note';
    version.textContent = 'Version unknown';

    const actions = document.createElement('div');
    actions.className = 'about-tab-actions';
    const update = document.createElement('button');
    update.type = 'button';
    update.className = 'app-dialog-button';
    update.textContent = 'Check for updates';
    update.addEventListener('click', () => this.callbacks.onCheckForUpdates());
    actions.append(update);

    const links = document.createElement('p');
    links.className = 'about-tab-links';
    const notes = linkButton('Release notes', `${REPO_URL}/releases`);
    links.append(notes, linkButton('Documentation', `${REPO_URL}#documentation`), linkButton('Source on GitHub', REPO_URL));

    root.append(name, tagline, version, actions, links);
    host.append(root);
    this.root = root;

    // Fails outside Tauri (plain browser), where the version stays unknown.
    getVersion()
      .then((v) => {
        version.textContent = `Version ${v}`;
        notes.replaceWith(linkButton(`Release notes for ${v}`, `${REPO_URL}/releases/tag/v${v}`));
      })
      .catch(() => {});
  }

  unmount(): void {
    this.root?.remove();
    this.root = null;
  }
}
