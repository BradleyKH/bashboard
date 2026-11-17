import { describe, expect, it } from 'vitest';
import { CLI_COMMANDS, CLI_OPTIONS, CLI_SECTIONS, entryFor } from './cliReference';

describe('the bb reference', () => {
  it('covers every command the core dispatches, plus help', () => {
    expect(CLI_COMMANDS.map((c) => c.name)).toEqual(['open', 'edit', 'git', 'search', 'scratch', 'term', 'ship', 'ports', 'containers', 'media', 'browse', 'auth', 'auth', 'ci', 'ci wait', 'ci log', 'ci rerun', 'ci cancel', 'pr size', 'worktree new', 'skill install', 'help']);
    expect(CLI_OPTIONS.map((o) => o.name)).toEqual(['--collapsed', '--tab', '--']);
  });

  it('puts every command in a CLI tab section, and leaves no section empty', () => {
    const sections: readonly string[] = CLI_SECTIONS;
    for (const c of CLI_COMMANDS) expect(sections).toContain(c.section);
    for (const s of CLI_SECTIONS) expect(CLI_COMMANDS.some((c) => c.section === s)).toBe(true);
  });

  it('gives each entry a usage line and examples that use it', () => {
    for (const e of [...CLI_COMMANDS, ...CLI_OPTIONS]) {
      expect(e.usage).toContain(e.name);
      expect(e.examples.length).toBeGreaterThan(0);
      for (const x of e.examples) expect(x).toContain(e.name);
    }
  });

  it('words bb browse for the system browser off Windows', () => {
    const browse = CLI_COMMANDS.find((c) => c.name === 'browse')!;
    expect(entryFor(browse, 'windows')).toBe(browse);
    for (const os of ['linux', 'macos']) {
      const e = entryFor(browse, os);
      expect(e.summary).toBe('Open a localhost address in the system browser');
      expect(e.details).not.toContain('start page');
      expect(e.examples).not.toContain('bb browse');
      expect(e.examples.length).toBeGreaterThan(0);
    }
    const ports = CLI_COMMANDS.find((c) => c.name === 'ports')!;
    expect(entryFor(ports, 'linux')).toBe(ports);
  });
});
