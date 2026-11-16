// Dashboard elements and the sections the user can collapse (docs/design/dashboard.md sections 4.6
// and 7). Pure, no DOM.

import { supports, type Feature, type Os } from './platform';

/**
 * The panel's draggable elements in default order (docs/design/dashboard.md section 4.6). The clock
 * and Launch lead, so each sits at the top of the lower list whenever it is not in the top slot.
 */
export const DEFAULT_ELEMENT_ORDER = [
  'clock',
  'launch',
  'needs',
  'favorites',
  'layouts',
  'panes',
  'containers',
  'ports',
  'ship',
  'branch',
  'localModels',
  'external',
  'system',
  'media',
  'wave',
] as const;

export type DashboardElement = (typeof DEFAULT_ELEMENT_ORDER)[number];

/**
 * What `dashboard.sections` shows or hides: every element, and Pins, which keeps its fixed place
 * between the top slot and the list.
 */
export type ShowableSection = DashboardElement | 'pins';

export interface SectionGroup {
  title: string;
  sections: readonly ShowableSection[];
}

/**
 * How the settings dialog and the dashboard menu group the show toggles. Only those lists follow
 * it; the panel keeps DEFAULT_ELEMENT_ORDER, which also places elements missing from older saves.
 */
export const SECTION_GROUPS: readonly SectionGroup[] = [
  { title: 'Start work', sections: ['launch', 'pins', 'favorites', 'layouts'] },
  { title: 'Sessions', sections: ['needs', 'panes', 'external'] },
  { title: 'Git & CI', sections: ['ship', 'branch'] },
  { title: 'Local services', sections: ['containers', 'ports', 'localModels'] },
  { title: 'Ambient', sections: ['system', 'media', 'clock', 'wave'] },
];

/** Every show toggle in SECTION_GROUPS order. */
export const SHOWABLE_ORDER: readonly ShowableSection[] = SECTION_GROUPS.flatMap((g) => g.sections);

/** Elements with no header to collapse them by. */
type Uncollapsible = 'clock' | 'launch' | 'wave';

/** The collapsible sections: Pins and every element except the clock, Launch, and Wave. */
export type DashboardSection = 'pins' | Exclude<DashboardElement, Uncollapsible>;

const SECTIONS: readonly DashboardSection[] = [
  'pins',
  ...DEFAULT_ELEMENT_ORDER.filter(
    (e): e is Exclude<DashboardElement, Uncollapsible> => e !== 'clock' && e !== 'launch' && e !== 'wave',
  ),
];

/** Whether each element is shown when the user has not said otherwise. */
export const ELEMENT_SHOWN_BY_DEFAULT: Record<ShowableSection, boolean> = {
  launch: true,
  pins: true,
  needs: true,
  favorites: false,
  layouts: false,
  panes: true,
  containers: true,
  ports: true,
  ship: true,
  branch: false,
  localModels: true,
  external: true,
  system: false,
  media: true,
  wave: false,
  clock: false,
};

/** Display names, shared by the settings dialog's checkboxes. */
export const ELEMENT_LABELS: Record<ShowableSection, string> = {
  launch: 'Launch',
  pins: 'Pins',
  needs: 'Needs you',
  favorites: 'Favorites',
  layouts: 'Layouts',
  panes: 'Panes',
  containers: 'Containers',
  ports: 'Ports',
  ship: 'Ship',
  branch: 'Branch',
  localModels: 'Local AI models',
  external: 'External sessions',
  system: 'System',
  media: 'Media',
  wave: 'Wave',
  clock: 'Clock',
};

/** Muted notes under the settings dialog's checkboxes, for elements whose name says little. */
export const ELEMENT_HINTS: Partial<Record<ShowableSection, string>> = {
  wave: 'A Lissajous figure that follows CPU and network load',
  containers: 'Podman and Docker',
  ship: 'Manage pipelines and PRs for selected repos',
  branch: "Git and CI summary for the focused pane's branch",
  pins: 'Saved files, folders, and terminal commands',
  media: 'Now playing in Spotify or another app, on Windows and Linux',
};

/** Elements that need a platform feature; one on an OS without it is hidden everywhere. */
export const ELEMENT_FEATURES: Partial<Record<ShowableSection, Feature>> = {
  media: 'media',
};

/** Whether the OS can show the element. */
export function elementSupported(el: ShowableSection, os?: Os): boolean {
  const feature = ELEMENT_FEATURES[el];
  return feature === undefined || supports(feature, os);
}

function isSection(v: unknown): v is DashboardSection {
  return typeof v === 'string' && (SECTIONS as readonly string[]).includes(v);
}

function isElement(v: unknown): v is DashboardElement {
  return typeof v === 'string' && (DEFAULT_ELEMENT_ORDER as readonly string[]).includes(v);
}

/** Launch's element name in workspaces saved under its earlier names. */
function savedElementName(v: unknown): unknown {
  return v === 'folder' || v === 'repo' ? 'launch' : v;
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
  for (const name of raw) {
    const item = savedElementName(name);
    if (isElement(item) && !out.includes(item)) out.push(item);
  }
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
  for (const name of raw) {
    const item = savedElementName(name);
    if (isElement(item) && !out.includes(item)) out.push(item);
  }
  return out;
}

/** The elements in the top slot when the user has not moved any. */
export const DEFAULT_TOP_ELEMENTS: readonly DashboardElement[] = ['clock', 'launch'];

/** The slot above Pins, or the list between Pins and the footer. */
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
