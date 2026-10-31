// Dashboard elements and the sections the user can collapse (docs/design.md sections 4.6 and 7).
// Pure, no DOM.

/**
 * The panel's elements between Repo and the footer, in default order (docs/design.md section
 * 4.6). The clock stays last, just above the footer.
 */
export const DEFAULT_ELEMENT_ORDER = ['favorites', 'layouts', 'panes', 'containers', 'external', 'clock'] as const;

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
  clock: false,
};

/** Display names, shared by the settings dialog's checkboxes. */
export const ELEMENT_LABELS: Record<DashboardElement, string> = {
  favorites: 'Favorites',
  layouts: 'Layouts',
  panes: 'Panes',
  containers: 'Containers',
  external: 'External sessions',
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

/**
 * Returns a new order with `moved` just before `before`, or last when `before` is null. Working
 * by name lets the panel drop among the elements it shows while disabled ones keep their places.
 */
export function moveSection(
  order: readonly DashboardElement[],
  moved: DashboardElement,
  before: DashboardElement | null,
): DashboardElement[] {
  if (before === moved) return [...order];
  const rest = order.filter((e) => e !== moved);
  const at = before === null ? rest.length : rest.indexOf(before);
  rest.splice(at < 0 ? rest.length : at, 0, moved);
  return rest;
}
