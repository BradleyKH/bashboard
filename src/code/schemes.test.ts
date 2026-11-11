import { describe, expect, it } from 'vitest';
import { ACCENT_PRESETS, relativeLuminance } from '../accent';
import { ROLES } from './roles';
import {
  applyScheme,
  CODE_SCHEME_IDS,
  codeColorsMode,
  DEFAULT_CODE_SCHEME,
  pairedScheme,
  resolveScheme,
  SCHEME_CREDITS,
  SCHEMES,
} from './schemes';

function contrast(a: string, b: string): number {
  const [hi, lo] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

describe('SCHEMES', () => {
  it('lists the eight schemes in table order, between matchAccent and none in the ids', () => {
    expect(SCHEMES.map((s) => s.id)).toEqual(CODE_SCHEME_IDS.slice(1, -1));
    expect(DEFAULT_CODE_SCHEME).toBe('matchAccent');
  });

  it('defines every role with a #rrggbb color', () => {
    for (const s of SCHEMES) {
      expect(Object.keys(s.colors).sort()).toEqual([...ROLES].sort());
      for (const role of ROLES) expect(s.colors[role]).toMatch(/^#[0-9a-f]{6}$/);
    }
  });

  it('keeps every color at 4.5:1 or better against #1e1e1e', () => {
    for (const s of SCHEMES) {
      for (const role of ROLES) {
        expect(contrast(s.colors[role], '#1e1e1e'), `${s.id} ${role}`).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  it('credits every scheme', () => {
    for (const s of SCHEMES) expect(SCHEME_CREDITS[s.id].license).toBe('MIT');
  });
});

describe('pairedScheme', () => {
  const table: Record<string, string> = {
    Silver: 'nord',
    Orange: 'ayu',
    Gold: 'gruvbox',
    Green: 'monokai',
    Teal: 'tokyoNight',
    Blue: 'oneDark',
    Violet: 'catppuccinMocha',
    Pink: 'dracula',
  };

  it('pairs every accent preset per the table', () => {
    expect(ACCENT_PRESETS.map((p) => p.label).sort()).toEqual(Object.keys(table).sort());
    for (const p of ACCENT_PRESETS) expect(pairedScheme(p.value).id, p.label).toBe(table[p.label]);
    for (const s of SCHEMES) expect(table[s.pairsWith]).toBe(s.id);
  });

  it('pairs a custom accent with the nearest preset hue', () => {
    expect(pairedScheme('#40a0ff').id).toBe('oneDark');
    expect(pairedScheme('#ff8030').id).toBe('ayu');
    expect(pairedScheme('#50e070').id).toBe('monokai');
    expect(pairedScheme('#ff70c0').id).toBe('dracula');
    expect(pairedScheme('#4FB3C8').id).toBe('tokyoNight');
  });

  it('pairs a low-saturation accent with nord', () => {
    expect(pairedScheme('#808080').id).toBe('nord');
    expect(pairedScheme('#c0c8b8').id).toBe('nord');
  });
});

describe('resolveScheme', () => {
  it('honors an explicit id and resolves matchAccent through the accent', () => {
    expect(resolveScheme('dracula', '#f0a050').id).toBe('dracula');
    expect(resolveScheme('matchAccent', '#f0a050').id).toBe('ayu');
  });
});

describe('applyScheme', () => {
  it('sets --syn-<role> for every role', () => {
    const set = new Map<string, string>();
    applyScheme({ style: { setProperty: (n, v) => set.set(n, v) } }, SCHEMES[0]);
    expect(set.size).toBe(ROLES.length);
    expect(set.get('--syn-comment')).toBe(SCHEMES[0].colors.comment);
  });
});

describe('codeColorsMode', () => {
  it('turns coloring off for none only, and none still resolves to a scheme', () => {
    for (const id of CODE_SCHEME_IDS) expect(codeColorsMode(id), id).toBe(id === 'none' ? 'plain' : 'syntax');
    expect(resolveScheme('none', '#a68bff').id).toBe('catppuccinMocha');
  });
});
