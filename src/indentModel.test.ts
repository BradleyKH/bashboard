import { describe, expect, it } from 'vitest';
import { detectIndentUnit } from './indentModel';

describe('detectIndentUnit', () => {
  it('finds a 4-space step', () => {
    const text = 'class A {\n    void B() {\n        C();\n    }\n}\n';
    expect(detectIndentUnit(text)).toBe('    ');
  });

  it('finds a 2-space step', () => {
    const text = 'a:\n  b:\n    c: 1\n  d: 2\n';
    expect(detectIndentUnit(text)).toBe('  ');
  });

  it('picks tabs when most indented lines start with one', () => {
    const text = 'func main() {\n\tif x {\n\t\ty()\n\t}\n}\n';
    expect(detectIndentUnit(text)).toBe('\t');
  });

  it('ignores the 1-space lead of block comment lines', () => {
    const text = '/**\n * Doc.\n */\nfunction f() {\n    return 1;\n}\n';
    expect(detectIndentUnit(text)).toBe('    ');
  });

  it('does not count dedents that close several levels', () => {
    const text = 'a {\n  b {\n    c {\n      d\n}\n';
    expect(detectIndentUnit(text)).toBe('  ');
  });

  it('skips blank and whitespace-only lines', () => {
    const text = 'a {\n    b\n\n        \n    c\n}\n';
    expect(detectIndentUnit(text)).toBe('    ');
  });

  it('falls back to two spaces with nothing indented', () => {
    expect(detectIndentUnit('one\ntwo\n', 'notes.txt')).toBe('  ');
    expect(detectIndentUnit('')).toBe('  ');
  });

  it('falls back to a tab for Makefiles and Go', () => {
    expect(detectIndentUnit('all: build\n', 'C:\\repo\\Makefile')).toBe('\t');
    expect(detectIndentUnit('package main\n', '/repo/main.go')).toBe('\t');
    expect(detectIndentUnit('', '/repo/rules.mk')).toBe('\t');
  });

  it('follows the text over the file type', () => {
    expect(detectIndentUnit('x:\n    y\n', '/repo/Makefile')).toBe('    ');
  });
});
