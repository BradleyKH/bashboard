import { formatClock } from './browserPaneModel';
import { ConsoleLog, type ConsoleEntry, type ConsoleLevel, type BrowserEvent } from './devtoolsModel';

const LEVEL_CHIPS: ReadonlyArray<[ConsoleLevel, string]> = [
  ['log', 'Log'],
  ['info', 'Info'],
  ['warn', 'Warnings'],
  ['error', 'Errors'],
];

export interface BrowserConsolePanelOptions {
  /** Entries or the error count changed (the toolbar badge follows). */
  onCountsChange: () => void;
}

/** The DevTools drawer's Console tab: the framed page's console output and uncaught exceptions. */
export class BrowserConsolePanel {
  readonly element: HTMLElement;
  private readonly log = new ConsoleLog();
  private readonly list: HTMLElement;
  private readonly filterInput: HTMLInputElement;
  private readonly preserveBox: HTMLInputElement;
  private readonly chips = new Map<ConsoleLevel, HTMLButtonElement>();
  private readonly levels = new Set<ConsoleLevel>(['log', 'info', 'warn', 'error', 'debug']);
  private readonly opts: BrowserConsolePanelOptions;
  private visible = false;
  /** Entries added since the last paint, appended on the next frame. */
  private pending: ConsoleEntry[] = [];
  private fullRender = true;
  private frame = 0;

  constructor(opts: BrowserConsolePanelOptions) {
    this.opts = opts;
    this.element = document.createElement('div');
    this.element.className = 'lb-panel lb-console';

    const bar = document.createElement('div');
    bar.className = 'lb-panel-bar';
    for (const [level, label] of LEVEL_CHIPS) {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = `lb-chip lb-chip-${level} active`;
      chip.textContent = label;
      chip.title = level === 'log' ? 'Show log and debug messages' : `Show ${label.toLowerCase()}`;
      chip.addEventListener('click', () => this.toggleLevel(level));
      this.chips.set(level, chip);
      bar.append(chip);
    }
    this.filterInput = document.createElement('input');
    this.filterInput.type = 'search';
    this.filterInput.className = 'lb-filter';
    this.filterInput.placeholder = 'Filter messages';
    this.filterInput.spellcheck = false;
    this.filterInput.addEventListener('input', () => this.refilter());

    const preserve = document.createElement('label');
    preserve.className = 'lb-check';
    preserve.title = 'Keep messages when the page navigates';
    this.preserveBox = document.createElement('input');
    this.preserveBox.type = 'checkbox';
    preserve.append(this.preserveBox, document.createTextNode('Preserve log'));

    const clear = document.createElement('button');
    clear.type = 'button';
    clear.className = 'lb-btn';
    clear.textContent = 'Clear';
    clear.title = 'Clear the console';
    clear.addEventListener('click', () => this.clear());

    bar.append(this.filterInput, preserve, clear);

    this.list = document.createElement('div');
    this.list.className = 'lb-console-list';
    this.element.append(bar, this.list);
  }

  add(ev: BrowserEvent): void {
    const entry = this.log.add(ev);
    if (!entry) return;
    // While hidden nothing paints, so showing again rebuilds from the log instead of queueing.
    if (this.visible && !this.fullRender) this.pending.push(entry);
    else this.fullRender = true;
    this.schedule();
    this.opts.onCountsChange();
  }

  /** The page's top frame navigated: a fresh page starts a fresh console unless Preserve log is on. */
  navigated(): void {
    if (!this.preserveBox.checked) this.clear();
  }

  clear(): void {
    this.log.clear();
    this.pending = [];
    this.fullRender = true;
    this.schedule();
    this.opts.onCountsChange();
  }

  errorCount(): number {
    return this.log.counts().error;
  }

  setVisible(visible: boolean): void {
    this.visible = visible;
    if (visible) this.schedule();
  }

  dispose(): void {
    cancelAnimationFrame(this.frame);
    this.frame = 0;
  }

  private toggleLevel(level: ConsoleLevel): void {
    const on = !this.levels.has(level);
    const affected: ConsoleLevel[] = level === 'log' ? ['log', 'debug'] : [level];
    for (const l of affected) {
      if (on) this.levels.add(l);
      else this.levels.delete(l);
    }
    this.chips.get(level)?.classList.toggle('active', on);
    this.refilter();
  }

  private refilter(): void {
    this.fullRender = true;
    this.schedule();
  }

  private matches(e: ConsoleEntry): boolean {
    const needle = this.filterInput.value.trim().toLowerCase();
    return this.levels.has(e.level) && (needle === '' || e.text.toLowerCase().includes(needle));
  }

  private schedule(): void {
    if (!this.visible || this.frame !== 0) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.paint();
    });
  }

  private paint(): void {
    const atBottom = this.list.scrollHeight - this.list.scrollTop - this.list.clientHeight < 8;
    if (this.fullRender) {
      this.fullRender = false;
      this.pending = [];
      const rows = this.log.filter({ levels: this.levels, text: this.filterInput.value }).map((e) => this.row(e));
      if (rows.length === 0) {
        const note = document.createElement('div');
        note.className = 'lb-empty';
        note.textContent = this.log.size === 0 ? 'No console messages.' : 'No messages match.';
        this.list.replaceChildren(note);
      } else {
        this.list.replaceChildren(...rows);
      }
    } else {
      const fresh = this.pending.filter((e) => this.matches(e));
      this.pending = [];
      if (fresh.length > 0) {
        this.list.querySelector('.lb-empty')?.remove();
        this.list.append(...fresh.map((e) => this.row(e)));
        // The log drops its oldest entries past its cap; drop their rows to match.
        const excess = this.list.childElementCount - this.log.size;
        for (let i = 0; i < excess; i++) this.list.firstElementChild?.remove();
      }
    }
    if (atBottom) this.list.scrollTop = this.list.scrollHeight;
  }

  private row(e: ConsoleEntry): HTMLElement {
    const el = document.createElement('div');
    el.className = `lb-log lb-log-${e.level}`;
    el.classList.toggle('lb-log-exception', e.exception);
    const time = document.createElement('span');
    time.className = 'lb-log-time';
    time.textContent = formatClock(e.timestamp);
    const text = document.createElement('span');
    text.className = 'lb-log-text';
    text.textContent = e.exception ? `Uncaught ${e.text}` : e.text;
    el.append(time, text);
    if (e.url) {
      const where = document.createElement('span');
      where.className = 'lb-log-source';
      const file = e.url.split(/[?#]/)[0].split('/').pop() || e.url;
      where.textContent = e.line !== undefined ? `${file}:${e.line}` : file;
      where.title = e.line !== undefined ? `${e.url}:${e.line}` : e.url;
      el.append(where);
    }
    return el;
  }
}
