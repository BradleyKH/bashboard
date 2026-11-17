import { item, separator, type MenuEntry } from './contextMenuModel';

/** The System section's rows, in the order they show. */
export type SystemRow = 'cpu' | 'memory' | 'network' | 'disk';

export type SystemRowsShown = Record<SystemRow, boolean>;

const LABELS: [SystemRow, string][] = [
  ['cpu', 'CPU'],
  ['memory', 'Memory'],
  ['network', 'Network'],
  ['disk', 'Disk'],
];

/**
 * The System section's own menu (docs/design/dashboard.md section 4.6): a checked toggle per row,
 * then Hide system. Each saves its setting; the setting's reload applies the change.
 */
export function systemMenuItems(
  shown: SystemRowsShown,
  onSetShown: (row: SystemRow, shown: boolean) => void,
  onHide: () => void,
): MenuEntry[] {
  return [
    ...LABELS.map(([row, label]) => item(label, () => onSetShown(row, !shown[row]), { checked: shown[row] })),
    separator(),
    item('Hide system', onHide),
  ];
}
