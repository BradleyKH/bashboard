// Parser for OSC 7501, the Program Status Protocol: a program such as Claude Code or Codex
// writes its own status into the terminal stream once the terminal answers its probe.
// Spec: https://www.superlogical.com/rex/docs/build/program-status
// See docs/design/sessions.md section 4.24. Pure: no DOM, no xterm.js.

export type ProgramState = 'idle' | 'working' | 'blocked' | 'done' | 'error';
export type ProgramStatusKind = 'permission' | 'question' | 'auth';

export interface ProgramStatusReport {
  state: ProgramState;
  /** Only ever set with `blocked`. */
  kind?: ProgramStatusKind;
  /** Decoded free text, if the program sent one. */
  msg?: string;
  app?: string;
}

export type ProgramStatusMessage =
  | { type: 'query' }
  | { type: 'clear' }
  | { type: 'report'; report: ProgramStatusReport };

/** Reply to the `ESC ] 7501 ; ? ST` probe; written to the pty as if typed. */
export const PROGRAM_STATUS_QUERY_REPLY =
  '\x1b]7501;?:states=idle,working,done,blocked,error:kinds=permission,question,auth\x1b\\';

// The spec caps a whole sequence at 4096 bytes; the OSC introducer and terminator take 9.
const MAX_BODY = 4087;
const MAX_REASON = 200;

const STATES: readonly string[] = ['idle', 'working', 'blocked', 'done', 'error'];
const KINDS: readonly string[] = ['permission', 'question', 'auth'];
const KEY = /^[a-z]+$/;
const VALUE = /^[A-Za-z0-9_.,+/=-]*$/;
const APP = /^[A-Za-z0-9_.+-]{1,32}$/;
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;

/** Decodes base64 UTF-8 free text; null when it is malformed or holds a control character. */
function decodeText(value: string): string | null {
  try {
    const bin = atob(value);
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return CONTROL.test(text) ? null : text;
  } catch {
    return null;
  }
}

/**
 * Parses the body after `ESC ] 7501 ;`. Only the root record counts, so a report that carries
 * an `id` (a child record) returns null, as does anything without a valid state. `state=clear`
 * is an action, not a state: the pane drops what the program last reported.
 */
export function parseProgramStatus(body: string): ProgramStatusMessage | null {
  if (body.length > MAX_BODY) return null;
  const trimmed = body.trim();
  if (trimmed === '?') return { type: 'query' };

  const pairs = new Map<string, string>();
  for (const part of trimmed.split(':')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const key = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (!KEY.test(key) || !VALUE.test(value)) continue;
    pairs.set(key, value); // the last value wins
  }

  if (pairs.has('id')) return null;
  const state = pairs.get('state');
  if (state === 'clear') return { type: 'clear' };
  if (state === undefined || !STATES.includes(state)) return null;

  // A report whose free text is malformed is discarded whole, title included even though unused.
  let msg: string | undefined;
  const rawMsg = pairs.get('msg');
  if (rawMsg !== undefined) {
    const decoded = decodeText(rawMsg);
    if (decoded === null) return null;
    msg = decoded;
  }
  const rawTitle = pairs.get('title');
  if (rawTitle !== undefined && decodeText(rawTitle) === null) return null;

  const report: ProgramStatusReport = { state: state as ProgramState };
  const kind = pairs.get('kind');
  if (state === 'blocked' && kind !== undefined && KINDS.includes(kind)) {
    report.kind = kind as ProgramStatusKind;
  }
  if (msg !== undefined) report.msg = msg;
  const app = pairs.get('app');
  if (app !== undefined && APP.test(app)) report.app = app;
  return { type: 'report', report };
}

const KIND_REASON: Record<ProgramStatusKind, string> = {
  permission: 'Needs permission',
  question: 'Has a question',
  auth: 'Needs sign-in',
};

/** The line shown for a report: its message, else text for its blocked kind, else empty. */
export function programStatusReason(report: ProgramStatusReport): string {
  const msg = report.msg?.trim();
  if (msg) return msg.slice(0, MAX_REASON);
  return report.kind ? KIND_REASON[report.kind] : '';
}
