import { FOLDER_ICON } from './folderButton';
import { breadcrumb, canBack, canForward, type History } from './filesModel';

export interface FilesBreadcrumbOptions {
  onBack: () => void;
  onForward: () => void;
  onNavigate: (folder: string) => void;
  onOpenInExplorer: () => void;
  onOpenTerminalHere: () => void;
  /** Pins the folder, or unpins it when it is already pinned. */
  onTogglePin: () => void;
}

export interface FilesBreadcrumbState {
  root: string;
  folder: string;
  history: History;
  pinned: boolean;
}

/** Back and forward buttons, the path from the repo root, Open in File Explorer, Open terminal here, and the pin button. */
export class FilesBreadcrumb {
  readonly el: HTMLElement;
  private readonly backBtn: HTMLButtonElement;
  private readonly forwardBtn: HTMLButtonElement;
  private readonly trail: HTMLElement;
  private readonly pinBtn: HTMLButtonElement;

  constructor(private readonly opts: FilesBreadcrumbOptions) {
    this.el = document.createElement('div');
    this.el.className = 'files-crumb';
    this.backBtn = this.button('‹', 'Back', opts.onBack);
    this.forwardBtn = this.button('›', 'Forward', opts.onForward);
    this.trail = document.createElement('div');
    this.trail.className = 'files-crumb-trail';
    const explorer = this.button(FOLDER_ICON, 'Open in File Explorer', opts.onOpenInExplorer);
    explorer.classList.add('files-crumb-folder');
    const term = this.button('>_', 'Open terminal here', opts.onOpenTerminalHere);
    this.pinBtn = this.button('☆', 'Pin this folder', opts.onTogglePin);
    this.el.append(this.backBtn, this.forwardBtn, this.trail, explorer, term, this.pinBtn);
  }

  update(state: FilesBreadcrumbState): void {
    this.backBtn.disabled = !canBack(state.history);
    this.forwardBtn.disabled = !canForward(state.history);
    this.pinBtn.textContent = state.pinned ? '★' : '☆';
    this.pinBtn.title = state.pinned ? 'Unpin this folder' : 'Pin this folder';
    this.pinBtn.classList.toggle('on', state.pinned);

    const crumbs = breadcrumb(state.root, state.folder);
    this.trail.replaceChildren();
    crumbs.forEach((c, i) => {
      if (i > 0) {
        const sep = document.createElement('span');
        sep.className = 'files-crumb-sep';
        sep.textContent = '/';
        this.trail.append(sep);
      }
      const seg = document.createElement('button');
      seg.type = 'button';
      seg.className = 'files-crumb-seg';
      seg.textContent = c.name;
      seg.title = c.path;
      if (i === crumbs.length - 1) seg.disabled = true;
      else seg.addEventListener('click', () => this.opts.onNavigate(c.path));
      this.trail.append(seg);
    });
    this.trail.scrollLeft = this.trail.scrollWidth;
  }

  private button(label: string, title: string, onClick: () => void): HTMLButtonElement {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'files-crumb-btn';
    b.textContent = label;
    b.title = title;
    b.addEventListener('click', onClick);
    return b;
  }
}
