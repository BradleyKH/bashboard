import type { ShipTab } from './shipModel';

const DEFAULT_PR_NOUN = 'pull request';

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** "Pull requests" or "Merge requests", from the host's noun. */
export function pullsTabLabel(prNoun: string): string {
  return `${capitalize(prNoun)}s`;
}

/**
 * The Ship pane's Pipelines and Pull requests tabs, after an "Overview" crumb back to the
 * pinned repos (docs/design.md section 4.20).
 */
export class ShipTabStrip {
  readonly el: HTMLElement;
  private readonly buttons = new Map<ShipTab, HTMLButtonElement>();

  constructor(tab: ShipTab, onPick: (tab: ShipTab) => void, onBack: () => void) {
    this.el = document.createElement('div');
    this.el.className = 'ship-tabs';
    this.el.setAttribute('role', 'tablist');
    const crumb = document.createElement('button');
    crumb.type = 'button';
    crumb.className = 'ship-crumb';
    crumb.textContent = 'Overview';
    crumb.title = 'Back to the Overview';
    crumb.addEventListener('click', onBack);
    this.el.append(crumb);
    const labels: ReadonlyArray<{ tab: ShipTab; label: string }> = [
      { tab: 'pipelines', label: 'Pipelines' },
      { tab: 'pulls', label: pullsTabLabel(DEFAULT_PR_NOUN) },
    ];
    for (const t of labels) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'ship-tab';
      btn.setAttribute('role', 'tab');
      btn.textContent = t.label;
      btn.addEventListener('click', () => onPick(t.tab));
      this.buttons.set(t.tab, btn);
      this.el.append(btn);
    }
    this.set(tab);
  }

  set(tab: ShipTab): void {
    for (const [t, btn] of this.buttons) {
      btn.classList.toggle('active', t === tab);
      btn.setAttribute('aria-selected', String(t === tab));
    }
  }

  /** Words the second tab with the host's noun ("pull request" or "merge request"). */
  setPrNoun(prNoun: string): void {
    const label = pullsTabLabel(prNoun);
    const btn = this.buttons.get('pulls');
    if (btn && btn.textContent !== label) btn.textContent = label;
  }
}
