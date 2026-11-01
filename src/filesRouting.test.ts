import { describe, expect, it } from 'vitest';
import { insertPathText, pathInsertText, pathProfileFor, pinTarget, routeFilesRequest } from './filesRouting';

describe('routeFilesRequest', () => {
  const panes = [
    { paneId: 'p1', root: 'C:\\r\\app', folder: 'C:\\r\\app\\src' },
    { paneId: 'p2', root: 'C:\\r\\other', folder: 'C:\\r\\other' },
    { paneId: 'p3', root: 'c:/r/app', folder: 'C:\\r\\app\\docs' },
  ];

  it('reuses a pane for the same repo, ignoring case and separators', () => {
    expect(routeFilesRequest(panes, { root: 'C:/R/APP', folder: 'C:\\r\\app\\x' })).toEqual({ reuse: 'p1' });
  });

  it('prefers the pane already in the requested folder', () => {
    expect(routeFilesRequest(panes, { root: 'C:\\r\\app', folder: 'C:\\r\\app\\docs' })).toEqual({ reuse: 'p3' });
  });

  it('opens a new pane when none shows the repo', () => {
    expect(routeFilesRequest(panes, { root: 'C:\\r\\third', folder: 'C:\\r\\third' })).toEqual({ open: true });
    expect(routeFilesRequest([], { root: 'C:\\r', folder: 'C:\\r' })).toEqual({ open: true });
  });
});

describe('pinTarget', () => {
  it('shows a folder pin as itself', () => {
    expect(pinTarget('C:\\r', 'C:\\r\\docs', true)).toEqual({ folder: 'C:\\r\\docs' });
  });

  it('shows a file pin in its folder and selects it', () => {
    expect(pinTarget('C:\\r', 'C:\\r\\docs\\todo.md', false)).toEqual({
      folder: 'C:\\r\\docs',
      select: 'C:\\r\\docs\\todo.md',
    });
    expect(pinTarget('/r', '/r/todo.md', false)).toEqual({ folder: '/r', select: '/r/todo.md' });
  });

  it('handles a file at a drive root and outside the repo', () => {
    expect(pinTarget('C:\\r', 'D:\\todo.md', false).folder).toBe('D:\\');
    expect(pinTarget('C:\\r', 'D:\\notes\\a.md', false).folder).toBe('D:\\notes');
  });
});

describe('insertPathText', () => {
  it('gives a forward-slash relative path inside the repo', () => {
    expect(insertPathText('C:\\r\\app', 'C:\\r\\app\\src\\a.ts')).toBe('src/a.ts');
    expect(insertPathText('c:/R/app', 'C:\\r\\APP\\README.md')).toBe('README.md');
  });

  it('gives the absolute path outside the repo', () => {
    expect(insertPathText('C:\\r\\app', 'D:\\notes\\a.md')).toBe('D:\\notes\\a.md');
    expect(insertPathText('C:\\r\\app', 'C:\\r\\application\\a.md')).toBe('C:\\r\\application\\a.md');
  });

  it('gives a dot for the root itself', () => {
    expect(insertPathText('C:\\r\\app', 'C:\\r\\app\\')).toBe('.');
  });
});

describe('pathInsertText', () => {
  const bash = { shell: 'gitBash', claudeCode: false };
  const pwsh = { shell: 'pwsh', claudeCode: false };
  const powershell = { shell: 'powershell', claudeCode: false };
  const cmd = { shell: 'cmd', claudeCode: false };
  const cmdClaude = { shell: 'cmd', claudeCode: true };

  it('gives a forward-slash relative path inside the base root, ignoring case', () => {
    expect(pathInsertText(['C:\\r\\app\\src\\a.ts'], 'C:\\r\\app', bash)).toBe('src/a.ts ');
    expect(pathInsertText(['C:\\r\\APP\\README.md'], 'c:/R/app', cmd)).toBe('README.md ');
  });

  it('gives the absolute path outside the base root', () => {
    expect(pathInsertText(['D:\\notes\\a.md'], 'C:\\r\\app', bash)).toBe('D:/notes/a.md ');
    expect(pathInsertText(['C:\\r\\application\\a.md'], 'C:\\r\\app', bash)).toBe('C:/r/application/a.md ');
  });

  it('gives absolute paths when there is no base root', () => {
    expect(pathInsertText(['C:\\r\\app\\a.ts'], null, bash)).toBe('C:/r/app/a.ts ');
  });

  it('gives a dot for the root itself', () => {
    expect(pathInsertText(['C:\\r\\app\\'], 'C:\\r\\app', bash)).toBe('. ');
    expect(pathInsertText(['C:\\r\\app'], 'C:\\r\\app', cmd)).toBe('. ');
  });

  it('uses each profile\'s slashes for absolute paths', () => {
    const path = 'D:\\notes\\a.md';
    expect(pathInsertText([path], null, bash)).toBe('D:/notes/a.md ');
    expect(pathInsertText([path], null, pwsh)).toBe('D:/notes/a.md ');
    expect(pathInsertText([path], null, powershell)).toBe('D:/notes/a.md ');
    expect(pathInsertText(['D:/notes/a.md'], null, cmd)).toBe('D:\\notes\\a.md ');
    expect(pathInsertText([path], null, cmdClaude)).toBe('D:/notes/a.md ');
  });

  it('strips a trailing separator but keeps a drive root\'s', () => {
    expect(pathInsertText(['D:\\notes\\'], null, bash)).toBe('D:/notes ');
    expect(pathInsertText(['D:\\notes\\'], null, cmd)).toBe('D:\\notes ');
    expect(pathInsertText(['D:\\'], null, bash)).toBe('D:/ ');
    expect(pathInsertText(['D:/'], null, cmd)).toBe('D:\\ ');
  });

  it('quotes a spaced path for each profile', () => {
    const path = 'D:\\my notes\\a b.md';
    expect(pathInsertText([path], null, bash)).toBe("'D:/my notes/a b.md' ");
    expect(pathInsertText([path], null, pwsh)).toBe("'D:/my notes/a b.md' ");
    expect(pathInsertText([path], null, powershell)).toBe("'D:/my notes/a b.md' ");
    expect(pathInsertText([path], null, cmd)).toBe('"D:\\my notes\\a b.md" ');
    expect(pathInsertText([path], null, cmdClaude)).toBe('"D:/my notes/a b.md" ');
    expect(pathInsertText(['C:\\r\\app\\my file.ts'], 'C:\\r\\app', cmd)).toBe('"my file.ts" ');
    expect(pathInsertText(['C:\\r\\app\\src\\a b.ts'], 'C:\\r\\app', cmd)).toBe('"src\\a b.ts" ');
    expect(pathInsertText(['C:\\r\\app\\src\\a b.ts'], 'C:\\r\\app', cmdClaude)).toBe('"src/a b.ts" ');
  });

  it('escapes a single quote for Git Bash and PowerShell', () => {
    expect(pathInsertText(["C:\\r\\app\\it's.md"], 'C:\\r\\app', bash)).toBe("'it'\\''s.md' ");
    expect(pathInsertText(["C:\\r\\app\\it's.md"], 'C:\\r\\app', pwsh)).toBe("'it''s.md' ");
    expect(pathInsertText(["C:\\r\\app\\it's.md"], 'C:\\r\\app', powershell)).toBe("'it''s.md' ");
  });

  it('leaves a path of only safe characters bare', () => {
    expect(pathInsertText(['C:\\r\\a-b_c.d\\x@y+z:1.ts'], null, bash)).toBe('C:/r/a-b_c.d/x@y+z:1.ts ');
    expect(pathInsertText(['C:\\r\\a-b_c.d\\x@y+z.ts'], null, cmd)).toBe('C:\\r\\a-b_c.d\\x@y+z.ts ');
  });

  it('joins several paths with spaces and one trailing space', () => {
    expect(
      pathInsertText(['C:\\r\\app\\a.ts', 'C:\\r\\app\\b c.ts', 'D:\\x.md'], 'C:\\r\\app', bash),
    ).toBe("a.ts 'b c.ts' D:/x.md ");
  });

  it('follows Git Bash rules for an unknown profile id', () => {
    const container = { shell: 'docker-web', claudeCode: false };
    expect(pathInsertText(["D:\\it's here\\a.md"], null, container)).toBe("'D:/it'\\''s here/a.md' ");
  });

  it('gives an empty string for no paths', () => {
    expect(pathInsertText([], 'C:\\r\\app', bash)).toBe('');
  });
});

describe('pathProfileFor', () => {
  it('falls back to the default profile while the spawn is unresolved', () => {
    expect(pathProfileFor(undefined, 'pwsh', false)).toEqual({ shell: 'pwsh', claudeCode: false });
    expect(pathProfileFor('cmd', 'gitBash', true)).toEqual({ shell: 'cmd', claudeCode: true });
  });
});
