import type { RemoteButton, RemoteButtons } from './gitModel';

export interface GitBranchRowOptions {
  onFetch: () => void;
  onPull: () => void;
  onPush: () => void;
  /** The branch name was clicked; the pane opens the switcher under it. */
  onBranchClick: (anchor: HTMLElement) => void;
}

/** A button label while its operation runs ends in an ellipsis. */
function isRunning(label: string): boolean {
  return label.endsWith('...');
}

/** The branch name, last fetch label, and Fetch, Pull, Push buttons (docs/design.md section 4.13). */
export class GitBranchRow {
  readonly el: HTMLElement;
  private readonly branch: HTMLElement;
  private readonly fetched: HTMLElement;
  private readonly fetchBtn: HTMLButtonElement;
  private readonly pullBtn: HTMLButtonElement;
  private readonly pushBtn: HTMLButtonElement;

  constructor(opts: GitBranchRowOptions) {
    this.el = document.createElement('div');
    this.el.className = 'git-branch';
    const branch = document.createElement('button');
    branch.type = 'button';
    branch.className = 'git-branch-name';
    branch.addEventListener('click', () => opts.onBranchClick(branch));
    this.branch = branch;
    this.fetched = document.createElement('span');
    this.fetched.className = 'git-fetched';
    this.fetched.hidden = true;
    this.fetchBtn = this.button('Fetch', opts.onFetch);
    this.pullBtn = this.button('Pull', opts.onPull);
    this.pushBtn = this.button('Push', opts.onPush);
    const remote = document.createElement('span');
    remote.className = 'git-remote';
    remote.append(this.fetched, this.fetchBtn, this.pullBtn, this.pushBtn);
    this.el.append(this.branch, remote);
  }

  setBranch(text: string): void {
    this.branch.textContent = text;
    this.branch.title = `${text}\nClick to switch or create a branch`;
  }

  setButtons(buttons: RemoteButtons): void {
    this.apply(this.fetchBtn, buttons.fetch);
    this.apply(this.pullBtn, buttons.pull);
    this.apply(this.pushBtn, buttons.push);
    const busy = [buttons.fetch, buttons.pull, buttons.push].some((b) => isRunning(b.label));
    this.el.classList.toggle('busy', busy);
  }

  setLastFetch(label: { text: string; title: string }): void {
    this.fetched.textContent = label.text;
    this.fetched.title = label.title || label.text;
    this.fetched.hidden = label.text === '';
  }

  private button(label: string, onClick: () => void): HTMLButtonElement {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'git-section-btn git-remote-btn';
    b.textContent = label;
    b.disabled = true;
    b.addEventListener('click', onClick);
    return b;
  }

  private apply(el: HTMLButtonElement, button: RemoteButton): void {
    el.textContent = button.label;
    el.disabled = !button.enabled;
    el.title = button.title;
  }
}
