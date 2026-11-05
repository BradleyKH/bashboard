import type { AgentId } from './savedWorkspace';

export const AGENT_NAMES: Record<AgentId, string> = {
  claude: 'Claude Code',
  codex: 'Codex',
  copilot: 'Copilot',
};

export function agentName(agent: AgentId): string {
  return AGENT_NAMES[agent];
}

/** Codex and Copilot support is a preview; Claude Code is the tested path. */
export function isPreviewAgent(agent: AgentId): boolean {
  return agent !== 'claude';
}
