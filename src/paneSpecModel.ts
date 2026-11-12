import type { PaneKind } from './paneKinds';
import type { PtyRef, SavedPane } from './savedWorkspace';
import type { PaneSpec } from './workspaceTypes';

/**
 * What to build for a restored or replaced pane (docs/design/workspace.md sections 4.9 and 4.11).
 * No DOM; the file loads come in as functions so restore can read saved text without this module
 * touching the core.
 */

export interface SavedTextLoaders {
  scratch: (scratchId: string) => Promise<string>;
  scrollback: (scrollbackId: string) => Promise<string>;
}

/** The saved terminal's pty when the core still runs it, matched on start time as well as id. */
export function livePty(p: SavedPane, live: readonly PtyRef[]): PtyRef | null {
  if (p.kind !== 'terminal' || !p.pty) return null;
  const { id, startedAt } = p.pty;
  return live.find((l) => l.id === id && l.startedAt === startedAt) ?? null;
}

/**
 * A plain terminal standing in for a saved pane that could not be rebuilt (docs/design/workspace.md
 * section 4.9), opened in the pane's folder when it had one. A live pty the pane named is kept,
 * since nothing else would claim or kill it.
 */
export function fallbackSpec(p: SavedPane, livePtys: readonly PtyRef[] = []): PaneSpec {
  const folder = p.kind === 'terminal' ? p.cwd : p.kind === 'files' ? p.folder : p.kind === 'git' ? p.root : undefined;
  const attach = livePty(p, livePtys);
  return { kind: 'terminal', ...(folder && { cwd: folder }), ...(attach && { attach }) };
}

/**
 * A pad keeps its saved file, and a terminal its saved scrollback, only when restoring the
 * workspace; layouts and missing ids open fresh. A terminal whose pty is in `livePtys` reattaches
 * to it.
 */
export function restoredSpec(
  p: SavedPane,
  opts: { loadScratch: boolean; loadScrollback: boolean; livePtys?: readonly PtyRef[] },
  load: SavedTextLoaders,
): PaneSpec {
  switch (p.kind) {
    case 'terminal': {
      const attach = livePty(p, opts.livePtys ?? []);
      // An empty cwd lets the core fall back to startingDirectory.
      return {
        kind: 'terminal',
        cwd: p.cwd || undefined,
        profile: p.profile,
        scrollbackId: p.scrollbackId,
        ...(attach && { attach }),
        ...(opts.loadScrollback && p.scrollbackId && { replay: load.scrollback(p.scrollbackId) }),
      };
    }
    case 'scratch':
      if (opts.loadScratch && p.scratchId) return { kind: 'scratch', scratchId: p.scratchId, text: load.scratch(p.scratchId) };
      return { kind: 'scratch' };
    case 'files':
      return {
        kind: 'files',
        folder: p.folder,
        selected: p.selected,
        root: p.root,
        expanded: p.expanded ?? false,
        sort: p.sort,
      };
    case 'git':
      return { kind: 'git', root: p.root, tab: p.tab };
    case 'ship':
      return {
        kind: 'ship',
        root: p.root,
        tab: p.tab,
        thisBranch: p.thisBranch,
        thisBranchPulls: p.thisBranchPulls,
        allPulls: p.allPulls,
      };
    case 'search':
      return { kind: 'search', root: p.root, query: p.query, options: p.options };
    case 'containers':
      return { kind: 'containers' };
    case 'ports':
      return { kind: 'ports' };
    case 'browser':
      return { kind: 'browser', url: p.url, devtools: p.devtools, device: p.device };
  }
}

/**
 * Design 4.11 Kind menu: a pane with no folder becoming a terminal opens where the tab's most
 * recent terminal is (`recentCwd`), else in the core's startingDirectory, with the default
 * profile; becoming a Files or Git pane, it falls back last to the Repo section's repo
 * (`repoFolder`). A Ship pane opens drilled into `folder` when one is given, else on the Overview.
 */
export function specForKind(
  kind: PaneKind,
  folder: string | null,
  recentCwd: string | undefined,
  repoFolder: () => string | null | undefined,
): PaneSpec {
  switch (kind) {
    case 'terminal':
      return { kind: 'terminal', cwd: folder ?? recentCwd };
    case 'scratch':
      return { kind: 'scratch' };
    case 'files':
      return { kind: 'files', folder: folder ?? recentCwd ?? repoFolder() ?? '' };
    case 'git':
      return { kind: 'git', root: folder ?? recentCwd ?? repoFolder() ?? '' };
    case 'ship':
      return folder ? { kind: 'ship', root: folder } : { kind: 'ship' };
    case 'search':
      return { kind: 'search', root: folder ?? recentCwd ?? repoFolder() ?? '' };
    case 'containers':
      return { kind: 'containers' };
    case 'ports':
      return { kind: 'ports' };
    case 'browser':
      return { kind: 'browser' };
  }
}
