/** The tabs of the app dialog, left to right (docs/design.md section 4.18). */
export const DIALOG_TABS = ['help', 'settings', 'accounts', 'shortcuts', 'cli', 'about'] as const;

export type DialogTab = (typeof DIALOG_TABS)[number];

export const DIALOG_TAB_LABELS: Record<DialogTab, string> = {
  help: 'Help',
  settings: 'Settings',
  accounts: 'Accounts',
  shortcuts: 'Shortcuts',
  cli: 'CLI',
  about: 'About',
};

/** The tab `step` places away from `tab`, wrapping at either end. */
export function stepTab(tab: DialogTab, step: number): DialogTab {
  const n = DIALOG_TABS.length;
  const i = DIALOG_TABS.indexOf(tab);
  return DIALOG_TABS[(((i + step) % n) + n) % n];
}

/** The workspace action that opens each tab, keyed by action name. */
export const DIALOG_TAB_FOR_ACTION: Readonly<Record<string, DialogTab>> = {
  showHelp: 'help',
  openSettings: 'settings',
  showAccounts: 'accounts',
  showShortcuts: 'shortcuts',
  showCli: 'cli',
  showAbout: 'about',
};
