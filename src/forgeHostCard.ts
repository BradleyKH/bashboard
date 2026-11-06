import type { ConfirmOptions } from './confirmDialog';
import { copyText } from './copyText';
import {
  asForgeError,
  forgeAuthTest,
  forgeClearToken,
  forgeGhLogout,
  forgeGhSwitch,
  forgeGlabLogout,
  type AuthCheck,
  type HostAuth,
} from './forgeApi';
import {
  azureTestOrgs,
  azureTokenPageUrl,
  type AccountAction,
  type CardAction,
  type HostCard,
  type TokenAction,
} from './forgeAccountsModel';
import { AZURE_DEVOPS_SCOPE_INFO, BITBUCKET_SCOPE_INFO, scopePurposeText } from './shipModel';
import { ForgeTokenForm } from './forgeTokenForm';

export interface ForgeHostCardOptions {
  onRunTerminal(argv: string[]): void;
  onOpenUrl(url: string): void;
  confirm(options: ConfirmOptions): Promise<boolean>;
  /** A credential changed here; the tab reloads the status. */
  onChanged(): void;
  /** Azure DevOps organizations named by pinned repos and open Ship panes, normalized. */
  knownOrgs(): string[];
}

/** One code host's card in the Accounts tab: status, account rows, and every auth action (docs/design.md section 4.20). */
export class ForgeHostCard {
  readonly element: HTMLElement;
  private readonly head: HTMLElement;
  private readonly undetected: HTMLElement;
  private readonly status: HTMLElement;
  private readonly note: HTMLElement;
  private readonly accounts: HTMLElement;
  private readonly tokens: HTMLElement;
  private readonly actions: HTMLElement;
  private readonly formSlot: HTMLElement;
  private readonly result: HTMLElement;
  private readonly error: HTMLElement;
  private auth: HostAuth | null = null;
  private card: HostCard | null = null;
  private form: ForgeTokenForm | null = null;
  private busy = false;
  private credentialKey = '';

  constructor(private readonly options: ForgeHostCardOptions) {
    const el = document.createElement('section');
    el.className = 'accounts-card';
    this.head = document.createElement('h3');
    this.undetected = document.createElement('p');
    this.undetected.className = 'accounts-undetected';
    this.undetected.hidden = true;
    this.status = document.createElement('p');
    this.note = document.createElement('p');
    this.note.className = 'app-dialog-note';
    this.note.hidden = true;
    this.accounts = document.createElement('div');
    this.accounts.className = 'accounts-rows';
    this.tokens = document.createElement('div');
    this.tokens.className = 'accounts-rows';
    this.actions = document.createElement('div');
    this.actions.className = 'accounts-actions';
    this.formSlot = document.createElement('div');
    this.result = document.createElement('p');
    this.result.hidden = true;
    this.error = document.createElement('p');
    this.error.className = 'accounts-error';
    this.error.hidden = true;
    el.append(
      this.head,
      this.undetected,
      this.status,
      this.note,
      this.accounts,
      this.tokens,
      this.actions,
      this.formSlot,
      this.result,
      this.error,
    );
    this.element = el;
  }

  update(auth: HostAuth, card: HostCard): void {
    this.auth = auth;
    this.card = card;
    // A test line names credentials that may be gone after a reload (a removed token, a signed-out
    // account), so it only survives while the credentials are the ones it tested.
    const key = JSON.stringify([auth.tokenSource, auth.storedTokens.map((t) => t.org), card.accounts.map((a) => a.user)]);
    if (key !== this.credentialKey) {
      this.credentialKey = key;
      this.result.hidden = true;
    }
    this.head.textContent = card.title;
    this.element.classList.toggle('accounts-card-undetected', card.undetected !== null);
    if (card.tooltip) this.element.title = card.tooltip;
    else this.element.removeAttribute('title');
    this.undetected.textContent = card.undetected ?? '';
    this.undetected.hidden = card.undetected === null;
    this.status.className = `accounts-status accounts-${card.severity}`;
    this.status.textContent = card.status;
    this.note.textContent = card.note ?? '';
    this.note.hidden = card.note === null;
    this.accounts.replaceChildren(...card.accounts.map((row) => this.accountRow(row.user, row.active, row.actions)));
    this.accounts.hidden = card.accounts.length === 0;
    this.tokens.replaceChildren(...card.tokens.map((row) => this.tokenRow(row.org, row.actions)));
    this.tokens.hidden = card.tokens.length === 0;
    const buttons = card.actions.map((a) => this.actionButton(a));
    this.actions.replaceChildren(...buttons);
    this.actions.hidden = buttons.length === 0;
    // Only the token cards have a Copy scopes action, and they are the ones that need the list.
    this.element.querySelector('.accounts-scopes')?.remove();
    if (card.actions.some((a) => a.kind === 'copyScopes')) this.actions.after(this.scopeList());
  }

  isTokenFormOpen(): boolean {
    return this.form !== null;
  }

  /** Opens the token form; `org` prefills the Azure DevOps organization, else the first known one without a stored token. */
  openTokenForm(org?: string): void {
    const provider = this.auth?.provider;
    if (provider !== 'bitbucket' && provider !== 'azureDevOps') return;
    if (!this.form) {
      this.form = new ForgeTokenForm({
        provider,
        org: org ?? this.suggestedOrg(),
        onSaved: () => {
          this.closeTokenForm();
          this.options.onChanged();
        },
        onCancel: () => this.closeTokenForm(),
      });
      this.formSlot.append(this.form.element);
    } else if (org !== undefined) {
      this.form.setOrg(org);
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

  private suggestedOrg(): string | undefined {
    const stored = new Set(this.auth?.storedTokens.map((t) => t.org) ?? []);
    return this.options.knownOrgs().find((o) => !stored.has(o));
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

  private tokenRow(org: string, actions: TokenAction[]): HTMLElement {
    const row = document.createElement('div');
    row.className = 'accounts-row accounts-org';
    const name = document.createElement('span');
    name.className = 'accounts-user';
    name.textContent = org;
    const buttons = document.createElement('span');
    buttons.className = 'accounts-row-actions';
    for (const a of actions) buttons.append(this.button(a.label, () => this.tokenAction(a)));
    row.append(name, buttons);
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
    const azure = this.auth?.provider === 'azureDevOps';
    const el = document.createElement('div');
    el.className = 'accounts-scopes';
    const intro = document.createElement('p');
    intro.className = 'app-dialog-note';
    intro.textContent = azure
      ? 'Create the personal access token for one organization, with these scopes:'
      : 'Create the API token with these scopes:';
    const list = document.createElement('ul');
    for (const info of azure ? AZURE_DEVOPS_SCOPE_INFO : BITBUCKET_SCOPE_INFO) {
      const li = document.createElement('li');
      const code = document.createElement('code');
      code.textContent = info.scope;
      li.append(code, ` ${scopePurposeText(info)}`);
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

  private async tokenAction(a: TokenAction): Promise<void> {
    switch (a.kind) {
      case 'replaceToken':
        this.openTokenForm(a.org);
        break;
      case 'removeToken':
        await this.removeToken(a.org);
        break;
      case 'test':
        await this.testOrgs([a.org]);
        break;
    }
  }

  private async cardAction(a: CardAction): Promise<void> {
    if (!this.card || !this.auth) return;
    switch (a.kind) {
      case 'signIn':
      case 'installCli':
        this.options.onRunTerminal(a.argv);
        break;
      case 'signOut': {
        const ok = await this.options.confirm({
          title: `Sign @${a.user} out?`,
          body: [
            `Signs @${a.user} out of GitLab CLI on ${this.card.host}. Other apps that use glab lose this sign-in too.`,
          ],
          confirmLabel: 'Sign out',
        });
        if (!ok) return;
        await forgeGlabLogout(this.card.host);
        this.options.onChanged();
        break;
      }
      case 'addToken':
      case 'replaceToken':
        this.openTokenForm();
        break;
      case 'removeToken':
        await this.removeToken(null);
        break;
      case 'test':
        if (this.auth.provider === 'azureDevOps') {
          await this.testOrgs(azureTestOrgs(this.auth, this.options.knownOrgs()));
        } else {
          await this.test();
        }
        break;
      case 'openUrl':
        this.options.onOpenUrl(a.url);
        break;
      case 'openTokenPage': {
        const org = this.form?.org() || this.suggestedOrg() || this.auth.storedTokens.find((t) => t.org)?.org;
        if (!org) {
          // The page lives under an organization, so ask for one in the form's field.
          this.openTokenForm();
          throw new Error('Enter the organization first.');
        }
        this.options.onOpenUrl(azureTokenPageUrl(org));
        break;
      }
      case 'copyScopes':
        await copyText(a.text, 'scopes');
        break;
    }
  }

  /** Removes Bitbucket's token (`org` null) or one Azure DevOps organization's PAT, after a confirm. */
  private async removeToken(org: string | null): Promise<void> {
    if (!this.card || !this.auth) return;
    const ok = await this.options.confirm(
      org === null
        ? {
            title: 'Remove the Bitbucket token?',
            body: [
              `Deletes the API token Bashboard stored for ${this.card.host}. Bitbucket panes stop working until you add one again.`,
            ],
            confirmLabel: 'Remove token',
          }
        : {
            title: `Remove the token for ${org}?`,
            body: [
              `Deletes the personal access token Bashboard stored for the ${org} organization. Its Ship panes fall back to the next token source, if there is one.`,
            ],
            confirmLabel: 'Remove token',
          },
    );
    if (!ok) return;
    await forgeClearToken(this.auth.provider, org);
    this.options.onChanged();
  }

  private async test(user?: string): Promise<void> {
    if (!this.card || !this.auth) return;
    this.result.hidden = true;
    const check = await forgeAuthTest(this.auth.provider, this.card.host, user);
    this.showResult(check.ok, (user ? `@${user}: ` : '') + describeCheck(check, true));
  }

  /** One result line per Azure DevOps organization, so an organization-scoped PAT's gaps show. */
  private async testOrgs(orgs: string[]): Promise<void> {
    if (!this.card) return;
    this.result.hidden = true;
    if (orgs.length === 0) {
      this.showResult(false, 'Open an Azure DevOps repo first.');
      return;
    }
    const host = this.card.host;
    const lines = await Promise.all(
      orgs.map(async (org) => {
        try {
          const check = await forgeAuthTest('azureDevOps', host, undefined, org);
          return { ok: check.ok, text: `${org}: ${describeCheck(check, false)}` };
        } catch (err) {
          return { ok: false, text: `${org}: ${asForgeError(err).message}` };
        }
      }),
    );
    this.showResult(
      lines.every((l) => l.ok),
      lines.map((l) => l.text).join('\n'),
    );
  }

  private showResult(ok: boolean, text: string): void {
    this.result.className = ok ? 'accounts-test accounts-ok' : 'accounts-test accounts-test-failed';
    this.result.textContent = text;
    this.result.hidden = false;
  }
}

/** `handle` prefixes the login with @; Azure DevOps reports a display name, not a handle. */
function describeCheck(c: AuthCheck, handle: boolean): string {
  if (!c.ok) return c.message ?? 'The host rejected the credential.';
  const who = c.login ? `Signed in as ${handle ? '@' : ''}${c.login}` : 'The credential works';
  return c.scopes && c.scopes.length > 0 ? `${who}. Scopes: ${c.scopes.join(', ')}` : `${who}.`;
}
