import type { WorktreeCreated, WorktreePlan } from './worktreeApi';
import { planLine } from './worktreeNewModel';

// Pure decisions behind the New worktree dialog and the pane it opens
// (docs/design/git.md section 4.27).

export interface NewDialogState {
  /** The focused pane's folder; null when no pane has one. */
  folder: string | null;
  isGit: boolean;
  branch: string;
  /** The plan for the current branch text, once it resolved. */
  plan: WorktreePlan | null;
  planError: string | null;
  /** A plan request for the current text is debouncing or in flight. */
  planning: boolean;
  /** `worktree_create` is running. */
  creating: boolean;
  createError: string | null;
}

export interface NewDialogStatus {
  /** The line under the branch field. */
  text: string;
  error: boolean;
  canCreate: boolean;
}

export function newDialogStatus(s: NewDialogState): NewDialogStatus {
  if (s.folder === null) return { text: 'The focused pane has no folder to branch from.', error: true, canCreate: false };
  if (!s.isGit) return { text: `${s.folder} is not in a git repo.`, error: true, canCreate: false };
  if (s.createError !== null) return { text: s.createError, error: true, canCreate: !s.creating && s.plan !== null };
  if (s.creating) return { text: 'Fetching and creating the worktree...', error: false, canCreate: false };
  if (s.branch.trim() === '') return { text: 'Type a new branch name.', error: false, canCreate: false };
  if (s.planning) return { text: s.plan ? planLine(s.plan) : 'Checking...', error: false, canCreate: false };
  if (s.planError !== null) return { text: s.planError, error: true, canCreate: false };
  if (s.plan === null) return { text: '', error: false, canCreate: false };
  return { text: planLine(s.plan), error: false, canCreate: true };
}

/** Whether a setup script will run in the new pane, given the trust answer (null when none was asked). */
export function willRunSetup(setup: WorktreeCreated['setup'], approved: boolean | null): boolean {
  if (setup === 'none') return false;
  if (setup === 'trusted') return true;
  return approved === true;
}

/**
 * The profile for the new pane: the typed command (setup.sh, or an agent with a prompt) is bash
 * syntax and bash quoting, so on Windows it runs under Git Bash whatever the default profile is;
 * with nothing to type, or elsewhere, the default (undefined).
 */
export function paneProfile(command: string | null, os: string): string | undefined {
  return command !== null && os === 'windows' ? 'gitBash' : undefined;
}
