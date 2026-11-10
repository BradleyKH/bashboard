import { describe, expect, it } from 'vitest';
import {
  addGlobalPin,
  alphabetizedGlobalPins,
  editGlobalPin,
  moveGlobalPin,
  parseGlobalPins,
  removeGlobalPin,
} from './globalPins';

describe('parseGlobalPins', () => {
  it('keeps trimmed commands and labels, dropping blanks, junk, and repeats', () => {
    expect(
      parseGlobalPins([
        { label: ' Fetch ', command: ' git fetch --prune ' },
        { command: 'pnpm install', label: '  ' },
        { command: '   ' },
        { label: 'no command' },
        'git status',
        null,
        { label: 'Again', command: 'git fetch --prune' },
      ]),
    ).toEqual([{ label: 'Fetch', command: 'git fetch --prune' }, { command: 'pnpm install' }]);
  });

  it('reads anything but an array as empty', () => {
    expect(parseGlobalPins(null)).toEqual([]);
    expect(parseGlobalPins({ command: 'x' })).toEqual([]);
  });
});

describe('editing', () => {
  const file = [{ command: 'a' }, { label: 'B', command: 'b' }];

  it('adds at the end, refusing blanks and repeats', () => {
    expect(addGlobalPin(file, ' C ', ' c ')).toEqual([...file, { label: 'C', command: 'c' }]);
    expect(addGlobalPin(file, 'x', '  ')).toBe(file);
    expect(addGlobalPin(file, 'x', 'b')).toBe(file);
  });

  it('removes by index', () => {
    expect(removeGlobalPin(file, 0)).toEqual([{ label: 'B', command: 'b' }]);
    expect(removeGlobalPin(file, 5)).toBe(file);
  });

  it('edits in place, clearing an empty label, and refuses a command another pin holds', () => {
    expect(editGlobalPin(file, 1, '', 'bb')).toEqual([{ command: 'a' }, { command: 'bb' }]);
    expect(editGlobalPin(file, 1, 'B', 'a')).toBe(file);
    expect(editGlobalPin(file, 1, 'B', ' ')).toBe(file);
    expect(editGlobalPin(file, 1, 'Bee', 'b')).toEqual([{ command: 'a' }, { label: 'Bee', command: 'b' }]);
  });

  it('moves', () => {
    expect(moveGlobalPin(file, 0, 1)).toEqual([file[1], file[0]]);
  });
});

describe('alphabetizedGlobalPins', () => {
  it('sorts by label or command without regard to case, keeping file indexes', () => {
    const sorted = alphabetizedGlobalPins([
      { command: 'pnpm install' },
      { label: 'docker ps', command: 'docker compose ps' },
      { label: 'Claude resume', command: 'claude --resume' },
    ]);
    expect(sorted.map((s) => s.index)).toEqual([2, 1, 0]);
  });
});
