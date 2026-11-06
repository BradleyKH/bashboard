import type { Action } from './keymap';
import { buildPaletteItems, pushRecent, rankPalette, type PaletteCommand, type PaletteInput, type PaletteItem } from './paletteModel';
import { Picker, type PickerItem } from './picker';
import type { Pin } from './repos';

export interface CommandPaletteDeps {
  input(): PaletteInput;
  refocus(): void;
  focusPane(paneId: string): void;
  switchTab(tabId: string): void;
  openFavorite(path: string, opts: { collapsed: boolean }): void;
  openLayout(name: string): void;
  openPin(pin: Pin): void;
  openWorktree(path: string, opts: { collapsed: boolean }): void;
  runAction(action: Action): void;
  runCommand(command: PaletteCommand): void;
}

/** One list over panes, tabs, favorites, layouts, pins, worktrees, and actions (docs/design/keys.md section 4.5). */
export class CommandPalette {
  private readonly picker: Picker;
  private items = new Map<string, PaletteItem>();
  /** Most recent first; kept for the session only. */
  private recents: string[] = [];

  constructor(private readonly deps: CommandPaletteDeps) {
    this.picker = new Picker(
      { onOpen: (value, opts) => this.choose(value, opts), onClose: () => deps.refocus() },
      { matcher: (shown, query) => this.match(shown, query) },
    );
  }

  open(): void {
    this.picker.open(this.build(), 'Type to search, > for actions');
  }

  isOpen(): boolean {
    return this.picker.isOpen();
  }

  /** Rebuilds the items from current state while open, keeping query, selection, and scroll. */
  refresh(): void {
    if (this.picker.isOpen()) this.picker.setItems(this.build());
  }

  private build(): PickerItem[] {
    const built = buildPaletteItems(this.deps.input());
    this.items = new Map(built.map((it) => [it.id, it]));
    return built.map((it) => ({ value: it.id, label: it.label, detail: it.detail, hint: it.hint, category: it.category }));
  }

  private match(shown: PickerItem[], query: string): PickerItem[] {
    const byId = new Map(shown.map((p) => [p.value, p]));
    const palette = shown.flatMap((p) => this.items.get(p.value) ?? []);
    return rankPalette(palette, query, this.recents).flatMap((it) => byId.get(it.id) ?? []);
  }

  private choose(id: string, { collapsed }: { collapsed: boolean }): void {
    const item = this.items.get(id);
    if (!item) return;
    this.recents = pushRecent(this.recents, id);
    // The picker input held DOM focus; actions such as split, find, and close apply to the focused pane.
    this.deps.refocus();
    const c = item.choice;
    switch (c.kind) {
      case 'pane':
        this.deps.focusPane(c.paneId);
        break;
      case 'tab':
        this.deps.switchTab(c.tabId);
        break;
      case 'favorite':
        this.deps.openFavorite(c.path, { collapsed });
        break;
      case 'layout':
        this.deps.openLayout(c.name);
        break;
      case 'pin':
        this.deps.openPin(c.pin);
        break;
      case 'worktree':
        this.deps.openWorktree(c.path, { collapsed });
        break;
      case 'action':
        this.deps.runAction(c.action);
        break;
      case 'command':
        this.deps.runCommand(c.command);
        break;
    }
  }
}
