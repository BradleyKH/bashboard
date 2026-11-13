import { describe, expect, it } from 'vitest';
import { PROGRAM_STATUS_QUERY_REPLY, parseProgramStatus, programStatusReason } from './programStatus';

const bytesB64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
const b64 = (s: string) => bytesB64(new TextEncoder().encode(s));

describe('parseProgramStatus', () => {
  it('recognizes a probe, ignoring surrounding whitespace', () => {
    expect(parseProgramStatus('?')).toEqual({ type: 'query' });
    expect(parseProgramStatus('  ? \t')).toEqual({ type: 'query' });
  });

  it.each(['idle', 'working', 'blocked', 'done', 'error'])('accepts state %s', (state) => {
    expect(parseProgramStatus(`state=${state}`)).toEqual({ type: 'report', report: { state } });
  });

  it('reads clear as an action, ignoring a child clear', () => {
    expect(parseProgramStatus('state=clear')).toEqual({ type: 'clear' });
    expect(parseProgramStatus('state=clear:id=sub1')).toBeNull();
  });

  it('rejects unknown states', () => {
    expect(parseProgramStatus('state=sleeping')).toBeNull();
  });

  it.each(['permission', 'question', 'auth'])('keeps blocked kind %s', (kind) => {
    expect(parseProgramStatus(`state=blocked:kind=${kind}`)).toEqual({
      type: 'report',
      report: { state: 'blocked', kind },
    });
  });

  it('drops an unknown kind and a kind on a non-blocked state', () => {
    expect(parseProgramStatus('state=blocked:kind=other')).toEqual({
      type: 'report',
      report: { state: 'blocked' },
    });
    expect(parseProgramStatus('state=working:kind=permission')).toEqual({
      type: 'report',
      report: { state: 'working' },
    });
  });

  it('decodes a non-ASCII msg', () => {
    const msg = 'Fertig, danke ✓ 日本語';
    expect(parseProgramStatus(`state=done:msg=${b64(msg)}`)).toEqual({
      type: 'report',
      report: { state: 'done', msg },
    });
  });

  it('accepts unpadded base64', () => {
    const encoded = b64('hi!!').replace(/=+$/, '');
    expect(parseProgramStatus(`state=done:msg=${encoded}`)).toMatchObject({
      report: { msg: 'hi!!' },
    });
  });

  it('rejects a report whose msg or title is not valid base64 UTF-8', () => {
    expect(parseProgramStatus('state=done:msg=a===')).toBeNull();
    expect(parseProgramStatus('state=done:msg=a')).toBeNull();
    expect(parseProgramStatus(`state=done:msg=${bytesB64(new Uint8Array([0xff, 0xfe]))}`)).toBeNull();
    expect(parseProgramStatus('state=done:title=a')).toBeNull();
  });

  it('rejects a msg or title that decodes to a control character', () => {
    expect(parseProgramStatus(`state=done:msg=${b64('a\nb')}`)).toBeNull();
    expect(parseProgramStatus(`state=done:msg=${b64('a\u0085b')}`)).toBeNull();
    expect(parseProgramStatus(`state=done:title=${b64('a\tb')}`)).toBeNull();
  });

  it('accepts a valid title without exposing it', () => {
    expect(parseProgramStatus(`state=working:title=${b64('Build')}`)).toEqual({
      type: 'report',
      report: { state: 'working' },
    });
  });

  it('ignores an over-length body', () => {
    expect(parseProgramStatus(`state=done:msg=${'A'.repeat(4100)}`)).toBeNull();
  });

  it('skips a pair whose value holds a byte outside the value set', () => {
    expect(parseProgramStatus('state=done:msg=!!!')).toEqual({ type: 'report', report: { state: 'done' } });
  });

  it('ignores a child record', () => {
    expect(parseProgramStatus('state=working:id=sub/1')).toBeNull();
  });

  it('ignores a report with no state', () => {
    expect(parseProgramStatus('app=claude')).toBeNull();
    expect(parseProgramStatus('')).toBeNull();
  });

  it('skips a malformed pair and applies the rest', () => {
    expect(parseProgramStatus('bogus:state=working:=x:app=claude:msg')).toEqual({
      type: 'report',
      report: { state: 'working', app: 'claude' },
    });
  });

  it('treats an invalid app as absent', () => {
    expect(parseProgramStatus(`state=idle:app=${'a'.repeat(33)}`)).toEqual({
      type: 'report',
      report: { state: 'idle' },
    });
  });
});

describe('programStatusReason', () => {
  it('prefers the trimmed msg, cut at 200 characters', () => {
    expect(programStatusReason({ state: 'done', msg: '  all good ' })).toBe('all good');
    expect(programStatusReason({ state: 'done', msg: 'x'.repeat(300) })).toHaveLength(200);
  });

  it('falls back to per-kind text, then empty', () => {
    expect(programStatusReason({ state: 'blocked', kind: 'permission' })).toBe('Needs permission');
    expect(programStatusReason({ state: 'blocked', kind: 'question', msg: '   ' })).toBe('Has a question');
    expect(programStatusReason({ state: 'blocked', kind: 'auth' })).toBe('Needs sign-in');
    expect(programStatusReason({ state: 'working' })).toBe('');
  });
});

describe('PROGRAM_STATUS_QUERY_REPLY', () => {
  it('is the OSC 7501 probe reply with real ESC characters', () => {
    expect(PROGRAM_STATUS_QUERY_REPLY).toBe(
      '\x1b]7501;?:states=idle,working,done,blocked,error:kinds=permission,question,auth\x1b\\',
    );
  });
});
