import { asForgeError, forgeSetToken } from './forgeApi';
import { normalizeOrg } from './forgeAccountsModel';

/** The providers whose token Bashboard stores itself. */
export type TokenProvider = 'bitbucket' | 'azureDevOps';

export interface ForgeTokenFormOptions {
  provider: TokenProvider;
  /** Prefills the Azure DevOps organization field. */
  org?: string;
  /** The token was stored. */
  onSaved(): void;
  onCancel(): void;
}

/**
 * Password field for a Bitbucket API token or an Azure DevOps personal access token, plus the
 * organization for Azure DevOps (docs/design.md section 4.20). The value goes to the core once, as
 * the argument of `forgeSetToken`; it is never logged or kept, and the field is emptied on every
 * path out, success or not.
 */
export class ForgeTokenForm {
  readonly element: HTMLFormElement;
  private readonly orgInput: HTMLInputElement | null;
  private readonly input: HTMLInputElement;
  private readonly save: HTMLButtonElement;
  private readonly cancel: HTMLButtonElement;
  private readonly error: HTMLElement;
  private busy = false;

  constructor(private readonly options: ForgeTokenFormOptions) {
    const azure = options.provider === 'azureDevOps';
    const form = document.createElement('form');
    form.className = 'accounts-token-form';
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      void this.submit();
    });

    let orgRow: HTMLElement | null = null;
    this.orgInput = null;
    if (azure) {
      const org = document.createElement('input');
      org.type = 'text';
      org.className = 'accounts-token-input accounts-org-input';
      org.autocomplete = 'off';
      org.spellcheck = false;
      org.required = true;
      org.placeholder = 'Organization';
      org.setAttribute('aria-label', 'Azure DevOps organization');
      org.value = options.org ?? '';
      const label = document.createElement('label');
      label.className = 'accounts-org-row';
      const text = document.createElement('span');
      text.textContent = 'dev.azure.com/';
      label.append(text, org);
      orgRow = label;
      this.orgInput = org;
    }

    const input = document.createElement('input');
    input.type = 'password';
    input.className = 'accounts-token-input';
    input.autocomplete = 'off';
    input.spellcheck = false;
    input.placeholder = azure ? 'Paste a personal access token' : 'Paste an API token';
    input.setAttribute('aria-label', azure ? 'Azure DevOps personal access token' : 'Bitbucket API token');

    const save = document.createElement('button');
    save.type = 'submit';
    save.className = 'app-dialog-button';
    save.textContent = 'Save';
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'app-dialog-button';
    cancel.textContent = 'Cancel';
    cancel.addEventListener('click', () => this.options.onCancel());

    const row = document.createElement('div');
    row.className = 'accounts-token-row';
    row.append(input, save, cancel);

    const hint = document.createElement('p');
    hint.className = 'app-dialog-note';
    hint.append('Or store it from a terminal with ');
    const code = document.createElement('code');
    code.textContent = azure ? 'bb auth azure-devops <org>' : 'bb auth bitbucket';
    hint.append(code, '.');

    const error = document.createElement('p');
    error.className = 'accounts-error';
    error.hidden = true;

    if (orgRow) form.append(orgRow);
    form.append(row, hint, error);
    this.element = form;
    this.input = input;
    this.save = save;
    this.cancel = cancel;
    this.error = error;
  }

  focus(): void {
    // An empty organization field comes first, since the token cannot be saved without it.
    if (this.orgInput && !this.orgInput.value.trim()) this.orgInput.focus();
    else this.input.focus();
  }

  /** The organization typed so far, normalized; empty for Bitbucket. */
  org(): string {
    return this.orgInput ? normalizeOrg(this.orgInput.value) : '';
  }

  /** Replaces the organization field's value, when there is one. */
  setOrg(org: string): void {
    if (this.orgInput) this.orgInput.value = org;
  }

  /** Empties the field and any error; the card calls this when the form closes. */
  clear(): void {
    this.input.value = '';
    this.error.hidden = true;
    this.error.textContent = '';
  }

  private async submit(): Promise<void> {
    if (this.busy) return;
    const token = this.input.value.trim();
    this.input.value = '';
    const org = this.orgInput ? this.org() : null;
    if (this.orgInput && !org) {
      this.showError('Enter the organization first.');
      this.orgInput.focus();
      return;
    }
    if (!token) {
      this.showError('Paste a token first.');
      return;
    }
    if (this.orgInput && org) this.orgInput.value = org;
    this.setBusy(true);
    this.error.hidden = true;
    try {
      await forgeSetToken(this.options.provider, org, token);
    } catch (err) {
      this.showError(asForgeError(err).message);
      return;
    } finally {
      this.setBusy(false);
    }
    this.options.onSaved();
  }

  private showError(message: string): void {
    this.error.textContent = message;
    this.error.hidden = false;
  }

  private setBusy(busy: boolean): void {
    this.busy = busy;
    this.save.disabled = busy;
    this.cancel.disabled = busy;
    this.input.disabled = busy;
    if (this.orgInput) this.orgInput.disabled = busy;
  }
}
