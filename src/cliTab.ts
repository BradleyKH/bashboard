import { CLI_COMMANDS, CLI_INTRO, CLI_OPTIONS, type CliEntry } from './cliReference';
import { copyText } from './copyText';

/** The app dialog's CLI tab: the `bb` commands, their syntax, and copyable examples (docs/design/app.md section 3.13). */
export class CliTab {
  private root: HTMLElement | null = null;

  mount(host: HTMLElement): void {
    const root = document.createElement('div');
    root.className = 'cli-tab app-dialog-scroll';
    const intro = document.createElement('p');
    intro.textContent = `${CLI_INTRO} Commands that open a pane split the pane that ran them; relative paths resolve against the shell's folder.`;
    root.append(intro, section('Commands', CLI_COMMANDS), section('Options', CLI_OPTIONS));
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
  el.append(h, ...entries.map(entry));
  return el;
}

function entry(e: CliEntry): HTMLElement {
  const el = document.createElement('div');
  el.className = 'cli-tab-entry';
  const usage = document.createElement('code');
  usage.className = 'cli-tab-usage';
  usage.textContent = e.usage;
  const summary = document.createElement('div');
  summary.textContent = `${e.summary}. ${e.details}`;
  const examples = document.createElement('div');
  examples.className = 'cli-tab-examples';
  examples.append(...e.examples.map(example));
  el.append(usage, summary, examples);
  return el;
}

function example(text: string): HTMLElement {
  const row = document.createElement('div');
  row.className = 'cli-tab-example';
  const code = document.createElement('code');
  code.textContent = text;
  const copy = document.createElement('button');
  copy.type = 'button';
  copy.className = 'cli-tab-copy';
  copy.textContent = 'Copy';
  copy.title = `Copy "${text}"`;
  copy.addEventListener('click', () => void copyText(text, 'command'));
  row.append(code, copy);
  return row;
}
