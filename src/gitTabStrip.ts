import type { GitTab } from './gitBranchModel';

const TABS: ReadonlyArray<{ tab: GitTab; label: string }> = [
  { tab: 'changes', label: 'Changes' },
  { tab: 'branches', label: 'Branches' },
];

/** The Git pane's Changes and Branches tabs (docs/design/git.md section 4.13). */
export class GitTabStrip {
  readonly el: HTMLElement;
  private readonly buttons = new Map<GitTab, HTMLButtonElement>();

  constructor(tab: GitTab, onPick: (tab: GitTab) => void) {
    this.el = document.createElement('div');
    this.el.className = 'git-tabs';
    this.el.setAttribute('role', 'tablist');
    for (const t of TABS) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'git-tab';
      btn.setAttribute('role', 'tab');
      btn.textContent = t.label;
      btn.addEventListener('click', () => onPick(t.tab));
      this.buttons.set(t.tab, btn);
      this.el.append(btn);
    }
    this.set(tab);
  }

  set(tab: GitTab): void {
    for (const [t, btn] of this.buttons) {
      btn.classList.toggle('active', t === tab);
      btn.setAttribute('aria-selected', String(t === tab));
    }
  }
}
