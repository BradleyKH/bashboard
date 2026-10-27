import { beforeEach, describe, expect, it } from 'vitest';
import { noteShellFallback, resetShellFallbackForTests } from './shellFallback';

describe('noteShellFallback', () => {
  beforeEach(() => resetShellFallbackForTests());

  it('names both shells', () => {
    const seen: string[] = [];
    noteShellFallback('gitBash', 'pwsh', (m) => seen.push(m));
    expect(seen).toEqual(['Git Bash is not installed; using PowerShell 7 instead']);
  });

  it('toasts once per missing shell', () => {
    const seen: string[] = [];
    const toast = (m: string) => seen.push(m);
    noteShellFallback('gitBash', 'pwsh', toast);
    noteShellFallback('gitBash', 'pwsh', toast);
    noteShellFallback('pwsh', 'cmd', toast);
    expect(seen).toHaveLength(2);
  });
});
