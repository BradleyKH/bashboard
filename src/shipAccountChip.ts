import type { ForgeRepo } from './forgeApi';

/**
 * The "as @name" button in the Ship pane's bar, shown when the host holds several accounts
 * (docs/design/ship.md section 4.20). It is styled as a warning when the repo has no account of its
 * own and so follows whichever account `gh` last switched to.
 */
export class ShipAccountChip {
  readonly el: HTMLButtonElement;

  /** `onClick` receives the chip, to anchor the account menu under it. */
  constructor(onClick: (anchor: HTMLElement) => void) {
    this.el = document.createElement('button');
    this.el.type = 'button';
    this.el.className = 'ship-chip';
    this.el.hidden = true;
    this.el.addEventListener('click', () => onClick(this.el));
  }

  update(repo: ForgeRepo | null): void {
    const show = repo !== null && repo.capabilities.accounts && repo.accounts.length > 1;
    this.el.hidden = !show;
    if (!show || repo === null) return;
    const following = repo.accountSource === 'cliActive';
    this.el.classList.toggle('warn', following);
    this.el.textContent = repo.account ? `as @${repo.account}` : 'Choose account';
    this.el.title = following
      ? `This repo has no account of its own, so it follows whichever account gh last switched to${
          repo.account ? ` (@${repo.account})` : ''
        }. Click to pick one for this repo.`
      : 'The account this repo uses. Click to pick another.';
  }
}
