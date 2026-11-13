// Opens the pane for a worktree just created by `bb worktree new` or the palette, asking about
// the setup script first when the repo has not approved it (docs/design/git.md section 4.27).
import { isAgentId, launchCommand, type AgentId } from './agentTable';
import { platformOs } from './platform';
import { showToast } from './toast';
import type { WorktreeCreated, WorktreeCreatedEvent } from './worktreeApi';
import { paneProfile, willRunSetup } from './worktreeFlowModel';
import { setupCommand } from './worktreeNewModel';
import { WorktreeTrustDialog } from './worktreeTrustDialog';
import type { Workspace } from './workspace';

export type WorktreeFlowTarget = Pick<
  Workspace,
  'terminalForPty' | 'anchorOn' | 'openTerminal' | 'openTerminalWithCommand'
>;

export interface NewWorktreeRequest {
  created: WorktreeCreated;
  agent: AgentId | null;
  prompt: string | null;
  /** The pane the new one splits from; null splits the focused pane. */
  anchorPaneId: string | null;
}

const trustDialog = new WorktreeTrustDialog();
// One trust question at a time: a second worktree created while the first dialog is up waits.
let queue: Promise<void> = Promise.resolve();

export function openNewWorktree(target: WorktreeFlowTarget, req: NewWorktreeRequest): Promise<void> {
  const next = queue.then(() => run(target, req));
  queue = next.catch((e: unknown) => console.warn('new worktree pane failed:', e));
  return next;
}

/** `worktree://created`: the pane opens beside the one that ran `bb`. */
export function onWorktreeCreatedEvent(target: WorktreeFlowTarget, ev: WorktreeCreatedEvent): void {
  const anchorPaneId = target.terminalForPty(ev.ptyId);
  if (anchorPaneId === null) console.warn(`bb worktree: no pane for pty ${ev.ptyId}; splitting the focused pane`);
  // The core validates the id; anything else is dropped rather than typed into a shell.
  const agent = ev.agent !== null && isAgentId(ev.agent) ? ev.agent : null;
  void openNewWorktree(target, { created: ev.created, agent, prompt: ev.prompt, anchorPaneId });
}

async function run(target: WorktreeFlowTarget, req: NewWorktreeRequest): Promise<void> {
  const { created } = req;
  const approved =
    created.setup === 'needsApproval'
      ? await trustDialog.open({ mainRoot: created.plan.mainRoot, worktreePath: created.plan.path })
      : null;
  const runSetup = willRunSetup(created.setup, approved);
  if (created.setup === 'needsApproval' && !runSetup) {
    showToast(`Setup did not run in ${created.plan.name}${req.agent ? ', so the agent did not start' : ''}`);
  }
  const os = platformOs();
  const agent = req.agent ? { launch: launchCommand(req.agent, os === 'windows' ? 'windows' : 'posix') } : null;
  const command = setupCommand(created, runSetup, agent, req.prompt);
  const opts = { profile: paneProfile(command, os) };
  // Anchored after the dialog, since focus may have moved while it was up.
  if (req.anchorPaneId !== null) target.anchorOn(req.anchorPaneId);
  if (command === null) target.openTerminal(created.plan.path, opts);
  else target.openTerminalWithCommand(created.plan.path, command, opts);
}
