import { describe, expect, it } from 'vitest';
import {
  CONTEXT_LARGE,
  CONTEXT_SMALL,
  claudeRows,
  contextBand,
  contextScale,
  formatProcess,
  formatTokens,
  modelDisplayName,
  nextLargeSessions,
  type ClaudeContext,
  type ProcFigures,
} from './claudeModel';
import type { TerminalCard } from './dashboardModel';
import type { Session } from './sessions';

function card(paneId: string, sessionId: string | null, title = paneId): TerminalCard {
  return {
    kind: 'terminal',
    paneId,
    tabId: 't1',
    title,
    path: 'C:\\repo',
    profile: 'bash',
    status: 'working',
    statusChangedAt: 0,
    reason: null,
    focused: false,
    sessionId,
    busy: false,
    collapsed: false,
    attention: false,
    hue: null,
    containerName: null,
  };
}

function session(sessionId: string, pid: number): Session {
  return {
    sessionId,
    pid,
    name: null,
    cwd: 'C:\\repo',
    status: 'busy',
    statusChangedAt: 0,
    startedAt: 0,
    version: null,
    paneId: 1,
    waitingReason: null,
  };
}

describe('formatTokens', () => {
  it('prints each tier at its boundaries', () => {
    expect(formatTokens(0)).toBe('0');
    expect(formatTokens(850)).toBe('850');
    expect(formatTokens(999)).toBe('999');
    expect(formatTokens(1000)).toBe('1.0k');
    expect(formatTokens(4321)).toBe('4.3k');
    expect(formatTokens(9999)).toBe('9.9k');
    expect(formatTokens(10_000)).toBe('10k');
    expect(formatTokens(112_400)).toBe('112k');
    expect(formatTokens(999_999)).toBe('999k');
    expect(formatTokens(1_000_000)).toBe('1M');
    expect(formatTokens(1_234_567)).toBe('1.2M');
  });
});

describe('contextScale', () => {
  it('measures against 200k until the count passes it', () => {
    expect(contextScale(150_000, false)).toBe(CONTEXT_SMALL);
    expect(contextScale(200_000, false)).toBe(CONTEXT_SMALL);
    expect(contextScale(200_001, false)).toBe(CONTEXT_LARGE);
  });

  it('stays at 1M once the session was large', () => {
    expect(contextScale(150_000, true)).toBe(CONTEXT_LARGE);
  });
});

describe('contextBand', () => {
  it('turns warn at 50% and error at 80%', () => {
    expect(contextBand(0)).toBe('ok');
    expect(contextBand(0.4999)).toBe('ok');
    expect(contextBand(0.5)).toBe('warn');
    expect(contextBand(0.7999)).toBe('warn');
    expect(contextBand(0.8)).toBe('error');
    expect(contextBand(1)).toBe('error');
  });
});

describe('modelDisplayName', () => {
  it('names the family-first form with and without a minor, a date, or [1m]', () => {
    expect(modelDisplayName('claude-opus-5-5')).toBe('Opus 5.5');
    expect(modelDisplayName('claude-fable-5-1')).toBe('Fable 5.1');
    expect(modelDisplayName('claude-sonnet-5-5[1m]')).toBe('Sonnet 5.5');
    expect(modelDisplayName('claude-haiku-4-5-20251001')).toBe('Haiku 4.5');
    expect(modelDisplayName('claude-sonnet-4-20250514')).toBe('Sonnet 4');
    expect(modelDisplayName('claude-opus-4-20250514[1m]')).toBe('Opus 4');
    expect(modelDisplayName('claude-sonnet-4')).toBe('Sonnet 4');
  });

  it('names the older version-first form', () => {
    expect(modelDisplayName('claude-3-5-sonnet-20241022')).toBe('Sonnet 3.5');
    expect(modelDisplayName('claude-3-opus-20240229')).toBe('Opus 3');
    expect(modelDisplayName('claude-3-7-sonnet')).toBe('Sonnet 3.7');
  });

  it('shows unknown ids raw', () => {
    expect(modelDisplayName('gpt-x')).toBe('gpt-x');
    expect(modelDisplayName('<synthetic>')).toBe('<synthetic>');
    expect(modelDisplayName('claude-poet-5')).toBe('claude-poet-5');
    expect(modelDisplayName('')).toBe('');
  });
});

describe('formatProcess', () => {
  it('prints memory and CPU, with "-" while CPU is unknown', () => {
    expect(formatProcess({ pid: 1, memoryBytes: 1.4 * 1024 ** 3, cpuPercent: 12.4 })).toBe('1.4 GB, 12%');
    expect(formatProcess({ pid: 1, memoryBytes: 300 * 1024 ** 2, cpuPercent: null })).toBe('300 MB, -');
  });
});

describe('claudeRows', () => {
  const sessions = [session('s-a', 100), session('s-b', 200)];
  const contexts = new Map<string, ClaudeContext>([
    ['s-a', { sessionId: 's-a', model: 'claude-opus-5-5', contextTokens: 112_400 }],
  ]);
  const procs = new Map<number, ProcFigures>([
    [100, { pid: 100, memoryBytes: 2 * 1024 ** 3, cpuPercent: 5 }],
    [200, { pid: 200, memoryBytes: 512 * 1024 ** 2, cpuPercent: null }],
  ]);

  it('keeps card order, blanks an unreported session, and skips a card without a session', () => {
    const cards = [card('p3', 's-b', 'second'), card('p1', null), card('p2', 's-a', 'first')];
    const rows = claudeRows(cards, sessions, contexts, procs, new Set());
    expect(rows.map((r) => r.paneId)).toEqual(['p3', 'p2']);

    const [b, a] = rows;
    expect(b).toMatchObject({
      sessionId: 's-b',
      title: 'second',
      status: 'working',
      model: null,
      tokens: null,
      tokensText: '',
      fraction: 0,
      band: 'ok',
      processText: '512 MB, -',
    });
    expect(a).toMatchObject({
      sessionId: 's-a',
      title: 'first',
      model: 'Opus 5.5',
      tokens: 112_400,
      tokensText: '112k',
      scale: CONTEXT_SMALL,
      band: 'warn',
      processText: '2.0 GB, 5%',
    });
    expect(a.fraction).toBeCloseTo(0.562);
  });

  it('leaves the process text null for a session missing from the roster or the figures', () => {
    const rows = claudeRows([card('p9', 's-gone')], sessions, contexts, procs, new Set());
    expect(rows[0].processText).toBeNull();
    const noFig = claudeRows([card('p2', 's-a')], sessions, contexts, new Map(), new Set());
    expect(noFig[0].processText).toBeNull();
  });

  it('keeps the 1M scale for a session that crossed 200k', () => {
    const big = new Map(contexts);
    big.set('s-a', { sessionId: 's-a', model: 'claude-opus-5-5', contextTokens: 250_000 });
    const first = claudeRows([card('p2', 's-a')], sessions, big, procs, new Set());
    expect(first[0].scale).toBe(CONTEXT_LARGE);
    expect(first[0].fraction).toBeCloseTo(0.25);

    const large = nextLargeSessions(new Set(), first);
    expect([...large]).toEqual(['s-a']);

    const compacted = new Map(contexts);
    compacted.set('s-a', { sessionId: 's-a', model: 'claude-opus-5-5', contextTokens: 150_000 });
    const later = claudeRows([card('p2', 's-a')], sessions, compacted, procs, large);
    expect(later[0].scale).toBe(CONTEXT_LARGE);
    expect(later[0].band).toBe('ok');
  });

  it('caps the fraction at 1', () => {
    const over = new Map([['s-a', { sessionId: 's-a', model: null, contextTokens: 1_200_000 }]]);
    const rows = claudeRows([card('p2', 's-a')], sessions, over, procs, new Set());
    expect(rows[0].fraction).toBe(1);
    expect(rows[0].band).toBe('error');
    expect(rows[0].model).toBeNull();
  });
});

describe('nextLargeSessions', () => {
  it('returns the same set when no row passed 200k', () => {
    const prev = new Set(['s-x']);
    const rows = claudeRows([card('p2', 's-a')], [session('s-a', 1)], new Map(), new Map(), prev);
    expect(nextLargeSessions(prev, rows)).toBe(prev);
  });
});
