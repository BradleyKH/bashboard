// Dashboard sections the user can collapse (docs/design.md sections 4.6 and 7). Pure, no DOM.

export type DashboardSection = 'repo' | 'favorites' | 'layouts' | 'panes' | 'containers' | 'external';

const SECTIONS: readonly DashboardSection[] = ['repo', 'favorites', 'layouts', 'panes', 'containers', 'external'];

function isSection(v: unknown): v is DashboardSection {
  return typeof v === 'string' && (SECTIONS as readonly string[]).includes(v);
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
