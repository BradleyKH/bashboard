import './launchPreview.css';
import type { Rect } from './layout';
import type { LaunchTarget } from './workspace';

function box(className: string): HTMLElement {
  const el = document.createElement('div');
  el.className = className;
  return el;
}

function place(el: HTMLElement, r: Rect): void {
  el.style.left = `${r.x}px`;
  el.style.top = `${r.y}px`;
  el.style.width = `${r.width}px`;
  el.style.height = `${r.height}px`;
}

/**
 * Shows where a Launch option would put its pane (docs/design/dashboard.md section 4.6) while the
 * option is hovered or highlighted: the new pane's share of the focused pane, the existing pane it
 * would bring forward, or a note that it opens collapsed. Never takes pointer events.
 */
export class LaunchPreview {
  private readonly layer = box('launch-preview');
  private readonly outline = box('launch-preview-outline');
  private readonly added = box('launch-preview-added');
  private readonly note = box('launch-preview-note');

  constructor() {
    this.layer.hidden = true;
    this.added.append(this.note);
    this.layer.append(this.outline, this.added);
    document.body.append(this.layer);
  }

  show(target: LaunchTarget | null, label: string): void {
    if (!target) {
      this.hide();
      return;
    }
    this.layer.hidden = false;
    this.layer.dataset.kind = target.kind;
    switch (target.kind) {
      case 'split':
        place(this.outline, target.pane);
        place(this.added, target.added);
        this.note.textContent = label;
        break;
      case 'fill':
        place(this.outline, target.area);
        place(this.added, target.area);
        this.note.textContent = label;
        break;
      case 'reuse':
        place(this.outline, target.pane);
        place(this.added, target.pane);
        this.note.textContent = `${label} (already open)`;
        break;
      case 'collapsed':
        place(this.outline, target.pane);
        place(this.added, target.pane);
        this.note.textContent = `${label} opens collapsed: no room`;
        break;
    }
  }

  hide(): void {
    this.layer.hidden = true;
  }
}
