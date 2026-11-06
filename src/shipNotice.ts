import { scopePurposeText, type Notice, type NoticeAction, type ScopeLine } from './shipModel';

export interface ShipNoticeHandlers {
  /** Runs `argv` in a new terminal pane. */
  onRunTerminal: (argv: string[]) => void;
  onOpenUrl: (url: string) => void;
  onCopy: (text: string, label: string) => void;
  /** Opens the account menu under `anchor`. */
  onPickAccount: (anchor: HTMLElement) => void;
  /** Opens the Accounts tab on `host`, with the token form open when asked. */
  onOpenAccounts: (host: string, opts?: { openTokenForm?: boolean; org?: string }) => void;
  onRetry: () => void;
}

/** A line that is a settings snippet or a command rather than prose, drawn in a code block. */
function isCodeLine(line: string): boolean {
  return line.startsWith('"') || line.startsWith('{');
}

/** The in-pane setup guide for an error: what happened and the buttons for the next step (docs/design.md section 4.20). */
export class ShipNotice {
  readonly el: HTMLElement;

  constructor(private readonly handlers: ShipNoticeHandlers) {
    this.el = document.createElement('div');
    this.el.className = 'ship-notice';
  }

  set(notice: Notice): void {
    const parts: HTMLElement[] = [];
    const title = document.createElement('h3');
    title.className = 'ship-notice-title';
    title.textContent = notice.title;
    parts.push(title);

    for (const line of notice.body) {
      if (isCodeLine(line)) {
        const code = document.createElement('pre');
        code.className = 'ship-notice-code';
        code.textContent = line;
        parts.push(code);
      } else {
        const p = document.createElement('p');
        p.className = 'ship-notice-text';
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
        box.className = 'ship-notice-more';
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
      row.className = 'ship-notice-actions';
      notice.actions.forEach((action, i) => row.append(this.button(action, i === 0)));
      parts.push(row);
    }
    this.el.replaceChildren(...parts);
  }

  private steps(steps: readonly string[]): HTMLElement {
    const ol = document.createElement('ol');
    ol.className = 'ship-notice-steps';
    for (const step of steps) {
      const li = document.createElement('li');
      li.textContent = step;
      ol.append(li);
    }
    return ol;
  }

  private scopes(scopes: readonly ScopeLine[]): HTMLElement {
    const ul = document.createElement('ul');
    ul.className = 'ship-notice-scopes';
    for (const s of scopes) {
      const li = document.createElement('li');
      const code = document.createElement('code');
      code.textContent = s.scope;
      li.append(code, ` ${scopePurposeText(s)}`);
      ul.append(li);
    }
    return ul;
  }

  private button(action: NoticeAction, primary: boolean): HTMLButtonElement {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = primary ? 'ship-button primary' : 'ship-button';
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
        case 'openAccounts':
          this.handlers.onOpenAccounts(action.host, { openTokenForm: action.openTokenForm, org: action.org });
          break;
        case 'retry':
          this.handlers.onRetry();
          break;
      }
    });
    return btn;
  }
}
