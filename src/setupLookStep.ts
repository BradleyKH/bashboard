import { ACCENT_PRESETS } from './accent';
import { pickBackdropImage } from './backdrop/image/imagePick';
import { CONTENT_TEXT_MODES, contentTextColor } from './contentText';
import { SCRIM_PRESETS } from './scrim';
import type { BackdropStyle, Settings } from './settings';
import {
  backgroundColorSaves,
  scrimPresetFor,
  type AutoColors,
  type Choice,
  type SetupStepUi,
} from './setupModel';

export interface LookStepContext {
  ui: SetupStepUi;
  getSettings(): Settings;
  /** Saves one value; on failure the wizard shows the error and calls `revert`. */
  save(path: string[], value: unknown, revert: () => void): void;
  /** Shows an error that no save produced, such as a picker that failed to open. */
  fail(message: string): void;
  /** Whether the wizard turned the accent green for Matrix, kept across re-renders of the step. */
  autoColors: { get(): AutoColors; set(next: AutoColors): void };
}

const BACKGROUNDS: { value: BackdropStyle; label: string }[] = [
  { value: 'none', label: 'None' },
  { value: 'lights', label: 'Swirling Lights' },
  { value: 'matrix', label: 'Matrix' },
  { value: 'image', label: 'Image' },
  { value: 'slideshow', label: 'Slideshow' },
];

// Named for how bright the background shows through, matching the settings dialog's Brightness
// slider, which is 1 minus the scrim's opacity. Darkest first, as the slider runs.
const BRIGHTNESS: { preset: keyof typeof SCRIM_PRESETS; label: string }[] = [
  { preset: 'heavy', label: 'Low' },
  { preset: 'medium', label: 'Medium' },
  { preset: 'light', label: 'High' },
];

/**
 * The setup wizard's Look step: the background style (Image and Slideshow by way of the native
 * picker), how brightly it shows through the panes, whether it moves, and the accent and text
 * colors (docs/design/app.md section 4.17). Returns the function that shows a settings file's
 * values.
 */
export function renderLookStep(content: HTMLElement, ctx: LookStepContext): (s: Settings) => void {
  const { ui } = ctx;
  // The accent the controls show, ahead of the settings file catching up with a pick.
  let shownAccent = '';

  const backgrounds = pressGroup('Background', BACKGROUNDS, ui, (style) => {
    if (style === 'image' || style === 'slideshow') void pickPicture(style);
    else applyStyle(style);
  });

  function applyStyle(style: BackdropStyle): void {
    showStyle(style);
    ctx.save(['backdrop', 'style'], style, revert);
    const { saves, auto } = backgroundColorSaves(style, shownAccent, ctx.autoColors.get());
    ctx.autoColors.set(auto);
    for (const [, value] of saves) pickAccent(value, false);
  }

  // A picture style without a path draws nothing, so the style is saved only once the picker
  // returns one; cancelling leaves the background as it was.
  async function pickPicture(style: 'image' | 'slideshow'): Promise<void> {
    const key = style === 'image' ? 'file' : 'folder';
    let path: string | null;
    try {
      path = await pickBackdropImage(style === 'image' ? 'imageFile' : 'folder', ctx.getSettings().backdrop.image[key]);
    } catch (err) {
      ctx.fail(`Could not open the picker: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    if (path === null) return;
    ctx.save(['backdrop', 'image', key], path, revert);
    showPicked(style, path);
    applyStyle(style);
  }

  // The picked file or folder, with a way to pick again; fit and slideshow timing stay in the
  // Settings tab at their defaults.
  const picked = document.createElement('div');
  picked.className = 'setup-wizard-picked';
  const pickedPath = document.createElement('span');
  pickedPath.className = 'setup-wizard-note';
  let pickedStyle: 'image' | 'slideshow' = 'image';
  const change = ui.button('Change', () => void pickPicture(pickedStyle));
  picked.append(pickedPath, change);

  function showPicked(style: BackdropStyle, path: string): void {
    picked.hidden = style !== 'image' && style !== 'slideshow';
    if (picked.hidden) return;
    pickedStyle = style as 'image' | 'slideshow';
    const what = style === 'image' ? 'Picture' : 'Folder';
    pickedPath.textContent = path ? `${what}: ${path}` : `No ${what.toLowerCase()} picked yet`;
    pickedPath.title = path;
  }

  const animate = document.createElement('label');
  animate.className = 'setup-wizard-choice';
  const animateBox = document.createElement('input');
  animateBox.type = 'checkbox';
  animateBox.addEventListener('change', () => ctx.save(['backdrop', 'animate'], animateBox.checked, revert));
  const animateText = document.createElement('span');
  animateText.textContent = 'Animate the background';
  animate.append(animateBox, animateText);

  const brightness = pressGroup(
    'Brightness',
    BRIGHTNESS.map((b) => ({ value: b.preset, label: b.label })),
    ui,
    (preset) => {
      brightness.mark(preset);
      ctx.save(['scrim', 'opacity'], SCRIM_PRESETS[preset], revert);
    },
  );

  const accent = swatchGroup('Accent color', ACCENT_PRESETS, (value) => pickAccent(value, true));
  const text = swatchGroup('Text color', CONTENT_TEXT_MODES, (mode) => {
    text.mark(mode);
    ctx.save(['contentTextColor'], mode, revert);
  });

  function pickAccent(value: string, byUser: boolean): void {
    if (byUser) ctx.autoColors.set({ accent: false });
    showAccent(value);
    ctx.save(['accentColor'], value, revert);
  }

  // The Text color swatches are drawn from the accent, so they follow it.
  function showAccent(value: string): void {
    shownAccent = value;
    accent.mark(value);
    text.paint((mode) => contentTextColor(mode, value));
  }

  // None draws nothing, so there is nothing to animate or dim; a picture dims but never animates.
  function showStyle(style: BackdropStyle): void {
    backgrounds.mark(style);
    animate.hidden = style !== 'lights' && style !== 'matrix';
    brightness.group.hidden = style === 'none';
  }

  const sync = (s: Settings): void => {
    showStyle(s.backdrop.style);
    showPicked(s.backdrop.style, s.backdrop.style === 'image' ? s.backdrop.image.file : s.backdrop.image.folder);
    animateBox.checked = s.backdrop.animate;
    brightness.mark(scrimPresetFor(s.scrim.opacity));
    showAccent(s.accentColor);
    text.mark(s.contentTextColor);
  };
  function revert(): void {
    sync(ctx.getSettings());
  }

  content.append(backgrounds.group, picked, animate, brightness.group, accent.group, text.group);
  sync(ctx.getSettings());
  return sync;
}

interface Group<T extends string> {
  group: HTMLElement;
  mark(value: T | string | null): void;
}

interface SwatchGroup extends Group<string> {
  /** Recolors each swatch from its value, for swatches whose value is not itself a color. */
  paint(color: (value: string) => string): void;
}

function labelled(label: string): { group: HTMLElement; row: HTMLElement } {
  const group = document.createElement('div');
  group.className = 'setup-wizard-field';
  const heading = document.createElement('div');
  heading.className = 'setup-wizard-label';
  heading.textContent = label;
  const row = document.createElement('div');
  row.setAttribute('role', 'group');
  row.setAttribute('aria-label', label);
  group.append(heading, row);
  return { group, row };
}

/** Buttons of which one shows pressed. */
function pressGroup<T extends string>(
  label: string,
  options: { value: T; label: string }[],
  ui: SetupStepUi,
  onPick: (value: T) => void,
): Group<T> {
  const { group, row } = labelled(label);
  row.className = 'setup-wizard-presets';
  const buttons = options.map((o) => {
    const b = ui.button(o.label, () => onPick(o.value));
    b.dataset.value = o.value;
    return b;
  });
  row.append(...buttons);
  return {
    group,
    mark: (value) => {
      for (const b of buttons) b.setAttribute('aria-pressed', String(b.dataset.value === value));
    },
  };
}

/** Round color buttons, each named by its preset for screen readers and on hover. */
function swatchGroup(label: string, presets: Choice[], onPick: (value: string) => void): SwatchGroup {
  const { group, row } = labelled(label);
  row.className = 'setup-wizard-swatches';
  const buttons = presets.map((p) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'setup-wizard-swatch';
    b.style.background = p.value;
    b.title = p.label;
    b.setAttribute('aria-label', p.label);
    b.dataset.value = p.value;
    b.addEventListener('click', () => onPick(p.value));
    return b;
  });
  row.append(...buttons);
  return {
    group,
    mark: (value) => {
      const v = value?.toLowerCase();
      for (const b of buttons) b.setAttribute('aria-pressed', String(b.dataset.value?.toLowerCase() === v));
    },
    paint: (color) => {
      for (const b of buttons) b.style.background = color(b.dataset.value ?? '');
    },
  };
}
