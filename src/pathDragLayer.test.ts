import { describe, expect, it } from 'vitest';
import { moveDragLabel, pathDragLabel, sameDropTarget } from './pathDragLayer';

describe('pathDragLabel', () => {
  it('uses the last segment of one path', () => {
    expect(pathDragLabel(['C:\\repo\\src\\main.ts'])).toBe('main.ts');
    expect(pathDragLabel(['/a/b/c.txt'])).toBe('c.txt');
  });

  it('ignores a trailing separator', () => {
    expect(pathDragLabel(['C:/repo/src/'])).toBe('src');
    expect(pathDragLabel(['C:\\repo\\src\\'])).toBe('src');
  });

  it('adds a count for the remaining paths', () => {
    expect(pathDragLabel(['/a/one.ts', '/a/two.ts', '/a/three.ts'])).toBe('one.ts +2');
  });
});

describe('moveDragLabel', () => {
  it('names the target folder before the dragged files', () => {
    expect(moveDragLabel(['C:/r/plans/a.md', 'C:/r/plans/b.md'], 'C:/r/plans/done/')).toBe(
      'Move to done: a.md +1',
    );
  });
});

describe('sameDropTarget', () => {
  it('compares inserts by pane and moves by folder', () => {
    const el = {} as HTMLElement;
    expect(sameDropTarget({ kind: 'insert', paneId: 'p1' }, { kind: 'insert', paneId: 'p1' })).toBe(true);
    expect(sameDropTarget({ kind: 'insert', paneId: 'p1' }, null)).toBe(false);
    expect(sameDropTarget({ kind: 'move', folder: 'C:/r/done', el }, { kind: 'move', folder: 'C:/r/done', el })).toBe(
      true,
    );
    expect(sameDropTarget({ kind: 'move', folder: 'C:/r/done', el }, { kind: 'insert', paneId: 'p1' })).toBe(false);
  });
});
