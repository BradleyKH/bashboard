import type { Notice, NoticeAction, ScopeLine } from './forgeModel';

export interface ForgeNoticeHandlers {
  /** Runs `argv` in a new terminal pane. */
  onRunTerminal: (argv: string[]) => void;
  onOpenUrl: (url: string) => void;
  onCopy: (text: string, label: string) => void;
  /** Opens the account menu under `anchor`. */
  onPickAccount: (anchor: HTMLElement) => void;
  onRetry: () => void;
}

/** A line that is a settings snippet or a command rather than prose, drawn in a code block. */
function isCodeLine(line: string): boolean {
  return line.startsWith('"') || line.startsWith('{');
}

/** The in-pane setup guide for an error: what happened and the buttons for the next step (docs/design.md section 4.20). */
export class ForgeNotice {
  readonly el: HTMLElement;

  constructor(private readonly handlers: ForgeNoticeHandlers) {
    this.el = document.createElement('div');
    this.el.className = 'forge-notice';
  }

  set(notice: Notice): void {
    const parts: HTMLElement[] = [];
    const title = document.createElement('h3');
    title.className = 'forge-notice-title';
    title.textContent = notice.title;
    parts.push(title);

    for (const line of notice.body) {
      if (isCodeLine(line)) {
        const code = document.createElement('pre');
        code.className = 'forge-notice-code';
        code.textContent = line;
        parts.push(code);
      } else {
        const p = document.createElement('p');
        p.className = 'forge-notice-text';
        p.textContent = line;
        parts.push(p);
      }
    }

    const detail: HTMLElement[] = [];
    if (notice.steps.length > 0) detail.push(this.steps(notice.steps));
    if (notice.scopes.length > 0) detail.push(this.scopes(notice.scopes));
    if (detail.length > 0) {
      if (notice.collapsedLabel !== null) {
        const box = document.createElement('details');
        box.className = 'forge-notice-more';
        const summary = document.createElement('summary');
        summary.textContent = notice.collapsedLabel;
        box.append(summary, ...detail);
        parts.push(box);
      } else {
        parts.push(...detail);
      }
    }

    if (notice.actions.length > 0) {
      const row = document.createElement('div');
      row.className = 'forge-notice-actions';
      notice.actions.forEach((action, i) => row.append(this.button(action, i === 0)));
      parts.push(row);
    }
    this.el.replaceChildren(...parts);
  }

  private steps(steps: readonly string[]): HTMLElement {
    const ol = document.createElement('ol');
    ol.className = 'forge-notice-steps';
    for (const step of steps) {
      const li = document.createElement('li');
      li.textContent = step;
      ol.append(li);
    }
    return ol;
  }

  private scopes(scopes: readonly ScopeLine[]): HTMLElement {
    const ul = document.createElement('ul');
    ul.className = 'forge-notice-scopes';
    for (const s of scopes) {
      const li = document.createElement('li');
      const code = document.createElement('code');
      code.textContent = s.scope;
      li.append(code, ` ${s.purpose}`);
      ul.append(li);
    }
    return ul;
  }

  private button(action: NoticeAction, primary: boolean): HTMLButtonElement {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = primary ? 'forge-button primary' : 'forge-button';
    btn.textContent = action.label;
    btn.addEventListener('click', () => {
      switch (action.kind) {
        case 'runTerminal':
          this.handlers.onRunTerminal(action.argv);
          break;
        case 'openUrl':
          this.handlers.onOpenUrl(action.url);
          break;
        case 'copyText':
          this.handlers.onCopy(action.text, action.label);
          break;
        case 'pickAccount':
          this.handlers.onPickAccount(btn);
          break;
        case 'retry':
          this.handlers.onRetry();
          break;
      }
    });
    return btn;
  }
}
