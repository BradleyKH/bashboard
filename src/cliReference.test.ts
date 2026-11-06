import { describe, expect, it } from 'vitest';
import { CLI_COMMANDS, CLI_OPTIONS } from './cliReference';

describe('the bb reference', () => {
  it('covers every command the core dispatches, plus help', () => {
    expect(CLI_COMMANDS.map((c) => c.name)).toEqual(['open', 'edit', 'git', 'search', 'scratch', 'auth', 'auth', 'help']);
    expect(CLI_OPTIONS.map((o) => o.name)).toEqual(['--collapsed']);
  });

  it('gives each entry a usage line and examples that use it', () => {
    for (const e of [...CLI_COMMANDS, ...CLI_OPTIONS]) {
      expect(e.usage).toContain(e.name);
      expect(e.examples.length).toBeGreaterThan(0);
      for (const x of e.examples) expect(x).toContain(e.name);
    }
  });
});
