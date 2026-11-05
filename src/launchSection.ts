import './launchSection.css';
import { setHintedTitle } from './keyHints';
import { launchOptions, type LaunchKind } from './launchModel';

export interface LaunchSectionCallbacks {
  onLaunch(kind: LaunchKind): void;
  /** The option under the pointer or keyboard focus, or null when none is; drives the preview. */
  onPreview(kind: LaunchKind | null): void;
}

/**
 * The dashboard's Launch section (docs/design.md section 4.6): one row of icon buttons that open a
 * pane of each kind at the focused pane's repo root. It does not collapse, since
 * its heading would then stand for nothing.
 */
export class LaunchSection {
  readonly el: HTMLElement;
  readonly head: HTMLElement;
  private readonly buttons: HTMLElement;
  private isGit: boolean | null = null;

  constructor(private readonly callbacks: LaunchSectionCallbacks) {
    this.el = document.createElement('section');
    this.el.className = 'dashboard-section launch-section';
    this.el.hidden = true;
    this.head = document.createElement('h2');
    this.head.textContent = 'Launch';
    this.buttons = document.createElement('div');
    this.buttons.className = 'launch-buttons';
    this.el.append(this.head, this.buttons);
  }

  /** `isGit` is null while the focused pane has no folder, which hides the section. */
  update(isGit: boolean | null): void {
    this.el.hidden = isGit === null;
    if (isGit === null || isGit === this.isGit) {
      this.isGit = isGit;
      return;
    }
    this.isGit = isGit;
    this.buttons.replaceChildren(
      ...launchOptions(isGit).map((o) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'launch-button';
        b.textContent = o.icon;
        b.setAttribute('aria-label', o.label);
        if (o.action) setHintedTitle(b, o.title, o.action);
        else b.title = o.title;
        b.addEventListener('click', () => {
          this.callbacks.onPreview(null);
          this.callbacks.onLaunch(o.kind);
        });
        b.addEventListener('pointerenter', () => this.callbacks.onPreview(o.kind));
        b.addEventListener('pointerleave', () => this.callbacks.onPreview(null));
        b.addEventListener('focus', () => this.callbacks.onPreview(o.kind));
        b.addEventListener('blur', () => this.callbacks.onPreview(null));
        return b;
      }),
    );
  }
}
