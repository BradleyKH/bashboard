import { asForgeError, forgeBitbucketSetToken } from './forgeApi';

export interface ForgeTokenFormOptions {
  /** The token was stored. */
  onSaved(): void;
  onCancel(): void;
}

/**
 * Password field for a Bitbucket API token (docs/design.md section 4.20). The value goes to the core
 * once, as the argument of `forgeBitbucketSetToken`; it is never logged or kept, and the field is
 * emptied on every path out, success or not.
 */
export class ForgeTokenForm {
  readonly element: HTMLFormElement;
  private readonly input: HTMLInputElement;
  private readonly save: HTMLButtonElement;
  private readonly cancel: HTMLButtonElement;
  private readonly error: HTMLElement;
  private busy = false;

  constructor(private readonly options: ForgeTokenFormOptions) {
    const form = document.createElement('form');
    form.className = 'accounts-token-form';
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      void this.submit();
    });

    const input = document.createElement('input');
    input.type = 'password';
    input.className = 'accounts-token-input';
    input.autocomplete = 'off';
    input.spellcheck = false;
    input.placeholder = 'Paste an API token';
    input.setAttribute('aria-label', 'Bitbucket API token');

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
    code.textContent = 'bb auth bitbucket';
    hint.append(code, '.');

    const error = document.createElement('p');
    error.className = 'accounts-error';
    error.hidden = true;

    form.append(row, hint, error);
    this.element = form;
    this.input = input;
    this.save = save;
    this.cancel = cancel;
    this.error = error;
  }

  focus(): void {
    this.input.focus();
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
    if (!token) {
      this.showError('Paste a token first.');
      return;
    }
    this.setBusy(true);
    this.error.hidden = true;
    try {
      await forgeBitbucketSetToken(token);
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
  }
}
