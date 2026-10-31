import { describe, expect, it } from 'vitest';
import {
  Sparkline,
  formatBytes,
  formatDiskFree,
  formatMemory,
  formatNetwork,
  formatPercent,
  formatRate,
  loadBand,
} from './systemModel';

const KB = 1024;
const MB = KB * 1024;
const GB = MB * 1024;
const TB = GB * 1024;

describe('formatBytes', () => {
  it('uses binary units with a decimal under 10', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(1023)).toBe('1023 B');
    expect(formatBytes(1024)).toBe('1.0 KB');
    expect(formatBytes(10 * KB)).toBe('10 KB');
    expect(formatBytes(1.5 * MB)).toBe('1.5 MB');
    expect(formatBytes(112 * GB)).toBe('112 GB');
    expect(formatBytes(2 * TB)).toBe('2.0 TB');
  });
});

describe('formatMemory', () => {
  it('shows both figures in the total unit', () => {
    expect(formatMemory(21.4 * GB, 32 * GB)).toBe('21.4 / 32 GB');
    expect(formatMemory(3.2 * GB, 15.9 * GB)).toBe('3.2 / 15.9 GB');
  });
});

describe('formatRate and formatNetwork', () => {
  it('formats rates', () => {
    expect(formatRate(0)).toBe('0 B/s');
    expect(formatRate(40 * KB)).toBe('40 KB/s');
    expect(formatRate(1.2 * MB)).toBe('1.2 MB/s');
  });

  it('formats both directions', () => {
    expect(formatNetwork(1.2 * MB, 40 * KB)).toBe('\u2193 1.2 MB/s \u2191 40 KB/s');
  });

  it('shows hyphens when either rate is null', () => {
    expect(formatNetwork(null, null)).toBe('\u2193 - \u2191 -');
    expect(formatNetwork(5, null)).toBe('\u2193 - \u2191 -');
  });
});

describe('formatDiskFree and formatPercent', () => {
  it('formats a drive', () => {
    expect(formatDiskFree({ mount: 'C:', totalBytes: 500 * GB, availableBytes: 112 * GB })).toBe(
      'C: 112 GB free',
    );
  });

  it('formats percentages', () => {
    expect(formatPercent(23.4)).toBe('23%');
    expect(formatPercent(null)).toBe('-');
  });
});

describe('loadBand', () => {
  it('switches at 0.8 and 0.9', () => {
    expect(loadBand(0.79)).toBe('ok');
    expect(loadBand(0.8)).toBe('warn');
    expect(loadBand(0.89)).toBe('warn');
    expect(loadBand(0.9)).toBe('error');
  });
});

describe('Sparkline', () => {
  it('keeps the last 30 values oldest first', () => {
    const s = new Sparkline();
    for (let i = 0; i < 35; i++) s.push(i);
    const v = s.values();
    expect(v).toHaveLength(30);
    expect(v[0]).toBe(5);
    expect(v[29]).toBe(34);
  });

  it('records nothing for null', () => {
    const s = new Sparkline();
    s.push(1);
    s.push(null);
    expect(s.values()).toEqual([1]);
  });
});
