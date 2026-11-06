// The dashboard's two-column layout (docs/design/dashboard.md section 4.6). Pure, no DOM.

import { parseTopElements, type DashboardElement, type ElementZone } from './dashboardSections';

export type DashboardColumn = 'left' | 'right';

/** The panel switches to two columns at this width, coming from one. */
export const TWO_COLUMN_ENTER_WIDTH = 600;
/** And back to one below this, so a slow drag across the threshold does not flicker. */
export const TWO_COLUMN_LEAVE_WIDTH = 568;

/** The column count for a panel `width` px wide that shows `current` columns now. */
export function columnCount(width: number, current: 1 | 2): 1 | 2 {
  return width >= (current === 2 ? TWO_COLUMN_LEAVE_WIDTH : TWO_COLUMN_ENTER_WIDTH) ? 2 : 1;
}

/** The right column's elements once the panel first shows two columns; the rest go left. */
export const DEFAULT_RIGHT_ELEMENTS: readonly DashboardElement[] = [
  'clock',
  'wave',
  'system',
  'localModels',
  'containers',
  'ports',
];

/** A saved right column: known names once each; a non-array gives null (not split yet). */
export const parseRightElements = parseTopElements;

export function parsePinsColumn(raw: unknown): DashboardColumn | null {
  return raw === 'left' || raw === 'right' ? raw : null;
}

/** Where every element sits. `top` and `right` are sets kept as lists; `order` orders each group. */
export interface ColumnPlacement {
  order: DashboardElement[];
  top: DashboardElement[];
  right: DashboardElement[];
}

/** The four groups in one-column display order: left top, right top, left list, right list. */
function groupOf(p: { top: ReadonlySet<DashboardElement>; right: ReadonlySet<DashboardElement> }, e: DashboardElement): number {
  return (p.top.has(e) ? 0 : 2) + (p.right.has(e) ? 1 : 0);
}

/** `order` stably sorted into the four groups, so the one-column sequence is the order itself. */
function sortByGroup(
  order: readonly DashboardElement[],
  sets: { top: ReadonlySet<DashboardElement>; right: ReadonlySet<DashboardElement> },
): DashboardElement[] {
  return order
    .map((e, i) => ({ e, i, g: groupOf(sets, e) }))
    .sort((a, b) => a.g - b.g || a.i - b.i)
    .map((x) => x.e);
}

/** The elements of one column and slot, in order. */
export function slotElements(p: ColumnPlacement, column: DashboardColumn, zone: ElementZone): DashboardElement[] {
  const right = column === 'right';
  const top = zone === 'top';
  return p.order.filter((e) => p.right.includes(e) === right && p.top.includes(e) === top);
}

/**
 * Moves `moved` into `zone` of `column`, just before `before`, or last in that slot when
 * `before` is null. `before` may sit in another group, as it does when a one-column drop lands
 * between the columns' runs; the moved element then ends last in its own group. The returned
 * order is sorted into the four groups.
 */
export function placeInColumns(
  p: ColumnPlacement,
  moved: DashboardElement,
  zone: ElementZone,
  column: DashboardColumn,
  before: DashboardElement | null,
): ColumnPlacement {
  if (before === moved) return { order: [...p.order], top: [...p.top], right: [...p.right] };
  const top = new Set(p.top);
  const right = new Set(p.right);
  if (zone === 'top') top.add(moved);
  else top.delete(moved);
  if (column === 'right') right.add(moved);
  else right.delete(moved);
  const sets = { top, right };
  const rest = sortByGroup(
    p.order.filter((e) => e !== moved),
    sets,
  );
  const at = before === null ? -1 : rest.indexOf(before);
  rest.splice(at < 0 ? rest.length : at, 0, moved);
  const order = sortByGroup(rest, sets);
  return { order, top: order.filter((e) => top.has(e)), right: order.filter((e) => right.has(e)) };
}

/**
 * A drop while the panel shows one column. `shown` is the zone's shown elements in display
 * order, the moved one included where it is. The element joins the column of the shown element
 * just above the drop, or just below at the slot's top edge, and keeps its own column in an
 * otherwise empty slot or when dropped where it already was.
 */
export function dropInOneColumn(
  p: ColumnPlacement,
  shown: readonly DashboardElement[],
  moved: DashboardElement,
  zone: ElementZone,
  before: DashboardElement | null,
): ColumnPlacement {
  const own: DashboardColumn = p.right.includes(moved) ? 'right' : 'left';
  const at = shown.indexOf(moved);
  const sameZone = p.top.includes(moved) === (zone === 'top');
  // Just above it or just below it: the gaps on either side of the moved element itself.
  const next = at >= 0 && at + 1 < shown.length ? shown[at + 1] : null;
  if (sameZone && at >= 0 && (before === moved || before === next)) {
    return { order: [...p.order], top: [...p.top], right: [...p.right] };
  }
  const others = shown.filter((e) => e !== moved);
  const i = before === null ? others.length : others.indexOf(before);
  const neighbor = i > 0 ? others[i - 1] : (others[0] ?? null);
  const column: DashboardColumn = neighbor === null ? own : p.right.includes(neighbor) ? 'right' : 'left';
  return placeInColumns(p, moved, zone, column, before);
}
