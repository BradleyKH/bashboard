import { CodeColorsPreview } from './code/codeColorsPreview';
import { resolveScheme, type CodeScheme } from './code/schemes';
import { contentTextColor } from './contentText';
import type { Settings, SettingsPayload } from './settings';
import type { ShellProfile } from './profiles';
import { listEditors, type Editor } from './editors';
import { fontSuggestions, isSuggestionPick, listFonts } from './fonts';
import { appliesNote, installedChoices, isShown, matchesFilter, parseInput, readField, selectChoices, SETTINGS_SECTIONS, sliderPosition, type SettingsField } from './settingsModel';
import { primaryHeld } from './platform';

export interface SettingsTabCallbacks {
  onSave(path: string[], value: unknown): Promise<void>;
  onOpenFile(): Promise<void>;
  /** The shells the core can launch, for fields limited to installed options. */
  getProfiles(): ShellProfile[];
  /** Opens the native picker for a field's Browse button; null when cancelled. */
  onBrowse(kind: 'imageFile' | 'folder', current: string): Promise<string | null>;
}

const SLIDER_DEBOUNCE_MS = 250;
/** Settings the Code colors preview and its Match accent label are drawn from. */
const CODE_COLORS_INPUTS = ['codeColors.scheme', 'accentColor', 'contentTextColor', 'font.family'];
const DEFAULT_EDITOR: Editor = { id: 'default', name: "The file's default app" };

interface Control {
  field: SettingsField;
  /** The label and control cells' wrapper; full rows span both of the parent grid's columns, half rows one. */
  row: HTMLElement;
  sectionTitle: string;
  cell: HTMLElement;
  error: HTMLElement;
  /** The last value read from the file or sent to onSave; saves equal to it are skipped. */
  last: unknown;
  show(value: unknown): void;
  /** Slider only: a debounced save waiting to fire. */
  pending?: () => void;
  /** Typed inputs only: the current raw value, committed on close so Escape keeps an edit. */
  read?: () => string;
}

/** The app dialog's Settings tab; each control writes one value to settings.json (docs/design/data.md section 8). */
export class SettingsTab {
  private root: HTMLElement | null = null;
  private warnings: HTMLElement | null = null;
  private controls: Control[] = [];
  private sections: { el: HTMLElement; groups: HTMLElement[] }[] = [];
  private filter = '';
  private empty: HTMLElement | null = null;
  /** The last loaded file, for swatches drawn from other settings. */
  private settings: Settings | null = null;
  private fontList: HTMLDataListElement | null = null;
  private codeColors: { control: Control; preview: CodeColorsPreview } | null = null;
  /** The editors the core found; just `default` until the list arrives or when it cannot be read. */
  private editors: Editor[] = [DEFAULT_EDITOR];

  constructor(private readonly callbacks: SettingsTabCallbacks) {}

  isMounted(): boolean {
    return this.root !== null;
  }

  mount(host: HTMLElement, payload: SettingsPayload): void {
    if (this.root) this.unmount();
    const root = document.createElement('div');
    root.className = 'settings-tab';

    const warnings = document.createElement('div');
    warnings.className = 'settings-tab-warnings';
    warnings.setAttribute('role', 'status');
    this.warnings = warnings;

    const filter = document.createElement('input');
    filter.type = 'search';
    filter.className = 'settings-tab-filter';
    filter.placeholder = 'Filter settings';
    filter.spellcheck = false;
    filter.addEventListener('input', () => {
      this.filter = filter.value;
      this.applyVisibility();
    });
    this.filter = '';

    const body = document.createElement('div');
    body.className = 'settings-tab-body';
    this.controls = [];
    this.sections = [];
    for (const section of SETTINGS_SECTIONS) {
      const groups: HTMLElement[] = [];
      const el = document.createElement('section');
      const h = document.createElement('h3');
      h.textContent = section.title;
      const rows = document.createElement('div');
      rows.className = 'settings-tab-rows';
      let group: string | undefined;
      for (const field of section.fields) {
        if (field.group !== group) {
          group = field.group;
          if (group) {
            const sub = document.createElement('div');
            sub.className = 'settings-tab-group';
            sub.textContent = group;
            rows.append(sub);
            groups.push(sub);
          }
        }
        rows.append(this.row(field, section.title));
      }
      el.append(h, rows);
      body.append(el);
      this.sections.push({ el, groups });
    }
    const empty = document.createElement('p');
    empty.className = 'settings-tab-note';
    empty.textContent = 'No settings match.';
    empty.hidden = true;
    body.append(empty);
    this.empty = empty;
    root.append(filter, warnings, body, this.footer());
    host.append(root);
    this.root = root;
    this.update(payload);
    void this.loadEditors(root);
    void this.loadFonts(root);
  }

  private async loadFonts(owner: HTMLElement): Promise<void> {
    let found;
    try {
      found = await listFonts();
    } catch {
      return;
    }
    if (this.root !== owner || !this.fontList) return;
    this.fontList.replaceChildren(
      ...fontSuggestions(found).map((family) => {
        const option = document.createElement('option');
        option.value = family;
        return option;
      }),
    );
  }

  private async loadEditors(owner: HTMLElement): Promise<void> {
    try {
      const found = await listEditors();
      if (found.length > 0) this.editors = found;
    } catch {
      return;
    }
    if (this.root !== owner) return;
    const active = document.activeElement;
    for (const c of this.controls) {
      if (c.field.installedFrom !== 'editors' || (active && c.cell.contains(active))) continue;
      c.show(c.last);
    }
  }

  /** Refreshes from a reloaded file, leaving the control being edited alone. */
  update(payload: SettingsPayload): void {
    if (!this.root || !this.warnings) return;
    this.warnings.replaceChildren(
      ...payload.warnings.map((w) => {
        const p = document.createElement('p');
        p.textContent = w;
        return p;
      }),
    );
    this.warnings.hidden = payload.warnings.length === 0;
    this.settings = payload.settings;

    const active = document.activeElement;
    for (const c of this.controls) {
      if (c.pending || (active && c.cell.contains(active))) continue;
      const value = readField(payload.settings, c.field.path);
      c.last = value;
      c.show(value);
      setError(c, '');
    }
    this.applyVisibility();
    this.refreshCodeColors();
  }

  /** The loaded file with the controls' current values laid over the settings the preview reads. */
  private effectiveSettings(): Settings | null {
    const base = this.settings;
    if (!base) return null;
    const text = (path: string): string | undefined => {
      const v = this.controls.find((c) => c.field.path.join('.') === path)?.last;
      return typeof v === 'string' ? v : undefined;
    };
    return {
      ...base,
      accentColor: text('accentColor') ?? base.accentColor,
      contentTextColor: (text('contentTextColor') ?? base.contentTextColor) as Settings['contentTextColor'],
      font: { ...base.font, family: text('font.family') ?? base.font.family },
      codeColors: { scheme: (text('codeColors.scheme') ?? base.codeColors.scheme) as CodeScheme },
    };
  }

  /** Redraws the Code colors preview and renames the Match accent option from the controls' values. */
  private refreshCodeColors(): void {
    const cc = this.codeColors;
    const s = this.effectiveSettings();
    if (!cc || !s) return;
    const scheme = s.codeColors.scheme === 'none' ? null : resolveScheme(s.codeColors.scheme, s.accentColor);
    cc.preview.update(scheme, s.font.family, contentTextColor(s.contentTextColor, s.accentColor));
    // Rebuilding the options would close a dropdown that is open.
    if (!cc.control.cell.contains(document.activeElement)) cc.control.show(cc.control.last);
  }

  /**
   * Hides fields whose `shownWhen` doesn't hold, judged from each control's last saved value, and
   * fields the filter leaves out, then sections left with no field.
   */
  private applyVisibility(): void {
    const read = (path: string[]): unknown => this.controls.find((c) => c.field.path.join('.') === path.join('.'))?.last;
    for (const c of this.controls) {
      c.row.hidden = !isShown(c.field, read) || !matchesFilter(c.field, c.sectionTitle, this.filter);
    }
    const filtering = this.filter.trim() !== '';
    let any = false;
    for (const s of this.sections) {
      const shown = [...s.el.querySelectorAll<HTMLElement>('.settings-tab-row')].some((r) => !r.hidden);
      s.el.hidden = !shown;
      any ||= shown;
      // A group heading can't tell which of its rows survive, so filtered results drop them.
      for (const g of s.groups) g.hidden = filtering;
    }
    if (this.empty) this.empty.hidden = any;
  }

  /** Commits a pending slider or the focused input, then removes the tab. */
  unmount(): void {
    const active = document.activeElement;
    for (const c of this.controls) {
      c.pending?.();
      // Only the focused input can hold an edit that blur hasn't committed yet.
      if (c.read && active && c.cell.contains(active)) this.commit(c, c.read());
    }
    this.controls = [];
    this.fontList = null;
    this.codeColors = null;
    this.root?.remove();
    this.root = null;
    this.warnings = null;
    this.sections = [];
    this.empty = null;
  }

  private row(field: SettingsField, sectionTitle: string): HTMLElement {
    const id = `settings-${field.path.join('-')}`;

    const labelCell = document.createElement('div');
    labelCell.className = 'settings-tab-label';
    const label = document.createElement('label');
    label.htmlFor = id;
    label.textContent = field.label;
    labelCell.append(label);
    const noteText = [field.hint, appliesNote(field)].filter((s) => s).join('. ');
    const describedBy: string[] = [];
    if (noteText) {
      const note = document.createElement('div');
      note.className = 'settings-tab-note';
      note.id = `${id}-note`;
      note.textContent = noteText;
      labelCell.append(note);
      describedBy.push(note.id);
    }

    const cell = document.createElement('div');
    cell.className = 'settings-tab-control';
    const error = document.createElement('div');
    error.className = 'settings-tab-error';
    error.id = `${id}-error`;
    error.setAttribute('role', 'alert');
    error.hidden = true;
    describedBy.push(error.id);

    const row = document.createElement('div');
    row.className = 'settings-tab-row';
    if (field.half) row.classList.add('settings-tab-row-half');
    if (field.inline) row.classList.add('settings-tab-row-inline');
    row.append(labelCell, cell);

    const control: Control = { field, row, sectionTitle, cell, error, last: undefined, show: () => {} };
    const input = this.input(control);
    input.id = id;
    input.setAttribute('aria-describedby', describedBy.join(' '));
    cell.prepend(input);
    cell.append(error);
    this.controls.push(control);
    if (field.preview === 'codeColors') {
      const preview = new CodeColorsPreview();
      row.append(preview.el);
      this.codeColors = { control, preview };
    }
    return row;
  }

  /** Builds the field's input, wires its save trigger, and sets control.show. */
  private input(c: Control): HTMLElement {
    const f = c.field;
    if (f.kind === 'toggle') {
      const box = document.createElement('input');
      box.type = 'checkbox';
      box.className = 'settings-tab-toggle';
      box.addEventListener('change', () => this.commit(c, box.checked));
      c.show = (v) => (box.checked = v === true);
      // The whole row toggles. Clicks on the box or its <label> already toggle natively, so a
      // second click() there would undo them.
      c.row.classList.add('settings-tab-row-toggle');
      c.row.addEventListener('click', (e) => {
        const target = e.target as HTMLElement;
        if (target === box || target.closest('label')) return;
        box.click();
      });
      return box;
    }

    if (f.kind === 'select') {
      const sel = document.createElement('select');
      sel.className = 'settings-tab-input';
      // A customizable select (appearance: base-select) keeps markup inside options, and
      // <selectedcontent> copies the chosen option's swatch into the closed select.
      const head = f.swatches ? document.createElement('button') : null;
      if (head) {
        sel.classList.add('settings-tab-swatch-select');
        head.append(document.createElement('selectedcontent'));
      }
      const fill = (options: { value: string; label: string }[]): void => {
        sel.replaceChildren(
          ...(head ? [head] : []),
          ...options.map((o) => {
            const opt = document.createElement('option');
            opt.value = o.value;
            const named = f.optionLabel && f.options?.some((x) => x.value === o.value) ? this.effectiveSettings() : null;
            opt.textContent = named && f.optionLabel ? f.optionLabel(o.value, named) : o.label;
            if (head) {
              const swatch = document.createElement('span');
              swatch.className = 'settings-tab-swatch';
              swatch.style.background = f.swatchColor && this.settings ? f.swatchColor(o.value, this.settings) : o.value;
              opt.prepend(swatch);
            }
            return opt;
          }),
        );
      };
      sel.addEventListener('change', () => this.commit(c, sel.value));
      if (f.installedFrom) {
        const warn = document.createElement('div');
        warn.className = 'settings-tab-note';
        warn.hidden = true;
        c.cell.append(warn);
        c.show = (v) => {
          const installed = f.installedFrom === 'editors' ? this.editors : this.callbacks.getProfiles();
          const choices = installedChoices(f.options ?? [], installed, v, f.installedFrom);
          fill(choices.options);
          warn.textContent = choices.note ?? '';
          warn.hidden = !choices.note;
          if (typeof v === 'string') sel.value = v;
        };
      } else {
        c.show = (v) => {
          fill(selectChoices(f.options ?? [], v, f.unit));
          if (typeof v === 'string' || typeof v === 'number') sel.value = String(v);
        };
      }
      return sel;
    }

    if (f.kind === 'slider') {
      const range = document.createElement('input');
      range.type = 'range';
      range.className = 'settings-tab-slider';
      if (f.min !== undefined) range.min = String(f.min);
      if (f.max !== undefined) range.max = String(f.max);
      if (f.step !== undefined) range.step = String(f.step);
      const readout = document.createElement('span');
      readout.className = 'settings-tab-readout';
      readout.setAttribute('aria-hidden', 'true');
      let timer: number | undefined;
      const flush = (): void => {
        window.clearTimeout(timer);
        c.pending = undefined;
        this.commit(c, String(sliderPosition(f, Number(range.value))));
      };
      let dragging = false;
      range.addEventListener('input', () => {
        readout.textContent = formatSlider(f, Number(range.value));
        window.clearTimeout(timer);
        c.pending = flush;
        if (!dragging) timer = window.setTimeout(flush, SLIDER_DEBOUNCE_MS);
      });
      if (f.commitOnRelease) {
        range.addEventListener('pointerdown', () => {
          dragging = true;
        });
        const release = (): void => {
          if (!dragging) return;
          dragging = false;
          if (c.pending) flush();
        };
        range.addEventListener('pointerup', release);
        range.addEventListener('pointercancel', release);
        range.addEventListener('lostpointercapture', release);
        range.addEventListener('change', release);
      }
      c.show = (v) => {
        if (typeof v === 'number') range.value = String(sliderPosition(f, v));
        readout.textContent = formatSlider(f, Number(range.value));
      };
      c.cell.append(readout);
      return range;
    }

    if (f.kind === 'list') {
      const area = document.createElement('textarea');
      area.className = 'settings-tab-input settings-tab-list';
      area.rows = 3;
      area.spellcheck = false;
      area.addEventListener('blur', () => this.commit(c, area.value));
      area.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && primaryHeld(e)) {
          e.preventDefault();
          this.commit(c, area.value);
        }
      });
      c.show = (v) => (area.value = Array.isArray(v) ? v.join('\n') : '');
      c.read = () => area.value;
      return area;
    }

    const input = document.createElement('input');
    input.className = 'settings-tab-input';
    input.spellcheck = false;
    if (f.kind === 'number') {
      input.type = 'number';
      input.classList.add('settings-tab-number');
      if (f.min !== undefined) input.min = String(f.min);
      if (f.max !== undefined) input.max = String(f.max);
      if (f.step !== undefined) input.step = String(f.step);
      if (f.unit) {
        const unit = document.createElement('span');
        unit.className = 'settings-tab-unit';
        unit.textContent = f.unit;
        c.cell.append(unit);
      }
    } else {
      input.type = 'text';
      if (f.suggestFrom === 'fonts') {
        const list = document.createElement('datalist');
        list.id = 'settings-tab-font-suggestions';
        input.setAttribute('list', list.id);
        c.cell.append(list);
        this.fontList = list;
        input.addEventListener('input', (e) => {
          const options = Array.from(list.options, (o) => o.value);
          if (isSuggestionPick((e as InputEvent).inputType, input.value, options)) this.commit(c, input.value);
        });
      }
      const browseKind = f.browse;
      if (browseKind) {
        const browse = document.createElement('button');
        browse.type = 'button';
        browse.className = 'settings-tab-browse';
        browse.textContent = 'Browse';
        browse.addEventListener('click', () => {
          this.callbacks
            .onBrowse(browseKind, input.value)
            .then((picked) => {
              if (picked === null) return;
              input.value = picked;
              this.commit(c, picked);
            })
            .catch((err: unknown) => setError(c, errorText(err)));
        });
        c.cell.append(browse);
      }
    }
    input.addEventListener('blur', () => this.commit(c, input.value));
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        this.commit(c, input.value);
      }
    });
    c.show = (v) => (input.value = v === undefined || v === null ? '' : String(v));
    c.read = () => input.value;
    return input;
  }

  private commit(c: Control, raw: string | boolean): void {
    const parsed = parseInput(c.field, raw);
    if (!parsed.ok) {
      setError(c, parsed.error);
      return;
    }
    setError(c, '');
    if (JSON.stringify(parsed.value) === JSON.stringify(c.last)) return;
    const previous = c.last;
    c.last = parsed.value;
    this.applyVisibility();
    if (CODE_COLORS_INPUTS.includes(c.field.path.join('.'))) this.refreshCodeColors();
    this.callbacks.onSave(c.field.path, parsed.value).catch((err: unknown) => {
      setError(c, errorText(err));
      if (c.last !== parsed.value) return; // a later edit or reload superseded this one
      if (c.read) {
        // Keep the typed text for a retry, and forget the value so the same input saves again.
        c.last = undefined;
      } else {
        // Toggles and sliders show the file's value again, since nothing was written.
        c.last = previous;
        c.show(previous);
        this.applyVisibility();
        this.refreshCodeColors();
      }
    });
  }

  private footer(): HTMLElement {
    const footer = document.createElement('div');
    footer.className = 'settings-tab-footer';

    const actions = document.createElement('div');
    actions.className = 'settings-tab-actions';
    const open = document.createElement('button');
    open.type = 'button';
    open.className = 'settings-tab-open';
    open.textContent = 'Open settings.json';
    const error = document.createElement('span');
    error.className = 'settings-tab-error';
    error.setAttribute('role', 'alert');
    error.hidden = true;
    open.addEventListener('click', () => {
      error.hidden = true;
      this.callbacks.onOpenFile().catch((err: unknown) => {
        error.textContent = errorText(err);
        error.hidden = false;
      });
    });
    actions.append(open);
    actions.append(error);

    const note = document.createElement('p');
    note.className = 'settings-tab-note';
    note.textContent = 'Keyboard shortcuts are changed in the Shortcuts tab; keys that type text are added to the "keybindings" list in settings.json.';

    footer.append(actions, note);
    return footer;
  }
}

function setError(c: Control, message: string): void {
  c.error.textContent = message;
  c.error.hidden = message === '';
  c.cell.classList.toggle('invalid', message !== '');
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function formatSlider(field: SettingsField, value: number): string {
  const decimals = field.step !== undefined ? (String(field.step).split('.')[1] ?? '').length : 0;
  const text = value.toFixed(decimals);
  return field.unit ? `${text} ${field.unit}` : text;
}
