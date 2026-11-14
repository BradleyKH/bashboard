import { item, type MenuEntry } from './contextMenuModel';
import { ELEMENT_LABELS, SHOWABLE_ORDER, type ShowableSection } from './dashboardSections';

/**
 * The menu for the dashboard outside any row (docs/design/dashboard.md section 4.6): every element and Pins,
 * in the settings dialog's order, checked when shown; choosing one flips its setting.
 */
export function dashboardMenuItems(
  shown: Readonly<Record<ShowableSection, boolean>>,
  onToggle: (element: ShowableSection, show: boolean) => void,
): MenuEntry[] {
  return SHOWABLE_ORDER.map((el) =>
    item(ELEMENT_LABELS[el], () => onToggle(el, !shown[el]), { checked: shown[el] }),
  );
}
