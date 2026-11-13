import type { WorktreeCreated, WorktreePlan } from './worktreeApi';

// The text typed into a new worktree's pane (docs/design/git.md section 4.27).

/** Single-quotes `s` for bash; an embedded quote closes, escapes, and reopens the string. */
export function bashQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** Git Bash accepts forward slashes where Windows paths use backslashes. */
function bashPath(p: string): string {
  return bashQuote(p.replace(/\\/g, '/'));
}

/**
 * The command line to type into the new pane, or null when there is nothing to run.
 * Setup runs first and the agent only starts if it succeeds. Declining a setup script that
 * exists (`runSetup` false while `setup` is not 'none') runs nothing, agent included, since
 * setup did not succeed.
 */
export function setupCommand(
  created: WorktreeCreated,
  runSetup: boolean,
  agent: { launch: string } | null,
  prompt: string | null,
): string | null {
  const hasSetup = created.setup !== 'none';
  if (hasSetup && !runSetup) return null;
  const agentCmd = agent ? (prompt ? `${agent.launch} ${bashQuote(prompt)}` : agent.launch) : null;
  if (!hasSetup) return agentCmd;
  const { plan } = created;
  const setup = [
    `BB_ROOT_PATH=${bashPath(plan.mainRoot)}`,
    `BB_WORKTREE_PATH=${bashPath(plan.path)}`,
    `BB_WORKTREE_NAME=${bashQuote(plan.name)}`,
    `BB_WORKTREE_INDEX=${created.index}`,
    'bash -e .bashboard/setup.sh',
  ].join(' ');
  return agentCmd ? `${setup} && ${agentCmd}` : setup;
}

/** The base is always shown before anything changes; the hint appears only for the default base. */
export function planLine(plan: WorktreePlan): string {
  const line = `Branching ${plan.branch} from ${plan.baseRef} (${plan.shortSha})`;
  return plan.hint ? `${line}; pass --from HEAD to branch from your current commit` : line;
}
