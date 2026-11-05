import { describe, expect, it } from 'vitest';
import { DEFAULT_ACCENT } from './accent';
import type { HookInstallPreview } from './hookInstall';
import {
  backgroundColorSaves,
  editorChoices,
  effectiveProfile,
  favoritesToAdd,
  MATRIX_ACCENT,
  scrimPresetFor,
  agentHooksFrom,
  setupSteps,
} from './setupModel';

describe('setupSteps', () => {
  const base = { gitBashFound: true, defaultShell: 'gitBash', shellIntegrationStatus: 'installed' as const };

  const noHooks = { agents: [] };
  const claudeMissing = { agent: 'claude' as const, installed: false };
  const claudeIn = { agent: 'claude' as const, installed: true };
  const codexMissing = { agent: 'codex' as const, installed: false };
  const codexUntrusted = { agent: 'codex' as const, installed: true, trust: 'untrusted' as const };
  const withAgents = ['shell', 'editor', 'favorites', 'agents', 'look'];
  const without = ['shell', 'editor', 'favorites', 'look'];

  it('shows the agents step for Claude Code only when its hooks are missing', () => {
    expect(setupSteps({ ...base, agents: [claudeMissing] })).toEqual(withAgents);
    expect(setupSteps({ ...base, agents: [claudeIn] })).toEqual(without);
  });

  it('shows the agents step when any detected agent lacks hooks', () => {
    expect(setupSteps({ ...base, agents: [claudeIn, codexMissing] })).toEqual(withAgents);
    expect(setupSteps({ ...base, agents: [claudeMissing, codexMissing] })).toEqual(withAgents);
  });

  it('skips the step when Codex is installed but not yet trusted, since an install cannot fix that', () => {
    expect(setupSteps({ ...base, agents: [claudeIn, codexUntrusted] })).toEqual(without);
  });

  it('skips the step when no agent is detected', () => {
    expect(setupSteps({ ...base, ...noHooks })).toEqual(without);
  });

  const hooks = noHooks;
  const bash = { ...hooks, gitBashFound: true, defaultShell: 'gitBash' };

  it('puts git first only when Git Bash is not found', () => {
    expect(
      setupSteps({ ...hooks, gitBashFound: false, defaultShell: 'cmd', shellIntegrationStatus: null }),
    ).toEqual(['git', 'shell', 'editor', 'favorites', 'look']);
  });

  it('shows shell integration after shell unless installed or unknown', () => {
    for (const status of ['missing', 'outdated', 'handAdded', 'custom', 'loading'] as const) {
      expect(setupSteps({ ...bash, shellIntegrationStatus: status })).toEqual([
        'shell', 'shellIntegration', 'editor', 'favorites', 'look',
      ]);
    }
    expect(setupSteps({ ...bash, shellIntegrationStatus: null })).toEqual([
      'shell', 'editor', 'favorites', 'look',
    ]);
  });

  it('follows the default shell: PowerShell takes the step, cmd never does', () => {
    for (const shell of ['pwsh', 'powershell']) {
      expect(setupSteps({ ...bash, defaultShell: shell, shellIntegrationStatus: 'missing' })).toContain(
        'shellIntegration',
      );
    }
    expect(setupSteps({ ...bash, defaultShell: 'cmd', shellIntegrationStatus: 'missing' })).not.toContain(
      'shellIntegration',
    );
    expect(setupSteps({ ...bash, defaultShell: null, shellIntegrationStatus: 'missing' })).not.toContain(
      'shellIntegration',
    );
  });

  it('offers PowerShell lines while Git Bash is missing', () => {
    expect(
      setupSteps({ ...hooks, gitBashFound: false, defaultShell: 'pwsh', shellIntegrationStatus: 'missing' }),
    ).toEqual(['git', 'shell', 'shellIntegration', 'editor', 'favorites', 'look']);
  });

  it('hides Git Bash integration while Git Bash is missing', () => {
    expect(
      setupSteps({ ...hooks, gitBashFound: false, defaultShell: 'gitBash', shellIntegrationStatus: 'missing' }),
    ).toEqual(['git', 'shell', 'editor', 'favorites', 'look']);
  });

  it('keeps git and adds shell integration once Git is installed from the wizard', () => {
    expect(
      setupSteps({
        ...hooks,
        gitBashFound: false,
        gitInstalled: true,
        defaultShell: 'gitBash',
        shellIntegrationStatus: 'missing',
      }),
    ).toEqual(['git', 'shell', 'shellIntegration', 'editor', 'favorites', 'look']);
  });
});

describe('agentHooksFrom', () => {
  const preview = (over: Partial<HookInstallPreview>): HookInstallPreview => ({
    settingsPath: '',
    scriptPath: '',
    additions: {},
    alreadyInstalled: false,
    scriptState: 'missing',
    claudeDetected: false,
    bashFound: true,
    ...over,
  });

  it('keeps only detected agents, reading Claude Code from claudeDetected', () => {
    expect(
      agentHooksFrom([
        preview({ claudeDetected: true }),
        preview({ agent: 'codex', detected: true, alreadyInstalled: true, trust: 'untrusted' }),
        preview({ agent: 'copilot', detected: false }),
      ]),
    ).toEqual([
      { agent: 'claude', installed: false, update: false, trust: null },
      { agent: 'codex', installed: true, update: false, trust: 'untrusted' },
    ]);
  });

  it('marks an agent whose only gap is an outdated script as an update', () => {
    const [claude] = agentHooksFrom([preview({ claudeDetected: true, scriptState: 'outdated' })]);
    expect(claude).toMatchObject({ installed: false, update: true });
    const [fresh] = agentHooksFrom([preview({ claudeDetected: true, additions: { Stop: [] } })]);
    expect(fresh).toMatchObject({ installed: false, update: false });
  });

  it('returns nothing when no agent has run', () => {
    expect(agentHooksFrom([preview({}), preview({ agent: 'codex', detected: false })])).toEqual([]);
  });
});

describe('effectiveProfile', () => {
  it('keeps an installed saved profile, else takes the first installed one', () => {
    expect(effectiveProfile('pwsh', ['gitBash', 'pwsh', 'cmd'])).toBe('pwsh');
    expect(effectiveProfile('gitBash', ['pwsh', 'powershell', 'cmd'])).toBe('pwsh');
    expect(effectiveProfile('gitBash', [])).toBeNull();
  });
});

describe('backgroundColorSaves', () => {
  const none = { accent: false };

  it('turns a default accent green for Matrix', () => {
    expect(backgroundColorSaves('matrix', DEFAULT_ACCENT.toUpperCase(), none)).toEqual({
      saves: [[['accentColor'], MATRIX_ACCENT]],
      auto: { accent: true },
    });
  });

  it('leaves an accent the user picked alone', () => {
    expect(backgroundColorSaves('matrix', '#f0a050', none)).toEqual({ saves: [], auto: none });
  });

  it('puts back only what it turned green, and only while still green', () => {
    expect(backgroundColorSaves('lights', MATRIX_ACCENT, { accent: true })).toEqual({
      saves: [[['accentColor'], DEFAULT_ACCENT]],
      auto: none,
    });
    expect(backgroundColorSaves('lights', '#5b9cf0', { accent: true })).toEqual({ saves: [], auto: none });
    expect(backgroundColorSaves('none', MATRIX_ACCENT, none)).toEqual({ saves: [], auto: none });
  });

  it('picks the green preset', () => {
    expect(MATRIX_ACCENT).toBe('#6cc487');
  });
});

describe('favoritesToAdd', () => {
  const existing = [{ label: 'app', path: 'C:/src/app' }];

  it('labels new entries by folder name with no profile', () => {
    expect(favoritesToAdd(['C:/src/web'], [])).toEqual([{ label: 'web', path: 'C:/src/web' }]);
  });

  it('skips paths already favorited, ignoring case and slash differences', () => {
    expect(favoritesToAdd(['c:/src/APP/', 'C:/src/web'], existing)).toEqual([
      { label: 'web', path: 'C:/src/web' },
    ]);
  });

  it('treats backslash and forward slash paths as the same', () => {
    const win = ['C:', 'src', 'app'].join(String.fromCharCode(92));
    expect(favoritesToAdd([win], existing)).toEqual([]);
  });

  it('skips repeats within the checked list', () => {
    expect(favoritesToAdd(['C:/src/web', 'c:/src/web'], [])).toHaveLength(1);
  });

  it('falls back to the path when there is no folder name', () => {
    expect(favoritesToAdd(['/'], [])).toEqual([{ label: '/', path: '/' }]);
  });

  it('returns nothing for nothing checked', () => {
    expect(favoritesToAdd([], existing)).toEqual([]);
  });
});

describe('scrimPresetFor', () => {
  it('matches each preset', () => {
    expect(scrimPresetFor(0)).toBe('none');
    expect(scrimPresetFor(0.25)).toBe('light');
    expect(scrimPresetFor(0.5)).toBe('medium');
  });

  it('gives null between presets', () => {
    expect(scrimPresetFor(0.3)).toBeNull();
    expect(scrimPresetFor(0.9)).toBeNull();
  });
});

describe('editorChoices', () => {
  const core = [
    { id: 'vscode', name: 'VS Code' },
    { id: 'default', name: "The file's default app" },
  ];

  it('passes the core list through unchanged', () => {
    expect(editorChoices(core, 'vscode')).toEqual([
      { value: 'vscode', label: 'VS Code' },
      { value: 'default', label: "The file's default app" },
    ]);
  });

  it('appends the default app when the list lacks it', () => {
    expect(editorChoices([{ id: 'zed', name: 'Zed' }], 'zed')).toEqual([
      { value: 'zed', label: 'Zed' },
      { value: 'default', label: "The file's default app" },
    ]);
    expect(editorChoices([], 'default')).toEqual([
      { value: 'default', label: "The file's default app" },
    ]);
  });

  it('lists a missing saved editor first, as not found', () => {
    expect(editorChoices(core, 'cursor')[0]).toEqual({ value: 'cursor', label: 'cursor (not found)' });
    expect(editorChoices(core, 'mystery')[0]).toEqual({ value: 'mystery', label: 'mystery (not found)' });
    expect(editorChoices(core, 'cursor')).toHaveLength(3);
  });
});
