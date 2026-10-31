import type { ConfirmDialog } from './confirmDialog';
import { externalSessions, type PaneCardInput } from './dashboardModel';
import type { Session } from './sessions';
import { gitWorktreeRemove, type Worktree } from './worktreeApi';
import { deleteBranchChoice, removalBlockers } from './worktreeModel';

export interface WorktreeDeleteDeps {
  panes(): PaneCardInput[];
  sessions(): Session[];
  confirm: ConfirmDialog;
}

function folderName(p: string): string {
  const parts = p.split(/[\\/]+/).filter(Boolean);
  return parts[parts.length - 1] ?? p;
}

/** Resolves to a message to show inline, or null when the worktree was removed or the user cancelled. */
export async function deleteWorktree(
  root: string,
  w: Worktree,
  deps: WorktreeDeleteDeps,
): Promise<string | null> {
  if (!w.prunable) {
    const panes = deps.panes();
    const blocked = removalBlockers(w.path, panes, externalSessions(deps.sessions(), panes));
    if (blocked) return blocked;
  }

  const choice = deleteBranchChoice(w);
  const body = [
    `Delete the worktree folder ${folderName(w.path)} (${w.branch ? `branch ${w.branch}` : `detached at ${(w.head ?? '').slice(0, 7)}`})?`,
  ];
  if (w.prunable) {
    body.push(
      'Its folder is missing. This runs `git worktree prune`, which clears the records of every worktree whose folder is missing.',
    );
  }
  const result = await deps.confirm.openWithCheckbox({
    title: 'Delete worktree',
    body,
    confirmLabel: 'Delete',
    checkbox: choice.show
      ? {
          label: `Also delete branch ${w.branch}`,
          checked: choice.checked,
          disabled: !choice.enabled,
          note: choice.note,
        }
      : undefined,
  });
  if (!result.confirmed) return null;

  try {
    const removed = await gitWorktreeRemove(root, w.path, result.checked && choice.enabled);
    if (removed.branchError) {
      return `The worktree was removed, but branch ${w.branch} was kept: ${removed.branchError}`;
    }
    return null;
  } catch (e) {
    return String(e);
  }
}
