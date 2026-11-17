import { CLI_COMMANDS, CLI_INTRO, CLI_OPTIONS, CLI_SECTIONS, entryFor, type CliEntry } from './cliReference';
import { copyText } from './copyText';

/**
 * The app dialog's CLI tab: the `bb` commands, their syntax, and copyable examples, in sections
 * laid out like the Settings tab's (docs/design/app.md section 3.13).
 */
export class CliTab {
  private root: HTMLElement | null = null;

  mount(host: HTMLElement): void {
    const root = document.createElement('div');
    root.className = 'cli-tab app-dialog-scroll';
    const intro = document.createElement('p');
    intro.className = 'cli-tab-intro';
    intro.textContent = `${CLI_INTRO} Commands that open a pane split the pane that ran them; relative paths resolve against the shell's folder.`;
    root.append(intro);
    for (const title of CLI_SECTIONS) {
      root.append(section(title, CLI_COMMANDS.filter((c) => c.section === title)));
    }
    root.append(section('Options', CLI_OPTIONS));
    host.append(root);
    this.root = root;
  }

  unmount(): void {
    this.root?.remove();
    this.root = null;
  }
}

function section(title: string, entries: CliEntry[]): HTMLElement {
  const el = document.createElement('section');
  const h = document.createElement('h3');
  h.textContent = title;
  const rows = document.createElement('div');
  rows.className = 'cli-tab-rows';
  rows.append(...entries.map((e) => entry(entryFor(e))));
  el.append(h, rows);
  return el;
}

function entry(e: CliEntry): HTMLElement {
  const el = document.createElement('div');
  el.className = 'cli-tab-entry';
  const usage = document.createElement('code');
  usage.className = 'cli-tab-usage';
  usage.textContent = e.usage;
  const summary = document.createElement('div');
  summary.className = 'cli-tab-summary';
  summary.textContent = `${e.summary}.`;
  const details = document.createElement('div');
  details.className = 'cli-tab-details';
  details.textContent = e.details;
  const examples = document.createElement('div');
  examples.className = 'cli-tab-examples';
  examples.append(...e.examples.map(example));
  el.append(usage, summary, details, examples);
  return el;
}

function example(text: string): HTMLElement {
  const chip = document.createElement('div');
  chip.className = 'cli-tab-example';
  const code = document.createElement('code');
  code.textContent = text;
  const copy = document.createElement('button');
  copy.type = 'button';
  copy.className = 'cli-tab-copy';
  copy.textContent = 'Copy';
  copy.title = `Copy "${text}"`;
  copy.addEventListener('click', () => void copyText(text, 'command'));
  chip.append(code, copy);
  return chip;
}
