import { describe, expect, it } from 'vitest';
import type { MenuItem } from './contextMenuModel';
import { launchMenuItems, launchMenuOptions, launchOptions, ollamaLaunchCommand } from './launchModel';

const GIT = { isGit: true, containers: true };
const NO_GIT = { isGit: false, containers: true };

describe('launchOptions', () => {
  it('lists every option in a git repo, in display order', () => {
    expect(launchOptions(true).map((o) => o.kind)).toEqual(['terminal', 'files', 'git', 'scratch', 'search', 'ship']);
  });

  it('drops Git and Ship outside a git repo', () => {
    expect(launchOptions(false).map((o) => o.kind)).toEqual(['terminal', 'files', 'scratch', 'search']);
  });

});

describe('launchMenuOptions', () => {
  it('adds Containers and Ports to the row options, in kind menu order', () => {
    expect(launchMenuOptions(GIT).map((o) => o.kind)).toEqual([
      'terminal', 'containers', 'files', 'git', 'browser', 'ports', 'scratch', 'search', 'ship',
    ]);
  });

  it('keeps Containers and Ports outside a git repo', () => {
    expect(launchMenuOptions(NO_GIT).map((o) => o.kind)).toEqual(['terminal', 'containers', 'files', 'browser', 'ports', 'scratch', 'search']);
  });

  it('drops Containers while no container engine is installed', () => {
    expect(launchMenuOptions({ isGit: true, containers: false }).map((o) => o.kind)).not.toContain('containers');
  });

  it('drops the Local Browser on an OS without it', () => {
    expect(launchMenuOptions({ ...GIT, localBrowser: false }).map((o) => o.kind)).not.toContain('browser');
  });

  it('gives each option its own menu letter', () => {
    const keys = launchMenuOptions(GIT).map((o) => o.key);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe('launchMenuItems', () => {
  it('launches and previews the kind of the item, with its letter', () => {
    const launched: string[] = [];
    const previewed: string[] = [];
    const items = launchMenuItems(NO_GIT, (k) => launched.push(k), (k) => previewed.push(k));
    const files = items.find((i): i is MenuItem => i.kind === 'item' && i.label === 'Files')!;
    expect(files.key).toBe('f');
    files.onHighlight?.();
    files.run();
    expect(previewed).toEqual(['files']);
    expect(launched).toEqual(['files']);
  });
});

describe('ollamaLaunchCommand', () => {
  it('names each agent and the model', () => {
    expect(ollamaLaunchCommand('claude', 'gemma4:e2b')).toBe('ollama launch claude --model gemma4:e2b');
    expect(ollamaLaunchCommand('codex', 'gpt-oss:20b')).toBe('ollama launch codex --model gpt-oss:20b');
    expect(ollamaLaunchCommand('copilot', 'library/qwen3:8b')).toBe('ollama launch copilot --model library/qwen3:8b');
  });

  it('refuses a model name that is unsafe to type', () => {
    expect(ollamaLaunchCommand('claude', 'x; rm -rf ~')).toBeNull();
    expect(ollamaLaunchCommand('claude', '')).toBeNull();
  });
});

describe('launchMenuItems local models', () => {
  const noop = () => {};
  const labels = (e: ReturnType<typeof launchMenuItems>) => e.map((x) => ('label' in x ? x.label : ''));

  it('adds nothing without local state or without models', () => {
    expect(launchMenuItems(GIT, noop, noop)).toHaveLength(9);
    expect(launchMenuItems(GIT, noop, noop, { agents: ['claude'], models: [], onRun: noop })).toHaveLength(9);
    expect(launchMenuItems(GIT, noop, noop, { agents: [], models: ['m'], onRun: noop })).toHaveLength(9);
  });

  it('adds one submenu per agent listing the models, running the command', () => {
    const ran: string[] = [];
    const entries = launchMenuItems(NO_GIT, noop, noop, {
      agents: ['claude', 'codex', 'copilot'],
      models: ['a:1', 'bad name'],
      onRun: (c) => ran.push(c),
    });
    expect(labels(entries).slice(-3)).toEqual(['Claude Code on a local model', 'Codex on a local model', 'Copilot on a local model']);
    const codex = entries.find((e) => e.kind === 'submenu' && e.label.startsWith('Codex'))!;
    if (codex.kind !== 'submenu') throw new Error('expected submenu');
    expect(codex.items.map((i) => ('label' in i ? i.label : ''))).toEqual(['a:1']);
    const first = codex.items[0];
    if (first.kind === 'item') first.run();
    expect(ran).toEqual(['ollama launch codex --model a:1']);
  });
});
