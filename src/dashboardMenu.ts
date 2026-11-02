import { item, type MenuEntry } from './contextMenuModel';
import { DEFAULT_ELEMENT_ORDER, ELEMENT_LABELS, type DashboardElement } from './dashboardSections';

/**
 * The menu for the dashboard outside any row (docs/design.md section 4.6): every element, in the
 * settings dialog's order, checked when shown; choosing one flips its setting.
 */
export function dashboardMenuItems(
  shown: Readonly<Record<DashboardElement, boolean>>,
  onToggle: (element: DashboardElement, show: boolean) => void,
): MenuEntry[] {
  return DEFAULT_ELEMENT_ORDER.map((el) =>
    item(ELEMENT_LABELS[el], () => onToggle(el, !shown[el]), { checked: shown[el] }),
  );
}
