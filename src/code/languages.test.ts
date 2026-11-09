import { describe, expect, it } from 'vitest';
import { LANGUAGE_IDS, languageIdFor, languageIdForFence, loadLanguage, type LanguageId } from './languages';

const CASES: Record<LanguageId, string[]> = {
  html: ['a.html', 'a.htm'],
  css: ['a.css'],
  scss: ['a.scss'],
  sass: ['a.sass'],
  less: ['a.less'],
  javascript: ['a.js', 'a.mjs', 'a.cjs'],
  typescript: ['a.ts', 'a.mts', 'a.cts'],
  jsx: ['a.jsx'],
  tsx: ['a.tsx'],
  json: ['a.json', 'a.jsonc', 'a.json5'],
  csharp: ['a.cs', 'a.csx'],
  python: ['a.py', 'a.pyi'],
  markdown: ['a.md', 'a.markdown'],
  yaml: ['a.yml', 'a.yaml'],
  rust: ['a.rs'],
  sql: ['a.sql'],
  xml: ['a.xml', 'a.csproj', 'a.props', 'a.targets', 'a.xaml', 'a.svg'],
  shell: ['a.sh', 'a.bash', '.bashrc', '.bash_profile', '.profile'],
  powershell: ['a.ps1', 'a.psm1', 'a.psd1'],
  toml: ['a.toml'],
  dockerfile: ['Dockerfile', 'prod.dockerfile'],
};

describe('languageIdFor', () => {
  for (const id of LANGUAGE_IDS) {
    it(`resolves every ${id} name`, () => {
      for (const name of CASES[id]) expect(languageIdFor(name), name).toBe(id);
    });
  }

  it('ignores case and folders', () => {
    expect(languageIdFor('README.MD')).toBe('markdown');
    expect(languageIdFor('dockerfile')).toBe('dockerfile');
    expect(languageIdFor('C:\\src\\App.TSX')).toBe('tsx');
    expect(languageIdFor('/home/me/.BASHRC')).toBe('shell');
  });

  it('returns null for names with no language', () => {
    for (const name of ['notes.txt', 'Makefile', '.gitignore', 'photo.png', 'archive', 'a.', '.md.bak', '', 'sh']) {
      expect(languageIdFor(name), name).toBeNull();
    }
  });
});

describe('languageIdForFence', () => {
  it('resolves names and aliases, ignoring case', () => {
    const cases: [string, LanguageId][] = [
      ['ts', 'typescript'],
      ['TypeScript', 'typescript'],
      ['tsx', 'tsx'],
      ['js', 'javascript'],
      ['javascript', 'javascript'],
      ['cs', 'csharp'],
      ['csharp', 'csharp'],
      ['C#', 'csharp'],
      ['py', 'python'],
      ['python', 'python'],
      ['sh', 'shell'],
      ['bash', 'shell'],
      ['ps1', 'powershell'],
      ['pwsh', 'powershell'],
      ['PowerShell', 'powershell'],
      ['yml', 'yaml'],
      ['rs', 'rust'],
      ['rust', 'rust'],
      ['html', 'html'],
      ['json', 'json'],
      ['md', 'markdown'],
      ['toml', 'toml'],
      ['dockerfile', 'dockerfile'],
      ['sql', 'sql'],
      ['xml', 'xml'],
      ['css', 'css'],
      ['scss', 'scss'],
    ];
    for (const [info, id] of cases) expect(languageIdForFence(info), info).toBe(id);
  });

  it('uses the first word of the info string', () => {
    expect(languageIdForFence('ts title="a.ts"')).toBe('typescript');
    expect(languageIdForFence('  rust ')).toBe('rust');
  });

  it('is null for an unknown or missing info string', () => {
    for (const info of ['', '  ', 'klingon', 'text']) expect(languageIdForFence(info), info).toBeNull();
  });
});

describe('loadLanguage', () => {
  it('loads every language and caches the result per id', async () => {
    for (const id of LANGUAGE_IDS) {
      const support = await loadLanguage(id);
      expect(support.language, id).toBeDefined();
      expect(loadLanguage(id), id).toBe(loadLanguage(id));
    }
  });
});
