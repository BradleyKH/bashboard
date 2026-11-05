import type { ForgeRepo } from './forgeApi';
import { repoId } from './forgeOverviewModel';
import { forgeOverviewStore } from './forgeOverviewStore';
import { showToast } from './toast';

/** The drilled Forge view's "Pin to Overview" toggle (docs/design.md section 4.20). */
export class ForgePinButton {
  readonly el: HTMLButtonElement;
  private repo: ForgeRepo | null = null;
  /** The clone the pin records, so the Overview polls through it; null for a remote-only target. */
  private root: string | null = null;
  private readonly unsubscribe: () => void;

  constructor() {
    this.el = document.createElement('button');
    this.el.type = 'button';
    this.el.className = 'forge-chip forge-pin';
    this.el.hidden = true;
    this.el.addEventListener('click', () => void this.toggle());
    this.unsubscribe = forgeOverviewStore.subscribe(() => this.render());
  }

  update(repo: ForgeRepo | null, root: string | null): void {
    this.repo = repo;
    this.root = root;
    this.render();
  }

  dispose(): void {
    this.unsubscribe();
  }

  private render(): void {
    const repo = this.repo;
    this.el.hidden = repo === null;
    if (!repo) return;
    const pinned = forgeOverviewStore.isPinned(repoId(repo));
    const text = pinned ? 'Unpin from Overview' : 'Pin to Overview';
    if (this.el.textContent !== text) this.el.textContent = text;
    this.el.classList.toggle('pinned', pinned);
    this.el.setAttribute('aria-pressed', String(pinned));
  }

  private async toggle(): Promise<void> {
    const repo = this.repo;
    if (!repo) return;
    const id = repoId(repo);
    try {
      if (forgeOverviewStore.isPinned(id)) await forgeOverviewStore.unpin(id);
      else await forgeOverviewStore.pin(id, this.root ?? undefined);
    } catch (e) {
      showToast(`Could not save the setting: ${String(e)}`);
    }
  }
}
