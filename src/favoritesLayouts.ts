// Favorite folders and named layouts: their dashboard sections, the favorites, shell, and layout
// pickers, and saving each list when it changes.
import type { AppState } from './appState';
import type { DashboardPanel } from './dashboardPanel';
import { lastFolder } from './dashboardModel';
import { samePath, type Favorite } from './favorites';
import { layoutFromSnapshot, upsertLayout, type NamedLayout } from './layouts';
import { favoritesSave, layoutsSave } from './persistence';
import { Picker, type PickerItem } from './picker';
import { showToast } from './toast';
import type { Workspace } from './workspace';

export interface FavoritesLayoutsDeps {
  state: AppState;
  workspace: () => Workspace;
  panel: () => DashboardPanel;
  focusTerminal: () => void;
  /** A favorite or layout was added; the tour waits for one. */
  onAdded?: () => void;
}

export class FavoritesLayouts {
  private readonly picker: Picker;
  private readonly profilePicker: Picker;
  private readonly layoutPicker: Picker;

  constructor(private readonly deps: FavoritesLayoutsDeps) {
    const { state, focusTerminal } = deps;
    this.picker = new Picker(
      { onOpen: this.openFolder, onClose: focusTerminal },
      {
        action: {
          kind: 'run',
          label: '+ Add',
          title: 'Add the focused terminal’s folder to favorites',
          enabled: () => this.canAddFocusedFolder(),
          run: this.addFocusedFolder,
        },
        manage: {
          noun: 'favorite',
          rename: (path, label) =>
            this.updateFavorites(state.favorites.map((f) => (samePath(f.path, path) ? { ...f, label } : f))),
          remove: (path) => this.updateFavorites(state.favorites.filter((f) => !samePath(f.path, path))),
        },
      },
    );
    this.profilePicker = new Picker({
      onOpen: (profile, opts) => this.openWithProfile(profile, opts),
      onClose: focusTerminal,
    });
    // A layout always opens as a new tab, so Ctrl+Enter has nothing to collapse.
    this.layoutPicker = new Picker(
      { onOpen: (name) => this.openLayout(name), onClose: focusTerminal },
      {
        action: {
          kind: 'name',
          label: '+ Save',
          title: 'Save the current panes as a layout',
          placeholder: 'Name this layout',
          exists: (name) => state.layouts.some((l) => l.name.toLowerCase() === name.toLowerCase()),
          submit: this.saveLayout,
        },
        manage: {
          noun: 'layout',
          rename: (name, next) => this.renameLayout(state.layouts.findIndex((l) => l.name === name), next),
          remove: (name) => this.updateLayouts(state.layouts.filter((l) => l.name !== name)),
          confirmRemove: true,
        },
      },
    );
  }

  private favoriteItems(): PickerItem[] {
    return this.deps.state.favorites.map((f) => ({ label: f.label, detail: f.path, value: f.path }));
  }

  private profileItems(): PickerItem[] {
    return this.deps.state.profiles.map((p) => ({ label: p.name, value: p.id }));
  }

  private layoutItems(): PickerItem[] {
    return this.deps.state.layouts.map((l) => {
      const n = l.tab.panes.length;
      return { label: l.name, detail: `${n} ${n === 1 ? 'pane' : 'panes'}`, value: l.name };
    });
  }

  openFavoritePicker(anchor?: HTMLElement): void {
    this.picker.open(this.favoriteItems(), 'Open a favorite folder', anchor);
  }

  openProfilePicker(): void {
    this.profilePicker.open(this.profileItems(), 'Split with a shell');
  }

  openLayoutPicker(anchor?: HTMLElement): void {
    this.layoutPicker.open(this.layoutItems(), 'Open a layout', anchor);
  }

  showFavorites(): void {
    this.deps.panel().setFavorites(this.deps.state.favorites);
    this.picker.setItems(this.favoriteItems());
  }

  updateFavorites(next: Favorite[]): void {
    this.deps.state.favorites = next;
    this.showFavorites();
    favoritesSave(next).catch((err: unknown) => showToast(`Could not save favorites: ${String(err)}`));
  }

  readonly addFavorite = (path: string, profile?: string): void => {
    const { favorites } = this.deps.state;
    if (favorites.some((f) => samePath(f.path, path))) return;
    this.updateFavorites([...favorites, { label: lastFolder(path) || path, path, ...(profile ? { profile } : {}) }]);
    this.deps.onAdded?.();
  };

  private canAddFocusedFolder(): boolean {
    const cwd = this.deps.workspace().terminals().find((t) => t.focused)?.cwd;
    return !!cwd && !this.deps.state.favorites.some((f) => samePath(f.path, cwd));
  }

  /** The dashboard's and the favorites menu's "+": the focused terminal's folder, and its shell when not the default. */
  readonly addFocusedFolder = (): void => {
    const focused = this.deps.workspace().terminals().find((t) => t.focused);
    if (!focused?.cwd) return;
    const profile = focused.profile !== this.deps.state.settings.shell.defaultProfile ? focused.profile : undefined;
    this.addFavorite(focused.cwd, profile);
  };

  /** Collapsed opens leave focus where it was, so the terminal is refocused explicitly. */
  readonly openFolder = (path: string, opts: { collapsed: boolean }): void => {
    const profile = this.deps.state.favorites.find((f) => samePath(f.path, path))?.profile;
    this.deps.workspace().openTerminal(path, { collapsed: opts.collapsed, profile });
    this.deps.focusTerminal();
  };

  private openWithProfile(profile: string, opts: { collapsed: boolean }): void {
    const workspace = this.deps.workspace();
    const cwd = workspace.terminals().find((t) => t.focused)?.cwd ?? undefined;
    workspace.openTerminal(cwd, { collapsed: opts.collapsed, profile });
    this.deps.focusTerminal();
  }

  showLayouts(): void {
    this.deps.panel().setLayouts(this.deps.state.layouts);
    this.layoutPicker.setItems(this.layoutItems());
  }

  updateLayouts(next: NamedLayout[]): void {
    this.deps.state.layouts = next;
    this.showLayouts();
    layoutsSave(next).catch((err: unknown) => showToast(`Could not save layouts: ${String(err)}`));
  }

  readonly saveLayout = (name: string): void => {
    this.updateLayouts(upsertLayout(this.deps.state.layouts, layoutFromSnapshot(name, this.deps.workspace().snapshot())));
    this.deps.onAdded?.();
  };

  readonly renameLayout = (index: number, name: string): void => {
    const { layouts } = this.deps.state;
    if (layouts.some((l, i) => i !== index && l.name.toLowerCase() === name.toLowerCase())) {
      showToast(`A layout named ${name} already exists.`);
      this.deps.panel().setLayouts(layouts);
      return;
    }
    this.updateLayouts(layouts.map((l, i) => (i === index ? { ...l, name } : l)));
  };

  readonly openLayout = (name: string): void => {
    const layout = this.deps.state.layouts.find((l) => l.name === name);
    if (!layout) {
      showToast(`No layout named ${name}.`);
      return;
    }
    this.deps.workspace().openLayout(layout.tab, layout.name);
  };
}
