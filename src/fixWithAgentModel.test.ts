import { describe, expect, it } from 'vitest';
import { CONTAINER_LOG_LINES, containerFixPrompt, pickAgentPane, type AgentTerminal } from './fixWithAgentModel';

function pane(over: Partial<AgentTerminal> & { paneId: string }): AgentTerminal {
  return { folder: 'C:\\src\\app', agent: true, status: 'idle', recency: 0, ...over };
}

describe('pickAgentPane', () => {
  it('takes the most recently focused ready agent in the repo', () => {
    const panes = [pane({ paneId: 'p1', recency: 3 }), pane({ paneId: 'p2', recency: 1, status: 'done' }), pane({ paneId: 'p3', recency: null })];
    expect(pickAgentPane(panes, 'C:\\src\\app')).toBe('p2');
  });

  it('counts a pane in a subfolder, ignoring case and slash style', () => {
    expect(pickAgentPane([pane({ paneId: 'p1', folder: 'c:/SRC/app/web' })], 'C:\\src\\app\\')).toBe('p1');
  });

  it('skips busy, plain, and out-of-repo terminals', () => {
    const panes = [
      pane({ paneId: 'working', status: 'working' }),
      pane({ paneId: 'waiting', status: 'waiting' }),
      pane({ paneId: 'failed', status: 'failed' }),
      pane({ paneId: 'shell', agent: false }),
      pane({ paneId: 'sibling', folder: 'C:\\src\\app2' }),
      pane({ paneId: 'unknown', folder: null }),
    ];
    expect(pickAgentPane(panes, 'C:\\src\\app')).toBeNull();
  });

  it('falls back to a never-focused pane when it is the only one', () => {
    expect(pickAgentPane([pane({ paneId: 'p1', recency: null })], 'C:\\src\\app')).toBe('p1');
  });
});

describe('containerFixPrompt', () => {
  const ctr = { engine: 'docker' as const, name: 'app-web-1', image: 'node:22', project: 'app', service: 'web' };

  it('names the container and its compose service, then asks for a fix', () => {
    const text = containerFixPrompt(ctr, 'listening\nError: boom\n');
    expect(text).toContain('docker container app-web-1 (image node:22)');
    expect(text).toContain('web service of the compose project app');
    expect(text).toContain('Its log:\n\n```\nlistening\nError: boom\n```');
    expect(text.endsWith('Find the cause in this repo and fix it.')).toBe(true);
  });

  it('keeps only the last lines of a long log', () => {
    const log = Array.from({ length: 400 }, (_, i) => `line ${i}`).join('\n');
    const text = containerFixPrompt(ctr, log);
    expect(text).toContain(`The last ${CONTAINER_LOG_LINES} lines of its log:`);
    expect(text).toContain('line 399');
    expect(text).toContain(`line ${400 - CONTAINER_LOG_LINES}\n`);
    expect(text).not.toContain(`line ${399 - CONTAINER_LOG_LINES}\n`);
  });

  it('leaves out the compose line for a plain container and says when the log is empty', () => {
    const text = containerFixPrompt({ ...ctr, project: null, service: null }, '');
    expect(text).not.toContain('compose');
    expect(text).toContain('Its log is empty.');
  });
});
