import { describe, expect, it } from 'vitest';
import { fenceLanguage } from './fenceColors';

describe('fenceLanguage', () => {
  it('reads the language from markdown-it fence classes', () => {
    expect(fenceLanguage('language-ts')).toBe('typescript');
    expect(fenceLanguage('language-csharp')).toBe('csharp');
    expect(fenceLanguage('language-c#')).toBe('csharp');
    expect(fenceLanguage('other language-PY')).toBe('python');
  });

  it('is null for unknown, missing, or partial classes', () => {
    expect(fenceLanguage('language-klingon')).toBeNull();
    expect(fenceLanguage('')).toBeNull();
    expect(fenceLanguage('xlanguage-ts')).toBeNull();
  });
});
