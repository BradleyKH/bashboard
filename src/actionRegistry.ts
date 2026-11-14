import type { Action, Direction } from './keymap';

/**
 * Every keybinding action, one row each, in F1 guide order (docs/design/keys.md section 4.5).
 * The keymap's name lists, the help sections, labels, and notes, and the Shortcuts tab's
 * per-argument rows all derive from this table.
 */

/** What a binding for the action carries besides its keys. */
export type ActionArg = 'none' | 'direction' | 'index' | 'input';

export const HELP_SECTION_TITLES = ['Panes', 'Tabs', 'Terminal', 'Workspace'] as const;
export type HelpSectionTitle = (typeof HELP_SECTION_TITLES)[number];

export interface ActionRow {
  name: string;
  arg: ActionArg;
  /** The F1 label; sendInput has none, since each binding is labeled by its input. */
  label?: string;
  section: HelpSectionTitle;
  note?: string;
}

export const ACTION_REGISTRY = [
  { name: 'splitRight', arg: 'none', label: 'Split right', section: 'Panes' },
  { name: 'splitDown', arg: 'none', label: 'Split down', section: 'Panes' },
  { name: 'splitLeft', arg: 'none', label: 'Split left', section: 'Panes' },
  { name: 'splitUp', arg: 'none', label: 'Split up', section: 'Panes' },
  { name: 'splitAuto', arg: 'none', label: 'Split along the longer side', section: 'Panes' },
  { name: 'closePane', arg: 'none', label: 'Close pane', section: 'Panes' },
  { name: 'newScratch', arg: 'none', label: 'New scratch pad', section: 'Panes' },
  { name: 'openFiles', arg: 'none', label: 'Open files for the repo', section: 'Panes' },
  { name: 'openGit', arg: 'none', label: 'Git pane for this repo', section: 'Panes' },
  { name: 'openSearch', arg: 'none', label: "Search the repo's code", section: 'Panes' },
  { name: 'openEditor', arg: 'none', label: 'Open the repo in the editor', section: 'Panes' },
  { name: 'collapsePane', arg: 'none', label: 'Collapse pane', section: 'Panes' },
  { name: 'togglePaneZoom', arg: 'none', label: 'Zoom or unzoom pane', section: 'Panes' },
  { name: 'moveFocus', arg: 'direction', label: 'Move focus', section: 'Panes' },
  { name: 'resizePane', arg: 'direction', label: 'Resize pane', section: 'Panes' },

  { name: 'newTab', arg: 'none', label: 'New tab', section: 'Tabs' },
  { name: 'closeTab', arg: 'none', label: 'Close tab', section: 'Tabs' },
  { name: 'nextTab', arg: 'none', label: 'Next tab', section: 'Tabs' },
  { name: 'prevTab', arg: 'none', label: 'Previous tab', section: 'Tabs' },
  { name: 'switchToTab', arg: 'index', label: 'Go to tab 1 to 8', section: 'Tabs' },
  { name: 'switchToLastTab', arg: 'none', label: 'Go to the last tab', section: 'Tabs' },

  {
    name: 'copy',
    arg: 'none',
    label: 'Copy selection',
    section: 'Terminal',
    note: 'With nothing selected, the key goes to the shell',
  },
  {
    name: 'paste',
    arg: 'none',
    label: 'Paste',
    section: 'Terminal',
    note: 'With no text on the clipboard, the key goes to the shell so Claude Code can paste an image',
  },
  { name: 'find', arg: 'none', label: 'Find in scrollback or file preview', section: 'Terminal' },
  {
    name: 'goToLine',
    arg: 'none',
    label: 'Go to line in a code preview',
    section: 'Terminal',
    note: 'Only in the code view of a Files or Search pane; elsewhere the key goes to the shell',
  },
  { name: 'sendInput', arg: 'input', section: 'Terminal' },
  { name: 'increaseFontSize', arg: 'none', label: 'Increase text size', section: 'Terminal' },
  { name: 'decreaseFontSize', arg: 'none', label: 'Decrease text size', section: 'Terminal' },
  { name: 'resetFontSize', arg: 'none', label: 'Reset text size', section: 'Terminal' },

  { name: 'openPalette', arg: 'none', label: 'Command palette', section: 'Workspace' },
  { name: 'nextAttention', arg: 'none', label: 'Jump to the next thing that needs you', section: 'Workspace' },
  { name: 'toggleDashboard', arg: 'none', label: 'Toggle dashboard', section: 'Workspace' },
  { name: 'focusDashboard', arg: 'none', label: 'Move focus to the dashboard and back', section: 'Workspace' },
  { name: 'openLaunch', arg: 'none', label: 'Launch a pane or the editor', section: 'Workspace' },
  { name: 'openFavorite', arg: 'none', label: 'Open a favorite folder', section: 'Workspace' },
  { name: 'openLayout', arg: 'none', label: 'Open a saved layout', section: 'Workspace' },
  { name: 'splitWithProfile', arg: 'none', label: 'Split with a chosen shell', section: 'Workspace' },
  { name: 'cycleScrim', arg: 'none', label: 'Cycle background brightness', section: 'Workspace' },
  { name: 'toggleBackgroundTabs', arg: 'none', label: 'Show or hide other tabs in the background', section: 'Workspace' },
  { name: 'toggleBackdrop', arg: 'none', label: 'Pause or resume the background animation', section: 'Workspace' },
  { name: 'toggleFullscreen', arg: 'none', label: 'Toggle full screen', section: 'Workspace' },
  { name: 'showHelp', arg: 'none', label: 'Help', section: 'Workspace' },
  { name: 'openSettings', arg: 'none', label: 'Settings', section: 'Workspace' },
  { name: 'showAccounts', arg: 'none', label: 'Manage code host accounts', section: 'Workspace' },
  { name: 'showShortcuts', arg: 'none', label: 'Keyboard shortcuts', section: 'Workspace' },
  { name: 'showCli', arg: 'none', label: 'Pane CLI reference', section: 'Workspace' },
  { name: 'showAbout', arg: 'none', label: 'About Bashboard', section: 'Workspace' },
] as const satisfies readonly ActionRow[];

type Row = (typeof ACTION_REGISTRY)[number];
export type ActionName = Row['name'];
type NamesWithArg<A extends ActionArg> = Extract<Row, { arg: A }>['name'];

// Compile-time parity with the Action union: a name on one side only fails tsc here, naming it.
// Each argument kind must also match the field its Action member carries.
type MustBeNever<T extends never> = T;
export type ActionMissingFromRegistry = MustBeNever<Exclude<Action['type'], ActionName>>;
export type RegistryNameMissingFromAction = MustBeNever<Exclude<ActionName, Action['type']>>;
export type DirectionArgMismatch = MustBeNever<
  | Exclude<NamesWithArg<'direction'>, Extract<Action, { direction: Direction }>['type']>
  | Exclude<Extract<Action, { direction: Direction }>['type'], NamesWithArg<'direction'>>
>;
export type IndexArgMismatch = MustBeNever<
  | Exclude<NamesWithArg<'index'>, Extract<Action, { index: number }>['type']>
  | Exclude<Extract<Action, { index: number }>['type'], NamesWithArg<'index'>>
>;
export type InputArgMismatch = MustBeNever<
  | Exclude<NamesWithArg<'input'>, Extract<Action, { input: string }>['type']>
  | Exclude<Extract<Action, { input: string }>['type'], NamesWithArg<'input'>>
>;

const ARG_BY_NAME = new Map<string, ActionArg>(ACTION_REGISTRY.map((r) => [r.name, r.arg]));

/** The argument kind of an action, or undefined for a name that is not an action. */
export function actionArg(name: string): ActionArg | undefined {
  return ARG_BY_NAME.get(name);
}
