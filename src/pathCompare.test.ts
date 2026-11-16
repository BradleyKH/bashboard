import { describe, expect, it } from 'vitest';
import { foldsCase, nameKey, pathKey, sameOrInside, samePath } from './pathCompare';

describe('foldsCase', () => {
  it('folds on Windows and macOS, not on Linux', () => {
    expect(foldsCase('windows')).toBe(true);
    expect(foldsCase('macos')).toBe(true);
    expect(foldsCase('linux')).toBe(false);
  });
});

describe('pathKey', () => {
  it('evens out separators and trailing slashes on every OS', () => {
    expect(pathKey('C:\\Src\\App\\', 'windows')).toBe('c:/src/app');
    expect(pathKey('/home/me//Src/', 'linux')).toBe('/home/me/Src');
    expect(pathKey('/Users/me/Src', 'macos')).toBe('/users/me/src');
  });
});

describe('samePath', () => {
  it('ignores case on Windows and macOS', () => {
    expect(samePath('C:\\src\\app', 'c:/SRC/App/', 'windows')).toBe(true);
    expect(samePath('/Users/me/App', '/users/me/app', 'macos')).toBe(true);
  });

  it('compares case exactly on Linux', () => {
    expect(samePath('/home/me/App', '/home/me/app', 'linux')).toBe(false);
    expect(samePath('/home/me/app/', '/home/me//app', 'linux')).toBe(true);
  });
});

describe('sameOrInside', () => {
  it('matches the folder and paths below it', () => {
    expect(sameOrInside('/home/me/app/src', '/home/me/app', 'linux')).toBe(true);
    expect(sameOrInside('/home/me/App/src', '/home/me/app', 'linux')).toBe(false);
    expect(sameOrInside('/home/me/App/src', '/home/me/app', 'macos')).toBe(true);
    expect(sameOrInside('/home/me/application', '/home/me/app', 'linux')).toBe(false);
    expect(sameOrInside('/etc', '/', 'linux')).toBe(true);
  });
});

describe('nameKey', () => {
  it('folds names only where the OS does', () => {
    expect(nameKey('README.md', 'windows')).toBe('readme.md');
    expect(nameKey('README.md', 'linux')).toBe('README.md');
  });
});
