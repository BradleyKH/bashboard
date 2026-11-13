import { describe, expect, it } from 'vitest';
import { bashQuote, planLine, setupCommand } from './worktreeNewModel';
import type { WorktreeCreated, WorktreePlan } from './worktreeApi';

const plan: WorktreePlan = {
  mainRoot: 'C:\\Users\\me\\repos\\app',
  branch: 'feat/x',
  baseRef: 'origin/main',
  baseSha: 'abcdef0123456789',
  shortSha: 'abcdef0',
  path: 'C:\\Users\\me\\repos\\app-feat-x',
  name: 'app-feat-x',
  hint: true,
};

function created(setup: WorktreeCreated['setup'], over: Partial<WorktreePlan> = {}): WorktreeCreated {
  return { plan: { ...plan, ...over }, index: 3, copied: [], warnings: [], setup };
}

const SETUP =
  "BB_ROOT_PATH='C:/Users/me/repos/app' BB_WORKTREE_PATH='C:/Users/me/repos/app-feat-x' " +
  "BB_WORKTREE_NAME='app-feat-x' BB_WORKTREE_INDEX=3 bash -e .bashboard/setup.sh";

describe('bashQuote', () => {
  it('wraps plain text and spaces in single quotes', () => {
    expect(bashQuote('a b')).toBe("'a b'");
  });
  it('escapes embedded single quotes', () => {
    expect(bashQuote("it's")).toBe("'it'\\''s'");
    expect(bashQuote("''")).toBe("''\\'''\\'''");
  });
  it('leaves $, backticks, and backslashes literal', () => {
    expect(bashQuote('$HOME `x` \\n')).toBe("'$HOME `x` \\n'");
  });
  it('quotes the empty string', () => {
    expect(bashQuote('')).toBe("''");
  });
});

describe('setupCommand', () => {
  const agent = { launch: 'claude' };

  it('runs setup then the agent with a quoted prompt', () => {
    expect(setupCommand(created('trusted'), true, agent, "fix it's bug")).toBe(
      `${SETUP} && claude 'fix it'\\''s bug'`,
    );
  });
  it('runs setup then a bare agent when there is no prompt', () => {
    expect(setupCommand(created('trusted'), true, agent, null)).toBe(`${SETUP} && claude`);
  });
  it('runs setup alone without an agent', () => {
    expect(setupCommand(created('needsApproval'), true, null, 'ignored')).toBe(SETUP);
  });
  it('converts Windows paths to forward slashes but keeps POSIX paths', () => {
    const c = created('trusted', { mainRoot: '/home/me/app', path: '/home/me/app-x' });
    expect(setupCommand(c, true, null, null)).toContain(
      "BB_ROOT_PATH='/home/me/app' BB_WORKTREE_PATH='/home/me/app-x'",
    );
  });
  it('quotes paths with spaces and quotes', () => {
    const c = created('trusted', { mainRoot: "C:\\My Repos\\o'neil", name: 'a b' });
    const out = setupCommand(c, true, null, null) ?? '';
    expect(out).toContain("BB_ROOT_PATH='C:/My Repos/o'\\''neil'");
    expect(out).toContain("BB_WORKTREE_NAME='a b'");
  });
  it('keeps backslashes and $ in the prompt literal', () => {
    expect(setupCommand(created('trusted'), true, agent, 'a\\b $x')).toBe(`${SETUP} && claude 'a\\b $x'`);
  });
  it('without a setup script gives just the agent command', () => {
    expect(setupCommand(created('none'), true, agent, 'hi')).toBe("claude 'hi'");
    expect(setupCommand(created('none'), false, agent, null)).toBe('claude');
  });
  it('without a setup script or agent gives null', () => {
    expect(setupCommand(created('none'), true, null, null)).toBeNull();
  });
  it('declined setup gives null, agent included', () => {
    expect(setupCommand(created('needsApproval'), false, agent, 'hi')).toBeNull();
    expect(setupCommand(created('trusted'), false, null, null)).toBeNull();
  });
});

describe('planLine', () => {
  it('includes the hint for the default base', () => {
    expect(planLine(plan)).toBe(
      'Branching feat/x from origin/main (abcdef0); pass --from HEAD to branch from your current commit',
    );
  });
  it('omits the hint when --from was given', () => {
    expect(planLine({ ...plan, hint: false, baseRef: 'HEAD', shortSha: '1234567' })).toBe(
      'Branching feat/x from HEAD (1234567)',
    );
  });
});
