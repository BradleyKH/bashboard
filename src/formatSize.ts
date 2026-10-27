const UNITS = ['B', 'KB', 'MB', 'GB'];

/** Human readable byte count: 512 B, 3.4 KB, 1.2 MB. */
export function formatSize(bytes: number): string {
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return unit === 0 ? `${value} B` : `${value.toFixed(value < 10 ? 1 : 0)} ${UNITS[unit]}`;
}
