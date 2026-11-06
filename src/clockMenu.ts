import { CLOCK_STYLE_OPTIONS, type ClockStyle } from './clockModel';
import { item, separator, type MenuEntry } from './contextMenuModel';

/**
 * The clock's own menu (docs/design/dashboard.md section 4.6): each style as a radio choice, then
 * Hide clock. Both save the setting; its reload applies the change.
 */
export function clockMenuItems(
  current: ClockStyle,
  onStyle: (style: ClockStyle) => void,
  onHide: () => void,
): MenuEntry[] {
  return [
    ...CLOCK_STYLE_OPTIONS.map(({ value, label }) =>
      item(label, () => onStyle(value), { checked: value === current }),
    ),
    separator(),
    item('Hide clock', onHide),
  ];
}
