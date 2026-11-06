import type { PaneCardInput } from './dashboardModel';
import { samePath } from './favorites';
import { gitFetchRoots } from './gitApi';

/**
 * Folders of the open Git panes, one per repo, in a stable order (docs/design/git.md section 3.9).
 */
export function gitRootsOf(panes: readonly PaneCardInput[]): string[] {
  const roots: string[] = [];
  for (const p of panes) {
    if (p.kind !== 'git' || p.folder === null) continue;
    const folder = p.folder;
    if (!roots.some((r) => samePath(r, folder))) roots.push(folder);
  }
  return roots.sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
}

let lastSent: string | null = null;

/** Tells the core which repos have a Git pane open, only when the set changed. */
export function syncGitFetchRoots(panes: readonly PaneCardInput[]): void {
  const roots = gitRootsOf(panes);
  const key = roots.join('\n');
  if (key === lastSent) return;
  lastSent = key;
  // Plain `pnpm dev` has no core to answer.
  gitFetchRoots(roots).catch(() => {});
}
