// Which front-end errors reach the core's log (docs/design/app.md section 3.22). No DOM.

/** Past this many reports a minute the rest are dropped, so an error thrown every frame cannot flood the log. */
export const MAX_REPORTS_PER_MINUTE = 20;
const MAX_LENGTH = 2000;

/** One line for the log: the message, then the first frames of the stack. */
export function reportText(error: unknown): string {
  let text: string;
  if (error instanceof Error) text = error.stack?.includes(error.message) ? error.stack : `${error.message}\n${error.stack ?? ''}`;
  else if (typeof error === 'string') text = error;
  else {
    try {
      text = JSON.stringify(error) ?? String(error);
    } catch {
      text = String(error);
    }
  }
  text = text.trim().replace(/\s*\n\s*/g, ' | ');
  return text.length > MAX_LENGTH ? `${text.slice(0, MAX_LENGTH)}...` : text;
}

/** Decides per report whether to send it: a repeat of the last one, or one past the limit, is dropped. */
export class ReportGate {
  private windowStart = 0;
  private count = 0;
  private last = '';

  allow(text: string, now: number): boolean {
    if (text === this.last) return false;
    if (now - this.windowStart >= 60_000) {
      this.windowStart = now;
      this.count = 0;
    }
    if (this.count >= MAX_REPORTS_PER_MINUTE) return false;
    this.count += 1;
    this.last = text;
    return true;
  }
}
