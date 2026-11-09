/** Code color schemes and their pairing with the accent presets (docs/design/files.md section 4.22). */

import { ACCENT_PRESETS } from '../accent';
import { ROLES, type Role } from './roles';

export const CODE_SCHEME_IDS = [
  'matchAccent',
  'nord',
  'ayu',
  'gruvbox',
  'monokai',
  'tokyoNight',
  'oneDark',
  'catppuccinMocha',
  'dracula',
] as const;

/** `codeColors.scheme`: Match accent or one scheme's id. Mirrors the ids src-tauri accepts. */
export type CodeScheme = (typeof CODE_SCHEME_IDS)[number];

export type SchemeId = Exclude<CodeScheme, 'matchAccent'>;

export const DEFAULT_CODE_SCHEME: CodeScheme = 'matchAccent';

export interface Scheme {
  id: SchemeId;
  label: string;
  /** The accent preset label this scheme pairs with under Match accent. */
  pairsWith: string;
  colors: Record<Role, string>;
}

// Colors are the upstream dark palettes. A trailing comment names the upstream value where it was
// lifted (lightness raised, hue and saturation kept) to reach 4.5:1 against #1e1e1e.
export const SCHEMES: readonly Scheme[] = [
  {
    id: 'nord',
    label: 'Nord',
    pairsWith: 'Silver',
    colors: {
      keyword: '#81a1c1',
      string: '#a3be8c',
      escape: '#ebcb8b',
      constant: '#b48ead',
      comment: '#7a86a0', // #616e88
      function: '#88c0d0',
      type: '#8fbcbb',
      property: '#8fbcbb',
      tag: '#81a1c1',
      attribute: '#8fbcbb',
      meta: '#d08770',
    },
  },
  {
    id: 'ayu',
    label: 'Ayu',
    pairsWith: 'Orange',
    colors: {
      keyword: '#ff8f40',
      string: '#aad94c',
      escape: '#95e6cb',
      constant: '#d2a6ff',
      comment: '#798796', // #5a6673
      function: '#ffb454',
      type: '#59c2ff',
      property: '#f07178',
      tag: '#39bae6',
      attribute: '#ffb454',
      meta: '#e6c08a',
    },
  },
  {
    id: 'gruvbox',
    label: 'Gruvbox',
    pairsWith: 'Gold',
    colors: {
      keyword: '#fb4934',
      string: '#b8bb26',
      escape: '#d3869b',
      constant: '#fe8019',
      comment: '#928374',
      function: '#8ec07c',
      type: '#fabd2f',
      property: '#83a598',
      tag: '#83a598',
      attribute: '#8ec07c',
      meta: '#8ec07c',
    },
  },
  {
    id: 'monokai',
    label: 'Monokai',
    pairsWith: 'Green',
    colors: {
      keyword: '#f92d77', // #f92672
      string: '#e6db74',
      escape: '#ae81ff',
      constant: '#ae81ff',
      comment: '#8c8770', // #75715e
      function: '#a6e22e',
      type: '#66d9ef',
      property: '#66d9ef',
      tag: '#f92d77', // #f92672
      attribute: '#a6e22e',
      meta: '#fd971f',
    },
  },
  {
    id: 'tokyoNight',
    label: 'Tokyo Night',
    pairsWith: 'Teal',
    colors: {
      keyword: '#bb9af7',
      string: '#9ece6a',
      escape: '#89ddff',
      constant: '#ff9e64',
      comment: '#7b83ac', // #565f89
      function: '#7aa2f7',
      type: '#2ac3de',
      property: '#73daca',
      tag: '#f7768e',
      attribute: '#bb9af7',
      meta: '#e0af68',
    },
  },
  {
    id: 'oneDark',
    label: 'One Dark',
    pairsWith: 'Blue',
    colors: {
      keyword: '#c678dd',
      string: '#98c379',
      escape: '#56b6c2',
      constant: '#d19a66',
      comment: '#7e8695', // #5c6370
      function: '#61afef',
      type: '#e5c07b',
      property: '#e06c75',
      tag: '#e06c75',
      attribute: '#d19a66',
      meta: '#56b6c2',
    },
  },
  {
    id: 'catppuccinMocha',
    label: 'Catppuccin Mocha',
    pairsWith: 'Violet',
    colors: {
      keyword: '#cba6f7',
      string: '#a6e3a1',
      escape: '#f5c2e7',
      constant: '#fab387',
      comment: '#9399b2',
      function: '#89b4fa',
      type: '#f9e2af',
      property: '#b4befe',
      tag: '#89b4fa',
      attribute: '#f9e2af',
      meta: '#f2cdcd',
    },
  },
  {
    id: 'dracula',
    label: 'Dracula',
    pairsWith: 'Pink',
    colors: {
      keyword: '#ff79c6',
      string: '#f1fa8c',
      escape: '#ff5555',
      constant: '#bd93f9',
      comment: '#7785b0', // #6272a4
      function: '#50fa7b',
      type: '#8be9fd',
      property: '#8be9fd',
      tag: '#ff79c6',
      attribute: '#50fa7b',
      meta: '#ffb86c',
    },
  },
];

/** Upstream credits for the About tab; every palette is MIT-licensed. */
export const SCHEME_CREDITS: Record<SchemeId, { name: string; url: string; license: 'MIT' }> = {
  nord: { name: 'Nord', url: 'https://github.com/nordtheme/nord', license: 'MIT' },
  ayu: { name: 'ayu', url: 'https://github.com/ayu-theme/ayu-colors', license: 'MIT' },
  gruvbox: { name: 'gruvbox', url: 'https://github.com/morhetz/gruvbox', license: 'MIT' },
  // Classic Monokai by Wimer Hazenberg, credited through an MIT port; not the commercial Monokai Pro.
  monokai: { name: 'Monokai (vim-monokai port)', url: 'https://github.com/ku1ik/vim-monokai', license: 'MIT' },
  tokyoNight: { name: 'Tokyo Night', url: 'https://github.com/tokyo-night/tokyo-night-vscode-theme', license: 'MIT' },
  oneDark: { name: 'One Dark (Atom)', url: 'https://github.com/atom/one-dark-syntax', license: 'MIT' },
  catppuccinMocha: { name: 'Catppuccin', url: 'https://github.com/catppuccin/catppuccin', license: 'MIT' },
  dracula: { name: 'Dracula', url: 'https://github.com/dracula/dracula-theme', license: 'MIT' },
};

const BY_ID = new Map(SCHEMES.map((s) => [s.id, s]));

function schemeById(id: SchemeId): Scheme {
  return BY_ID.get(id) as Scheme;
}

/** HSV hue in degrees and saturation in 0..1 of a #rrggbb color. */
function hueSat(hex: string): { hue: number; sat: number } {
  const n = parseInt(hex.slice(1, 7), 16);
  const r = ((n >> 16) & 0xff) / 255;
  const g = ((n >> 8) & 0xff) / 255;
  const b = (n & 0xff) / 255;
  const max = Math.max(r, g, b);
  const d = max - Math.min(r, g, b);
  const sat = max === 0 ? 0 : d / max;
  let hue = 0;
  if (d > 0) {
    if (max === r) hue = ((g - b) / d + 6) % 6;
    else if (max === g) hue = (b - r) / d + 2;
    else hue = (r - g) / d + 4;
  }
  return { hue: hue * 60, sat };
}

const LOW_SATURATION = 0.2;

/** The scheme Match accent picks for an accent: its preset's, else the nearest preset hue's. */
export function pairedScheme(accentHex: string): Scheme {
  const { hue, sat } = hueSat(accentHex.toLowerCase());
  if (sat < LOW_SATURATION) return schemeById('nord');
  const exact = ACCENT_PRESETS.find((p) => p.value.toLowerCase() === accentHex.toLowerCase());
  const pairOf = (label: string) => SCHEMES.find((s) => s.pairsWith === label);
  if (exact) {
    const s = pairOf(exact.label);
    if (s) return s;
  }
  let best: Scheme = schemeById('nord');
  let bestDist = Infinity;
  for (const preset of ACCENT_PRESETS) {
    const p = hueSat(preset.value);
    // Silver's hue is noise at its saturation, so it never wins on hue.
    if (p.sat < LOW_SATURATION) continue;
    const raw = Math.abs(p.hue - hue);
    const dist = Math.min(raw, 360 - raw);
    const s = pairOf(preset.label);
    if (s && dist < bestDist) {
      best = s;
      bestDist = dist;
    }
  }
  return best;
}

/** The concrete scheme for the `codeColors.scheme` setting. */
export function resolveScheme(setting: CodeScheme, accentHex: string): Scheme {
  return (setting !== 'matchAccent' && BY_ID.get(setting)) || pairedScheme(accentHex);
}

export function applyScheme(root: { style: { setProperty(name: string, value: string): void } }, scheme: Scheme): void {
  for (const role of ROLES) root.style.setProperty(`--syn-${role}`, scheme.colors[role]);
}
