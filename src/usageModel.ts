import { isAgentId, agentName } from './agentTable';
import type { UsageWindow } from './needsYouModel';

/** One window as `usage_snapshot` and `usage://changed` carry it (docs/design/sessions.md section 3.28). */
export interface UsageWindowReport {
  agent: string;
  label: string;
  usedPercent: number;
  /** Seconds since the epoch, or null when the agent does not say. */
  resetsAt: number | null;
}

/** The store's windows: reset times become epoch ms, and an id the table does not know shows as itself. */
export function toUsageWindows(reports: readonly UsageWindowReport[]): UsageWindow[] {
  return reports.map((r) => ({
    agent: r.agent,
    agentName: isAgentId(r.agent) ? agentName(r.agent) : r.agent,
    label: r.label,
    percent: r.usedPercent,
    resetsAt: r.resetsAt === null ? null : r.resetsAt * 1000,
  }));
}
