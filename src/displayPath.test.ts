import { describe, expect, it } from 'vitest';
import { displayPath } from './displayPath';

const HOME = 'C:\\Users\\my-username';

describe('displayPath', () => {
  it('abbreviates the home folder to ~', () => {
    expect(displayPath('C:\\Users\\my-username\\source\\repos\\bashboard', HOME)).toBe('~\\source\\repos\\bashboard');
    expect(displayPath('C:\\Users\\my-username\\Dropbox', HOME)).toBe('~\\Dropbox');
  });

  it('shows the home folder itself as ~', () => {
    expect(displayPath('C:\\Users\\my-username', HOME)).toBe('~');
    expect(displayPath('C:\\Users\\my-username\\', HOME)).toBe('~');
  });

  it('ignores case, slash style, and a trailing slash on home', () => {
    expect(displayPath('c:/users/MY-USERNAME/source', HOME)).toBe('~/source');
    expect(displayPath('C:\\Users\\my-username\\source', 'C:\\Users\\my-username\\')).toBe('~\\source');
  });

  it('leaves a sibling folder that merely shares the prefix', () => {
    expect(displayPath('C:\\Users\\my-username2\\x', HOME)).toBe('C:\\Users\\my-username2\\x');
  });

  it('leaves paths outside home, and everything when home is unknown', () => {
    expect(displayPath('D:\\work', HOME)).toBe('D:\\work');
    expect(displayPath('C:\\Users', HOME)).toBe('C:\\Users');
    expect(displayPath('C:\\Users\\my-username\\x', null)).toBe('C:\\Users\\my-username\\x');
  });
});
