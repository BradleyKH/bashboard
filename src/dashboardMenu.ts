import type { Os } from './platform';
import { heading, item, type MenuEntry } from './contextMenuModel';
import { ELEMENT_LABELS, SECTION_GROUPS, elementSupported, type ShowableSection } from './dashboardSections';

/**
 * The menu for the dashboard outside any row (docs/design/dashboard.md section 4.6): every element and Pins,
 * under the settings dialog's group headings, checked when shown; choosing one flips its setting.
 */
export function dashboardMenuItems(
  shown: Readonly<Record<ShowableSection, boolean>>,
  onToggle: (element: ShowableSection, show: boolean) => void,
  os?: Os,
): MenuEntry[] {
  return SECTION_GROUPS.flatMap((group) => [
    heading(group.title),
    ...group.sections.filter((el) => elementSupported(el, os)).map((el) => item(ELEMENT_LABELS[el], () => onToggle(el, !shown[el]), { checked: shown[el] })),
  ]);
}
