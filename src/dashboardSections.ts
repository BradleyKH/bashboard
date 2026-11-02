// Dashboard elements and the sections the user can collapse (docs/design.md sections 4.6 and 7).
// Pure, no DOM.

/**
 * The panel's elements between Repo and the footer, in default order (docs/design.md section
 * 4.6). The clock is first here, so it sits at the top of the elements whenever it is not in the
 * slot above Repo.
 */
export const DEFAULT_ELEMENT_ORDER = [
  'clock',
  'favorites',
  'layouts',
  'panes',
  'containers',
  'external',
  'system',
] as const;

export type DashboardElement = (typeof DEFAULT_ELEMENT_ORDER)[number];

/** The collapsible sections: Repo plus every element except the clock. */
export type DashboardSection = 'repo' | Exclude<DashboardElement, 'clock'>;

const SECTIONS: readonly DashboardSection[] = [
  'repo',
  ...DEFAULT_ELEMENT_ORDER.filter((e): e is Exclude<DashboardElement, 'clock'> => e !== 'clock'),
];

/** Whether each element is shown when the user has not said otherwise. */
export const ELEMENT_SHOWN_BY_DEFAULT: Record<DashboardElement, boolean> = {
  favorites: true,
  layouts: true,
  panes: true,
  containers: true,
  external: true,
  system: false,
  clock: false,
};

/** Display names, shared by the settings dialog's checkboxes. */
export const ELEMENT_LABELS: Record<DashboardElement, string> = {
  favorites: 'Favorites',
  layouts: 'Layouts',
  panes: 'Panes',
  containers: 'Containers',
  external: 'External sessions',
  system: 'System',
  clock: 'Clock',
};

function isSection(v: unknown): v is DashboardSection {
  return typeof v === 'string' && (SECTIONS as readonly string[]).includes(v);
}

function isElement(v: unknown): v is DashboardElement {
  return typeof v === 'string' && (DEFAULT_ELEMENT_ORDER as readonly string[]).includes(v);
}

/** Keeps known names in order, once each, dropping anything else; a non-array gives []. */
export function parseCollapsedSections(raw: unknown): DashboardSection[] {
  if (!Array.isArray(raw)) return [];
  const out: DashboardSection[] = [];
  for (const item of raw) if (isSection(item) && !out.includes(item)) out.push(item);
  return out;
}

/** Adds the section when absent, else removes it. */
export function toggleSection(list: readonly DashboardSection[], s: DashboardSection): DashboardSection[] {
  return list.includes(s) ? list.filter((x) => x !== s) : [...list, s];
}

/**
 * Parses a saved element order: known names once each in saved order, anything else dropped. An
 * element missing from the saved list is inserted after the nearest element that precedes it in
 * the default order, so a workspace saved before an element existed still loads sensibly.
 */
export function parseSectionOrder(raw: unknown): DashboardElement[] {
  if (!Array.isArray(raw)) return [...DEFAULT_ELEMENT_ORDER];
  const out: DashboardElement[] = [];
  for (const item of raw) if (isElement(item) && !out.includes(item)) out.push(item);
  DEFAULT_ELEMENT_ORDER.forEach((el, i) => {
    if (out.includes(el)) return;
    let at = 0;
    for (let j = i - 1; j >= 0; j--) {
      const idx = out.indexOf(DEFAULT_ELEMENT_ORDER[j]);
      if (idx >= 0) {
        at = idx + 1;
        break;
      }
    }
    out.splice(at, 0, el);
  });
  return out;
}

/** Keeps known element names in order, once each; a non-array gives null. */
export function parseTopElements(raw: unknown): DashboardElement[] | null {
  if (!Array.isArray(raw)) return null;
  const out: DashboardElement[] = [];
  for (const item of raw) if (isElement(item) && !out.includes(item)) out.push(item);
  return out;
}

/** The elements in the slot above Repo when the user has not moved any: just the clock. */
export const DEFAULT_TOP_ELEMENTS: readonly DashboardElement[] = ['clock'];

/** The slot above Repo, or the list between Repo and the footer. */
export type ElementZone = 'top' | 'list';

export interface ElementPlacement {
  order: DashboardElement[];
  /** The elements in the top slot; each zone shows its elements in `order`'s order. */
  top: DashboardElement[];
}

/**
 * Moves `moved` into `zone`, just before `before` or last in the zone when `before` is null.
 * The returned order keeps every top element ahead of every list element, so "last in the top
 * slot" has one place in it. Working by name lets the panel drop among the elements it shows
 * while disabled ones keep their places.
 */
export function placeElement(
  order: readonly DashboardElement[],
  top: readonly DashboardElement[],
  moved: DashboardElement,
  zone: ElementZone,
  before: DashboardElement | null,
): ElementPlacement {
  if (before === moved) return { order: [...order], top: [...top] };
  const inTop = new Set(top);
  if (zone === 'top') inTop.add(moved);
  else inTop.delete(moved);
  const rest = order.filter((e) => e !== moved);
  const sorted = [...rest.filter((e) => inTop.has(e)), ...rest.filter((e) => !inTop.has(e))];
  let at = before === null ? -1 : sorted.indexOf(before);
  if (at < 0) at = zone === 'top' ? sorted.filter((e) => inTop.has(e)).length : sorted.length;
  sorted.splice(at, 0, moved);
  return { order: sorted, top: sorted.filter((e) => inTop.has(e)) };
}
