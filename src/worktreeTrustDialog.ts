import './worktreeDialogs.css';
import { worktreeSetupScript, worktreeTrustSetup } from './worktreeApi';

export interface WorktreeTrustOptions {
  /** Native path of the repo's main worktree; approval is keyed by it. */
  mainRoot: string;
  /** Native path of the new worktree, whose `.bashboard/setup.sh` is asked about. */
  worktreePath: string;
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * Asks once before a repo's setup script first runs, or after it changed
 * (docs/design/git.md section 4.27). Resolves true once Run setup stored the approval, false on
 * Don't run, Escape, or an outside click.
 */
export class WorktreeTrustDialog {
  private backdrop: HTMLElement | null = null;
  private settle: ((run: boolean) => void) | null = null;
  private restoreFocus: HTMLElement | null = null;

  open(options: WorktreeTrustOptions): Promise<boolean> {
    this.finish(false);
    this.restoreFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    return new Promise((resolve) => {
      this.settle = resolve;

      const backdrop = document.createElement('div');
      backdrop.className = 'hook-dialog-backdrop';
      backdrop.addEventListener('mousedown', (e) => {
        if (e.target === backdrop) {
          e.preventDefault();
          this.finish(false);
        }
      });

      const box = document.createElement('div');
      box.className = 'hook-dialog worktree-dialog';
      box.setAttribute('role', 'dialog');
      box.setAttribute('aria-modal', 'true');
      box.addEventListener('keydown', (e) => {
        // Keep keys away from the workspace keymap and xterm.
        e.stopPropagation();
        if (e.key === 'Escape') {
          e.preventDefault();
          this.finish(false);
        }
      });

      const title = document.createElement('h2');
      title.textContent = 'Run this repo’s setup script?';

      const repoLine = document.createElement('p');
      repoLine.className = 'hook-dialog-line';
      const repoCode = document.createElement('code');
      repoCode.textContent = options.mainRoot;
      repoLine.append('Repo: ', repoCode);

      const scriptLine = document.createElement('p');
      scriptLine.className = 'hook-dialog-line';
      const scriptCode = document.createElement('code');
      scriptCode.textContent = '.bashboard/setup.sh';
      scriptLine.append(
        'The new worktree has ',
        scriptCode,
        '. Bashboard runs it in the new pane before the agent starts, and asks again if it changes.',
      );

      const script = document.createElement('pre');
      script.className = 'hook-dialog-json worktree-trust-script';
      script.hidden = true;
      script.tabIndex = 0;

      const error = document.createElement('p');
      error.className = 'hook-dialog-line hook-dialog-error';
      error.hidden = true;
      const showError = (text: string): void => {
        error.textContent = text;
        error.hidden = false;
      };

      const show = document.createElement('button');
      show.type = 'button';
      show.textContent = 'Show script';
      show.addEventListener('click', () => {
        if (!script.hidden) {
          script.hidden = true;
          show.textContent = 'Show script';
          return;
        }
        show.disabled = true;
        worktreeSetupScript(options.worktreePath).then(
          (text) => {
            show.disabled = false;
            if (!this.backdrop) return;
            script.textContent = text ?? '(the script is gone)';
            script.hidden = false;
            show.textContent = 'Hide script';
          },
          (e: unknown) => {
            show.disabled = false;
            showError(`Could not read the script: ${errorText(e)}`);
          },
        );
      });

      const skip = document.createElement('button');
      skip.type = 'button';
      skip.textContent = 'Don’t run';
      skip.addEventListener('click', () => this.finish(false));

      const run = document.createElement('button');
      run.type = 'button';
      run.className = 'hook-dialog-install';
      run.textContent = 'Run setup';
      run.addEventListener('click', () => {
        run.disabled = true;
        error.hidden = true;
        worktreeTrustSetup(options.mainRoot, options.worktreePath).then(
          () => this.finish(true),
          (e: unknown) => {
            run.disabled = false;
            showError(`Could not approve the script: ${errorText(e)}`);
          },
        );
      });

      const buttons = document.createElement('div');
      buttons.className = 'hook-dialog-buttons';
      buttons.append(show, skip, run);

      box.append(title, repoLine, scriptLine, script, error, buttons);
      backdrop.append(box);
      document.body.append(backdrop);
      this.backdrop = backdrop;
      // Not Run setup: a stray Enter must not approve a script nobody read.
      skip.focus();
    });
  }

  private finish(run: boolean): void {
    if (!this.backdrop) return;
    this.backdrop.remove();
    this.backdrop = null;
    const settle = this.settle;
    this.settle = null;
    this.restoreFocus?.focus();
    this.restoreFocus = null;
    settle?.(run);
  }
}
