import { describe, expect, it } from 'vitest';
import table from './agents.json';
import {
  AGENT_IDS,
  AGENT_USAGE_SOURCES,
  agentForStatusApp,
  agentName,
  isAgentId,
  isPreviewAgent,
  launchCommand,
  platformCommand,
  resumeCommandFor,
} from './agentTable';

describe('agent table', () => {
  it('lists the JSON ids in order', () => {
    expect(table.map((r) => r.id)).toEqual([...AGENT_IDS]);
    expect([...AGENT_IDS]).toEqual(['claude', 'codex', 'copilot']);
  });

  it('gives every row a name, launch command, and resume command', () => {
    for (const row of table) {
      expect(row.name).not.toBe('');
      expect(row.launch).not.toBe('');
      expect(row.resume.command).not.toBe('');
    }
  });

  it('gives every row a known usage source', () => {
    for (const row of table) {
      expect(AGENT_USAGE_SOURCES).toContain(row.usage);
    }
    expect(table.map((r) => r.usage)).toEqual(['statusLine', 'rollout', 'none']);
  });

  it('names agents and flags previews', () => {
    expect(agentName('claude')).toBe('Claude Code');
    expect(isPreviewAgent('claude')).toBe(false);
    expect(isPreviewAgent('codex')).toBe(true);
    expect(isAgentId('copilot')).toBe(true);
    expect(isAgentId('gemini')).toBe(false);
    expect(isAgentId(3)).toBe(false);
  });

  it('builds resume commands', () => {
    expect(resumeCommandFor('claude', 's1', {}, 'windows')).toBe('claude --resume s1');
    expect(resumeCommandFor('claude', 's1', { mode: 'plan' }, 'windows')).toBe(
      'claude --resume s1 --permission-mode plan',
    );
    expect(resumeCommandFor('codex', 's1', {}, 'posix')).toBe('codex resume s1');
    expect(resumeCommandFor('copilot', 's1', {}, 'posix')).toBe('copilot --resume s1');
    expect(resumeCommandFor('copilot', 's1', { model: 'gpt-5' }, 'posix')).toBe(
      'copilot --resume s1 --model gpt-5',
    );
  });

  it('ignores a mode or model the agent has no argument for', () => {
    expect(resumeCommandFor('codex', 's1', { mode: 'plan' }, 'windows')).toBe('codex resume s1');
    expect(resumeCommandFor('claude', 's1', { model: 'opus' }, 'windows')).toBe('claude --resume s1');
  });

  it('resolves launch commands', () => {
    expect(launchCommand('codex', 'windows')).toBe('codex');
  });

  it('resolves the per-platform command form', () => {
    const cmd = { windows: 'tool.cmd', posix: 'tool' };
    expect(platformCommand(cmd, 'windows')).toBe('tool.cmd');
    expect(platformCommand(cmd, 'posix')).toBe('tool');
    expect(platformCommand('same', 'windows')).toBe('same');
  });

  it('maps a status app to its agent', () => {
    expect(agentForStatusApp('claude-code')).toBe('claude');
    expect(agentForStatusApp('codex')).toBe('codex');
    expect(agentForStatusApp('nope')).toBeNull();
  });
});
