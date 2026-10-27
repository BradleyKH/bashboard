import type { SetupStepUi } from './setupModel';
import type { ShellIntegrationPreview } from './shellIntegration';

export interface ShellIntegrationStepState {
  preview: ShellIntegrationPreview;
  installing: boolean;
  done: boolean;
}

/**
 * The setup wizard's shell-integration step: the `.bashrc` lines that report the folder and the
 * prompt to the app (docs/design.md section 4.17).
 */
export function renderShellIntegrationStep(
  content: HTMLElement,
  state: ShellIntegrationStepState,
  ui: SetupStepUi,
  install: () => void,
): void {
  const { preview } = state;
  content.append(
    ui.note(
      'These lines let new panes open in the current folder, and let the app tell exactly when a shell is working or idle.',
    ),
  );

  const target = ui.note(`${preview.status === 'missing' ? 'Adds to' : 'Updates'} ${preview.bashrcPath}:`);
  const block = document.createElement('pre');
  block.className = 'setup-wizard-block';
  block.textContent = preview.block;
  content.append(target, block);

  if (preview.status === 'custom') {
    const err = ui.note(
      `${preview.bashrcPath} already has customized Bashboard shell integration lines; update them by hand.`,
    );
    err.classList.add('setup-wizard-error');
    content.append(err);
    return;
  }

  if (preview.createsBashrc) content.append(ui.note(`${preview.bashrcPath} does not exist yet, so it is created.`));
  else content.append(ui.note('The current file is backed up to ~/.bashrc.bashboard-backup first.'));
  if (preview.createsBashProfile) {
    content.append(ui.note('~/.bash_profile is created too, so login shells read ~/.bashrc.'));
  }
  if (preview.bashProfileWarning) {
    const warn = ui.note(preview.bashProfileWarning);
    warn.classList.add('setup-wizard-error');
    content.append(warn);
  }

  const actions = document.createElement('div');
  actions.className = 'setup-wizard-actions';
  if (state.done) {
    const done = document.createElement('span');
    done.className = 'setup-wizard-done';
    const cmd = document.createElement('code');
    cmd.textContent = 'source ~/.bashrc';
    done.append('Added. Panes opened from now on use it; run ', cmd, ' in panes already open.');
    actions.append(done);
  } else {
    const add = ui.button('Add to .bashrc', install);
    add.classList.add('setup-wizard-primary');
    add.disabled = state.installing;
    actions.append(add);
  }
  content.append(actions);
}
