import type { BranchSize } from './branchSizeApi';

/**
 * Pure text and threshold rules for the branch size badge and the dashboard's Branch section.
 */

function plural(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? '' : 's'}`;
}

/** A threshold of 0 (or less) turns the badge off; with no comparison ref there is nothing to size. */
export function isOverThreshold(size: BranchSize, threshold: number): boolean {
  if (threshold <= 0 || size.comparison === null) return false;
  return size.lines > threshold;
}

export function badgeText(size: BranchSize): string {
  return plural(size.lines, 'line');
}

export function badgeTitle(size: BranchSize): string {
  if (size.comparison === null) return 'No comparison ref to measure against';
  const lines = [
    `+${size.added} -${size.removed} in ${plural(size.files, 'file')} against ${size.comparison}`,
  ];
  if (size.excludedLines > 0 || size.excludedFiles > 0) {
    lines.push(
      `Tests, lockfiles, and generated files excluded: ${plural(size.excludedLines, 'line')} in ${plural(size.excludedFiles, 'file')}`,
    );
  }
  return lines.join('\n');
}

/** Share of the threshold used, clamped to 0..1; null when the threshold is off. */
export function meterFraction(size: BranchSize, threshold: number): number | null {
  if (threshold <= 0) return null;
  return Math.min(1, Math.max(0, size.lines / threshold));
}

export function sizeSummary(size: BranchSize): string {
  if (size.comparison === null) return 'No comparison ref, so the branch size is not measured';
  return `${plural(size.lines, 'line')} changed (+${size.added} -${size.removed}) in ${plural(size.files, 'file')} against ${size.comparison}`;
}
