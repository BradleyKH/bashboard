import { describe, expect, it } from 'vitest';
import { toUsageWindows } from './usageModel';

describe('toUsageWindows', () => {
  it('converts reset seconds to epoch ms and names the agent from the table', () => {
    expect(toUsageWindows([{ agent: 'claude', label: '5-hour', usedPercent: 84, resetsAt: 1999999999 }])).toEqual([
      { agent: 'claude', agentName: 'Claude Code', label: '5-hour', percent: 84, resetsAt: 1999999999000 },
    ]);
  });

  it('keeps a missing reset time null', () => {
    const [w] = toUsageWindows([{ agent: 'codex', label: 'weekly', usedPercent: 12.5, resetsAt: null }]);
    expect(w.resetsAt).toBeNull();
    expect(w.percent).toBe(12.5);
  });

  it('falls back to the id for an agent the table lacks, and keeps order', () => {
    const out = toUsageWindows([
      { agent: 'mystery', label: 'weekly', usedPercent: 1, resetsAt: 0 },
      { agent: 'codex', label: '5-hour', usedPercent: 2, resetsAt: null },
    ]);
    expect(out.map((w) => w.agentName)).toEqual(['mystery', 'Codex']);
    expect(out[0].resetsAt).toBe(0);
  });
});
