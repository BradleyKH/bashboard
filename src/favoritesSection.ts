import type { Favorite } from './favorites';
import { renderFavoriteRow } from './favoriteRow';
import type { OpenInHandler } from './openMenu';
import { renderRecentRow } from './recentRow';

export interface FavoritesCallbacks {
  /** Click, or Ctrl+click for a collapsed terminal. */
  onOpen(path: string, opts: { collapsed: boolean }): void;
  /** The "+" button. */
  onAdd(): void;
  onRename(index: number, label: string): void;
  onRemove(index: number): void;
  onReorder(from: number, to: number): void;
  /** Star on a recent folder. */
  onPromote(path: string): void;
  /** Row body dragged past the threshold, to dock it. */
  onDragStart(path: string, e: PointerEvent): void;
  /** Open menu on a favorite or recent folder; the row shows no menu button without it. */
  onOpenIn?: OpenInHandler;
}

/** The dashboard's Favorites section: favorites, then recent folders (docs/design.md section 4.6). */
export class FavoritesSection {
  readonly el: HTMLElement;
  readonly head: HTMLElement;
  private readonly addButton: HTMLButtonElement;
  private readonly list: HTMLElement;

  constructor(private readonly callbacks: FavoritesCallbacks) {
    this.el = document.createElement('section');
    this.el.className = 'dashboard-section favorites-section';

    const head = document.createElement('div');
    this.head = head;
    head.className = 'dashboard-section-head';
    const h = document.createElement('h2');
    h.textContent = 'Favorites';
    this.addButton = document.createElement('button');
    this.addButton.type = 'button';
    this.addButton.className = 'favorite-add';
    this.addButton.textContent = '+';
    this.addButton.title = 'Add the focused terminal’s folder to favorites';
    this.addButton.addEventListener('click', () => this.callbacks.onAdd());
    head.append(h, this.addButton);

    this.list = document.createElement('div');
    this.list.className = 'dashboard-list';
    this.el.append(head, this.list);
  }

  update(favorites: Favorite[], recents: string[], canAdd: boolean): void {
    this.addButton.disabled = !canAdd;

    const children: HTMLElement[] = [];
    if (favorites.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'dashboard-empty';
      empty.textContent = 'No favorites yet';
      children.push(empty);
    } else {
      children.push(...favorites.map((f, i) => renderFavoriteRow(f, i, this.callbacks)));
    }
    if (recents.length > 0) {
      const label = document.createElement('div');
      label.className = 'dashboard-subhead';
      label.textContent = 'Recent';
      children.push(label, ...recents.map((p) => renderRecentRow(p, this.callbacks)));
    }
    this.list.replaceChildren(...children);
  }
}
