import type { ConfirmOptions } from './confirmDialog';
import { copyText } from './copyText';
import {
  asForgeError,
  forgeAuthTest,
  forgeBitbucketClearToken,
  forgeGhLogout,
  forgeGhSwitch,
  type AuthCheck,
  type AuthProvider,
} from './forgeApi';
import type { AccountAction, CardAction, HostCard } from './forgeAccountsModel';
import { BITBUCKET_SCOPE_INFO } from './shipModel';
import { ForgeTokenForm } from './forgeTokenForm';

export interface ForgeHostCardOptions {
  onRunTerminal(argv: string[]): void;
  onOpenUrl(url: string): void;
  confirm(options: ConfirmOptions): Promise<boolean>;
  /** A credential changed here; the tab reloads the status. */
  onChanged(): void;
}

/** One code host's card in the Accounts tab: status, account rows, and every auth action (docs/design.md section 4.20). */
export class ForgeHostCard {
  readonly element: HTMLElement;
  private readonly head: HTMLElement;
  private readonly status: HTMLElement;
  private readonly note: HTMLElement;
  private readonly accounts: HTMLElement;
  private readonly actions: HTMLElement;
  private readonly formSlot: HTMLElement;
  private readonly result: HTMLElement;
  private readonly error: HTMLElement;
  private card: HostCard | null = null;
  private form: ForgeTokenForm | null = null;
  private busy = false;

  constructor(
    private readonly provider: AuthProvider,
    private readonly options: ForgeHostCardOptions,
  ) {
    const el = document.createElement('section');
    el.className = 'accounts-card';
    this.head = document.createElement('h3');
    this.status = document.createElement('p');
    this.note = document.createElement('p');
    this.note.className = 'app-dialog-note';
    this.note.hidden = true;
    this.accounts = document.createElement('div');
    this.accounts.className = 'accounts-rows';
    this.actions = document.createElement('div');
    this.actions.className = 'accounts-actions';
    this.formSlot = document.createElement('div');
    this.result = document.createElement('p');
    this.result.hidden = true;
    this.error = document.createElement('p');
    this.error.className = 'accounts-error';
    this.error.hidden = true;
    el.append(this.head, this.status, this.note, this.accounts, this.actions, this.formSlot, this.result, this.error);
    this.element = el;
  }

  update(card: HostCard): void {
    this.card = card;
    this.head.textContent = card.title;
    this.status.className = `accounts-status accounts-${card.severity}`;
    this.status.textContent = card.status;
    this.note.textContent = card.note ?? '';
    this.note.hidden = card.note === null;
    this.accounts.replaceChildren(...card.accounts.map((row) => this.accountRow(row.user, row.active, row.actions)));
    const buttons = card.actions.map((a) => this.actionButton(a));
    this.actions.replaceChildren(...buttons);
    this.actions.hidden = buttons.length === 0;
    // Only the Bitbucket card has a Copy scopes action, and it is the one that needs the list.
    this.element.querySelector('.accounts-scopes')?.remove();
    if (card.actions.some((a) => a.kind === 'copyScopes')) this.actions.after(this.scopeList());
  }

  isTokenFormOpen(): boolean {
    return this.form !== null;
  }

  openTokenForm(): void {
    if (!this.form) {
      this.form = new ForgeTokenForm({
        onSaved: () => {
          this.closeTokenForm();
          this.options.onChanged();
        },
        onCancel: () => this.closeTokenForm(),
      });
      this.formSlot.append(this.form.element);
    }
    this.form.focus();
  }

  closeTokenForm(): void {
    if (!this.form) return;
    this.form.clear();
    this.form.element.remove();
    this.form = null;
  }

  dispose(): void {
    this.closeTokenForm();
    this.element.remove();
  }

  private accountRow(user: string, active: boolean, actions: AccountAction[]): HTMLElement {
    const row = document.createElement('div');
    row.className = 'accounts-row';
    const name = document.createElement('span');
    name.className = 'accounts-user';
    name.textContent = `@${user}`;
    row.append(name);
    if (active) {
      const badge = document.createElement('span');
      badge.className = 'accounts-badge';
      badge.textContent = 'Active';
      row.append(badge);
    }
    const buttons = document.createElement('span');
    buttons.className = 'accounts-row-actions';
    for (const a of actions) buttons.append(this.button(a.label, () => this.accountAction(a)));
    row.append(buttons);
    return row;
  }

  private actionButton(action: CardAction): HTMLButtonElement {
    return this.button(action.label, () => this.cardAction(action));
  }

  private button(label: string, run: () => Promise<void> | void): HTMLButtonElement {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'app-dialog-button';
    b.textContent = label;
    b.disabled = this.busy;
    b.addEventListener('click', () => void this.guarded(run));
    return b;
  }

  private scopeList(): HTMLElement {
    const el = document.createElement('div');
    el.className = 'accounts-scopes';
    const intro = document.createElement('p');
    intro.className = 'app-dialog-note';
    intro.textContent = 'Create the API token with these scopes:';
    const list = document.createElement('ul');
    for (const { scope, purpose } of BITBUCKET_SCOPE_INFO) {
      const li = document.createElement('li');
      const code = document.createElement('code');
      code.textContent = scope;
      li.append(code, ` to ${purpose}`);
      list.append(li);
    }
    el.append(intro, list);
    return el;
  }

  /** Runs one action with every button disabled; a failure shows inline. */
  private async guarded(run: () => Promise<void> | void): Promise<void> {
    if (this.busy) return;
    this.setBusy(true);
    this.error.hidden = true;
    try {
      await run();
    } catch (err) {
      this.error.textContent = asForgeError(err).message;
      this.error.hidden = false;
    } finally {
      this.setBusy(false);
    }
  }

  private setBusy(busy: boolean): void {
    this.busy = busy;
    for (const b of this.element.querySelectorAll<HTMLButtonElement>('.accounts-rows button, .accounts-actions button')) {
      b.disabled = busy;
    }
  }

  private async accountAction(a: AccountAction): Promise<void> {
    if (!this.card) return;
    const host = this.card.host;
    if (a.kind === 'makeActive') {
      await forgeGhSwitch(host, a.user);
      this.options.onChanged();
    } else if (a.kind === 'signOut') {
      const ok = await this.options.confirm({
        title: `Sign @${a.user} out?`,
        body: [`Signs @${a.user} out of GitHub CLI on ${host}. Other apps that use gh lose this account too.`],
        confirmLabel: 'Sign out',
      });
      if (!ok) return;
      await forgeGhLogout(host, a.user);
      this.options.onChanged();
    } else {
      await this.test(a.user);
    }
  }

  private async cardAction(a: CardAction): Promise<void> {
    if (!this.card) return;
    switch (a.kind) {
      case 'signIn':
      case 'installGh':
        this.options.onRunTerminal(a.argv);
        break;
      case 'addToken':
      case 'replaceToken':
        this.openTokenForm();
        break;
      case 'removeToken': {
        const ok = await this.options.confirm({
          title: 'Remove the Bitbucket token?',
          body: [`Deletes the API token Bashboard stored for ${this.card.host}. Bitbucket panes stop working until you add one again.`],
          confirmLabel: 'Remove token',
        });
        if (!ok) return;
        await forgeBitbucketClearToken();
        this.options.onChanged();
        break;
      }
      case 'test':
        await this.test();
        break;
      case 'openUrl':
        this.options.onOpenUrl(a.url);
        break;
      case 'copyScopes':
        await copyText(a.text, 'scopes');
        break;
    }
  }

  private async test(user?: string): Promise<void> {
    if (!this.card) return;
    this.result.hidden = true;
    const check = await forgeAuthTest(this.provider, this.card.host, user);
    this.result.className = check.ok ? 'accounts-test accounts-ok' : 'accounts-test accounts-test-failed';
    this.result.textContent = (user ? `@${user}: ` : '') + describeCheck(check);
    this.result.hidden = false;
  }
}

function describeCheck(c: AuthCheck): string {
  if (!c.ok) return c.message ?? 'The host rejected the credential.';
  const who = c.login ? `Signed in as @${c.login}` : 'The credential works';
  return c.scopes && c.scopes.length > 0 ? `${who}. Scopes: ${c.scopes.join(', ')}` : `${who}.`;
}
