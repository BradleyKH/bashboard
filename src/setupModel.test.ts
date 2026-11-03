import { describe, expect, it } from 'vitest';
import { DEFAULT_ACCENT } from './accent';
import {
  backgroundColorSaves,
  editorChoices,
  effectiveProfile,
  favoritesToAdd,
  MATRIX_ACCENT,
  scrimPresetFor,
  setupSteps,
} from './setupModel';

describe('setupSteps', () => {
  const base = { gitBashFound: true, defaultShell: 'gitBash', shellIntegrationStatus: 'installed' as const };

  it('includes claude only when detected and not installed', () => {
    expect(setupSteps({ ...base, claudeDetected: true, hooksInstalled: false })).toEqual([
      'shell', 'editor', 'favorites', 'claude', 'look',
    ]);
    for (const opts of [
      { claudeDetected: true, hooksInstalled: true },
      { claudeDetected: false, hooksInstalled: false },
      { claudeDetected: false, hooksInstalled: true },
    ]) {
      expect(setupSteps({ ...base, ...opts })).toEqual(['shell', 'editor', 'favorites', 'look']);
    }
  });

  const hooks = { claudeDetected: false, hooksInstalled: false };
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
