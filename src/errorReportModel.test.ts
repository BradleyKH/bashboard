import { describe, expect, it } from 'vitest';
import { MAX_REPORTS_PER_MINUTE, ReportGate, reportText } from './errorReportModel';

describe('reportText', () => {
  it('puts an error and its stack on one line', () => {
    const e = new Error('boom');
    e.stack = 'Error: boom\n    at a (x.ts:1)\n    at b (y.ts:2)';
    expect(reportText(e)).toBe('Error: boom | at a (x.ts:1) | at b (y.ts:2)');
  });

  it('keeps the message when the stack leaves it out', () => {
    const e = new Error('boom');
    e.stack = '    at a (x.ts:1)';
    expect(reportText(e)).toBe('boom | at a (x.ts:1)');
  });

  it('describes strings and other values', () => {
    expect(reportText('plain')).toBe('plain');
    expect(reportText({ code: 5 })).toBe('{"code":5}');
    expect(reportText(undefined)).toBe('undefined');
  });

  it('caps the length', () => {
    expect(reportText('x'.repeat(5000)).length).toBe(2003);
  });
});

describe('ReportGate', () => {
  it('drops an immediate repeat', () => {
    const gate = new ReportGate();
    expect(gate.allow('a', 0)).toBe(true);
    expect(gate.allow('a', 1)).toBe(false);
    expect(gate.allow('b', 2)).toBe(true);
    expect(gate.allow('a', 3)).toBe(true);
  });

  it('allows a limited number a minute', () => {
    const gate = new ReportGate();
    for (let i = 0; i < MAX_REPORTS_PER_MINUTE; i++) expect(gate.allow(`e${i}`, i)).toBe(true);
    expect(gate.allow('over', 100)).toBe(false);
    expect(gate.allow('later', 60_000)).toBe(true);
  });
});
