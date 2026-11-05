import { describe, expect, it } from 'vitest';
import {
  buildServerRows,
  contextLabel,
  findLoadedOllama,
  isLowContext,
  placement,
  secondsUntil,
  unloadLabel,
} from './localModelsModel';
import type { ModelServersSnapshot } from './modelServersApi';

const NOW = Date.parse('2026-11-04T22:43:06Z');

const snap: ModelServersSnapshot = {
  ollamaOnPath: true,
  lmStudio: null,
  ollama: {
    url: 'http://127.0.0.1:11434',
    version: '0.40.14',
    models: [
      {
        name: 'gemma4:e2b',
        size: 330783784,
        sizeVram: 330783784,
        contextLength: 4096,
        expiresAt: '2026-11-04T16:48:06.0815902-06:00',
      },
    ],
  },
};

describe('placement', () => {
  it('prints GPU, CPU, and the GPU share like ollama ps', () => {
    expect(placement(100, 100)).toBe('GPU');
    expect(placement(100, 0)).toBe('CPU');
    expect(placement(100, 62)).toBe('62% GPU');
    expect(placement(100, null)).toBeNull();
    expect(placement(0, 0)).toBeNull();
  });
});

describe('contextLabel', () => {
  it('abbreviates thousands', () => {
    expect(contextLabel(4096)).toBe('4.1k');
    expect(contextLabel(64000)).toBe('64k');
    expect(contextLabel(131072)).toBe('131.1k');
    expect(contextLabel(512)).toBe('512');
    expect(contextLabel(null)).toBe('');
  });
});

describe('isLowContext', () => {
  it('flags only below the minimum, and 0 disables it', () => {
    expect(isLowContext(4096, 64000)).toBe(true);
    expect(isLowContext(64000, 64000)).toBe(false);
    expect(isLowContext(4096, 0)).toBe(false);
    expect(isLowContext(null, 64000)).toBe(false);
  });
});

describe('unload time', () => {
  it('parses Go nanosecond timestamps', () => {
    expect(secondsUntil('2026-11-04T16:48:06.0815902-06:00', NOW)).toBe(300);
  });
  it('formats seconds, minutes, and hours', () => {
    expect(unloadLabel('2026-11-04T22:43:36Z', NOW)).toBe('30s');
    expect(unloadLabel('2026-11-04T22:48:06Z', NOW)).toBe('5m');
    expect(unloadLabel('2026-11-05T00:13:06Z', NOW)).toBe('1h 30m');
  });
  it('clamps a past time to 0s and reads a far date as never', () => {
    expect(unloadLabel('2026-11-04T22:00:00Z', NOW)).toBe('0s');
    expect(unloadLabel('2318-06-08T00:00:00Z', NOW)).toBe('never');
  });
  it('is empty without a usable time', () => {
    expect(unloadLabel(null, NOW)).toBe('');
    expect(unloadLabel('garbage', NOW)).toBe('');
  });
});

describe('buildServerRows', () => {
  it('builds a server row with a model row and the warning', () => {
    const rows = buildServerRows(snap, 64000, NOW);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: 'ollama', label: 'Ollama', version: '0.40.14' });
    expect(rows[0].models[0]).toMatchObject({
      name: 'gemma4:e2b',
      placement: 'GPU',
      contextLabel: '4.1k',
      lowContext: true,
      unloadLabel: '5m',
    });
    expect(buildServerRows(snap, 0, NOW)[0].models[0].lowContext).toBe(false);
  });
  it('is empty with no answering server', () => {
    expect(buildServerRows(null, 64000, NOW)).toEqual([]);
    expect(buildServerRows({ ollama: null, lmStudio: null, ollamaOnPath: false }, 64000, NOW)).toEqual([]);
  });
});

describe('findLoadedOllama', () => {
  it('matches a session model to a loaded model, defaulting the tag to latest', () => {
    expect(findLoadedOllama(snap, 'gemma4:e2b')?.contextLength).toBe(4096);
    expect(findLoadedOllama(snap, 'GEMMA4:E2B')).not.toBeNull();
    expect(findLoadedOllama(snap, 'gemma4')).toBeNull();
    expect(findLoadedOllama(snap, null)).toBeNull();
    expect(findLoadedOllama(null, 'gemma4:e2b')).toBeNull();
  });
});
