import { describe, expect, it } from 'vitest';
import type { BranchSize } from './branchSizeApi';
import {
  badgeText,
  badgeTitle,
  isOverThreshold,
  meterFraction,
  sizeSummary,
} from './branchSizeModel';

function size(over: Partial<BranchSize> = {}): BranchSize {
  return {
    worktree: 'C:/repo',
    branch: 'feature',
    comparison: 'origin/main',
    lines: 512,
    added: 430,
    removed: 82,
    files: 14,
    excludedLines: 210,
    excludedFiles: 6,
    ...over,
  };
}

describe('isOverThreshold', () => {
  it('is true only above the threshold', () => {
    expect(isOverThreshold(size({ lines: 401 }), 400)).toBe(true);
    expect(isOverThreshold(size({ lines: 400 }), 400)).toBe(false);
    expect(isOverThreshold(size({ lines: 12 }), 400)).toBe(false);
  });

  it('is false when the threshold is 0', () => {
    expect(isOverThreshold(size({ lines: 5000 }), 0)).toBe(false);
  });

  it('is false without a comparison ref', () => {
    expect(isOverThreshold(size({ comparison: null, lines: 5000 }), 400)).toBe(false);
  });

  it('does not depend on the branch, so a detached HEAD counts', () => {
    expect(isOverThreshold(size({ branch: null }), 400)).toBe(true);
  });
});

describe('badgeText', () => {
  it('pluralizes lines', () => {
    expect(badgeText(size({ lines: 512 }))).toBe('512 lines');
    expect(badgeText(size({ lines: 1 }))).toBe('1 line');
    expect(badgeText(size({ lines: 0 }))).toBe('0 lines');
  });
});

describe('badgeTitle', () => {
  it('spells out the counts, the ref, and the exclusions', () => {
    expect(badgeTitle(size())).toBe(
      '+430 -82 in 14 files against origin/main\nTests, lockfiles, and generated files excluded: 210 lines in 6 files',
    );
  });

  it('omits the excluded line when nothing was excluded', () => {
    expect(badgeTitle(size({ excludedLines: 0, excludedFiles: 0 }))).toBe(
      '+430 -82 in 14 files against origin/main',
    );
  });

  it('uses singular file and line', () => {
    expect(
      badgeTitle(size({ added: 1, removed: 0, files: 1, excludedLines: 1, excludedFiles: 1 })),
    ).toBe(
      '+1 -0 in 1 file against origin/main\nTests, lockfiles, and generated files excluded: 1 line in 1 file',
    );
  });

  it('names the missing comparison ref', () => {
    expect(badgeTitle(size({ comparison: null, lines: 0, added: 0, removed: 0, files: 0 }))).toBe(
      'No comparison ref to measure against',
    );
  });

  it('reads the same on a detached HEAD', () => {
    expect(badgeTitle(size({ branch: null }))).toBe(badgeTitle(size()));
  });
});

describe('meterFraction', () => {
  it('is the share of the threshold used', () => {
    expect(meterFraction(size({ lines: 100 }), 400)).toBe(0.25);
    expect(meterFraction(size({ lines: 0 }), 400)).toBe(0);
  });

  it('clamps to 1 over the threshold', () => {
    expect(meterFraction(size({ lines: 5000 }), 400)).toBe(1);
  });

  it('is null when the threshold is 0', () => {
    expect(meterFraction(size(), 0)).toBeNull();
  });

  it('is 0 with no comparison ref, since lines is 0 there', () => {
    expect(meterFraction(size({ comparison: null, lines: 0 }), 400)).toBe(0);
  });
});

describe('sizeSummary', () => {
  it('summarizes lines, the split, files, and the ref', () => {
    expect(sizeSummary(size())).toBe('512 lines changed (+430 -82) in 14 files against origin/main');
  });

  it('uses singular file and line', () => {
    expect(sizeSummary(size({ lines: 1, added: 1, removed: 0, files: 1 }))).toBe(
      '1 line changed (+1 -0) in 1 file against origin/main',
    );
  });

  it('names the missing comparison ref explicitly', () => {
    expect(sizeSummary(size({ comparison: null, lines: 0, added: 0, removed: 0, files: 0 }))).toBe(
      'No comparison ref, so the branch size is not measured',
    );
  });

  it('is the same on a detached HEAD', () => {
    expect(sizeSummary(size({ branch: null }))).toBe(sizeSummary(size()));
  });
});
