/** What the dashboard clock draws: the binary grid, `h:mm`, or both (`dashboard.clockStyle`). */
export type ClockStyle = 'both' | 'time' | 'binary';

/** Each style with its label, in the order the Settings tab and the clock's menu list them. */
export const CLOCK_STYLE_OPTIONS: readonly { value: ClockStyle; label: string }[] = [
  { value: 'both', label: 'Binary and time' },
  { value: 'time', label: 'Time only' },
  { value: 'binary', label: 'Binary only' },
];

/** Six bits of `n`, most significant first (index 0 is the leftmost dot). */
export function sixBits(n: number): boolean[] {
  return Array.from({ length: 6 }, (_, i) => ((n >> (5 - i)) & 1) === 1)
}

function hour12(d: Date): number {
  return d.getHours() % 12 || 12
}

function minutesText(d: Date): string {
  return String(d.getMinutes()).padStart(2, '0')
}

/** `h:mm` in 12-hour time with no am/pm and no leading zero on the hour. */
export function clockText(d: Date): string {
  return `${hour12(d)}:${minutesText(d)}`
}

/** The clock's accessible name: the time with AM or PM. */
export function clockLabel(d: Date): string {
  return `${clockText(d)} ${d.getHours() < 12 ? 'AM' : 'PM'}`
}

/** Hours (24-hour), minutes, and seconds as six-bit rows. */
export function clockBits(d: Date): { hours: boolean[]; minutes: boolean[]; seconds: boolean[] } {
  return {
    hours: sixBits(d.getHours()),
    minutes: sixBits(d.getMinutes()),
    seconds: sixBits(d.getSeconds()),
  }
}
