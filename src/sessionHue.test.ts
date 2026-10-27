import { describe, expect, it } from 'vitest';
import { hueCss, sessionHue } from './sessionHue';

describe('sessionHue', () => {
  it('gives the same hue for the same input', () => {
    const s = { name: 'api', cwd: 'C:\\repos\\api' };
    expect(sessionHue(s)).toBe(sessionHue({ ...s }));
  });

  it('uses the name over the cwd when named', () => {
    const a = sessionHue({ name: 'api', cwd: 'C:\\repos\\one' });
    const b = sessionHue({ name: 'api', cwd: 'C:\\repos\\two' });
    expect(a).toBe(b);
    expect(a).not.toBe(sessionHue({ name: 'web', cwd: 'C:\\repos\\one' }));
  });

  it('falls back to the cwd when the name is null or empty', () => {
    const cwd = 'C:\\repos\\api';
    const fromCwd = sessionHue({ name: null, cwd: cwd.toLowerCase() });
    expect(sessionHue({ name: null, cwd })).toBe(fromCwd);
    expect(sessionHue({ name: '', cwd })).toBe(fromCwd);
  });

  it('ignores cwd case', () => {
    expect(sessionHue({ name: null, cwd: 'C:\\Foo' })).toBe(
      sessionHue({ name: null, cwd: 'c:\\foo' }),
    );
  });

  it('stays in [0, 1)', () => {
    for (let i = 0; i < 200; i++) {
      const h = sessionHue({ name: `session-${i}`, cwd: `C:\\x\\${i}` });
      expect(h).toBeGreaterThanOrEqual(0);
      expect(h).toBeLessThan(1);
    }
  });
});

describe('hueCss', () => {
  it('maps hue to degrees with the palette saturation and lightness', () => {
    expect(hueCss(0.5)).toBe('hsl(180deg 90% 60%)');
    expect(hueCss(0)).toBe('hsl(0deg 90% 60%)');
  });
});
