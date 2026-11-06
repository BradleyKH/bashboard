import { profileName } from './profiles';
import type { SetupStepUi } from './setupModel';
import type { IntegrationShell, ShellIntegrationPreview } from './shellIntegration';

export interface ShellIntegrationStepState {
  shell: IntegrationShell;
  /** Undefined while it is read. */
  preview: ShellIntegrationPreview | undefined;
  installing: boolean;
  done: boolean;
}

const PURPOSE: Record<IntegrationShell, string> = {
  gitBash:
    'These lines let new panes open in the current folder, and let the app tell exactly when a shell is working or idle.',
  pwsh: 'These lines let new panes open in the current folder.',
  powershell: 'These lines let new panes open in the current folder.',
};

/**
 * The setup wizard's shell-integration step, for the shell new panes open with: the `.bashrc`
 * lines for Git Bash, or the profile lines for PowerShell (docs/design/app.md section 4.17).
 */
export function renderShellIntegrationStep(
  content: HTMLElement,
  state: ShellIntegrationStepState,
  ui: SetupStepUi,
  install: () => void,
): void {
  const name = profileName(state.shell);
  content.append(ui.note(`For ${name}, the shell new panes open with. ${PURPOSE[state.shell]}`));
  const { preview } = state;
  if (!preview) {
    content.append(ui.note(`Reading the ${name} profile...`));
    return;
  }

  const target = ui.note(`${preview.createsFile ? 'Creates' : preview.status === 'missing' ? 'Adds to' : 'Updates'} ${preview.path}:`);
  const block = document.createElement('pre');
  block.className = 'setup-wizard-block';
  block.textContent = preview.block;
  content.append(target, block);

  if (preview.status === 'custom') {
    const err = ui.note(
      `${preview.path} already has customized Bashboard shell integration lines; update them by hand.`,
    );
    err.classList.add('setup-wizard-error');
    content.append(err);
    return;
  }

  if (!preview.createsFile) content.append(ui.note(`The current file is backed up to ${preview.path}.bashboard-backup first.`));
  if (preview.createsBashProfile) {
    content.append(ui.note('~/.bash_profile is created too, so login shells read ~/.bashrc.'));
  }
  if (preview.warning) {
    const warn = ui.note(preview.warning);
    warn.classList.add('setup-wizard-error');
    content.append(warn);
  }

  const actions = document.createElement('div');
  actions.className = 'setup-wizard-actions';
  if (state.done) {
    const done = document.createElement('span');
    done.className = 'setup-wizard-done';
    const cmd = document.createElement('code');
    cmd.textContent = state.shell === 'gitBash' ? 'source ~/.bashrc' : '. $PROFILE';
    done.append('Added. Panes opened from now on use it; run ', cmd, ' in panes already open.');
    actions.append(done);
  } else {
    const add = ui.button(state.shell === 'gitBash' ? 'Add to .bashrc' : 'Add to profile', install);
    add.classList.add('setup-wizard-primary');
    add.disabled = state.installing;
    actions.append(add);
  }
  content.append(actions);
}
