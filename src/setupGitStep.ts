import type { SetupStepUi } from './setupModel';

export interface GitStepState {
  wingetFound: boolean;
  installing: boolean;
  done: boolean;
}

export interface GitStepActions {
  install(): void;
  openDownload(): void;
}

/** The setup wizard's Git step, shown while Git Bash is missing (docs/design.md section 4.17). */
export function renderGitStep(
  content: HTMLElement,
  state: GitStepState,
  ui: SetupStepUi,
  actions: GitStepActions,
): void {
  content.append(
    ui.note(
      "Git Bash was not found. It is the default shell for new panes, and Claude Code's hooks run through it.",
    ),
  );
  const actionsRow = document.createElement('div');
  actionsRow.className = 'setup-wizard-actions';
  if (state.done) {
    const done = document.createElement('span');
    done.className = 'setup-wizard-done';
    done.textContent = 'Git installed';
    actionsRow.append(done);
  } else if (state.wingetFound) {
    content.append(ui.note('Install Git for Windows for this user with winget.'));
    const install = ui.button(state.installing ? 'Installing...' : 'Install Git', actions.install);
    install.classList.add('setup-wizard-primary');
    install.disabled = state.installing;
    actionsRow.append(install);
    if (state.installing) {
      const wait = ui.note('This can take a few minutes.');
      actionsRow.append(wait);
    }
  } else {
    content.append(ui.note('Download Git for Windows, install it, then run setup again from the settings.'));
    const link = ui.button('Open git-scm.com', actions.openDownload);
    link.classList.add('setup-wizard-primary');
    actionsRow.append(link);
  }
  content.append(actionsRow);
}
