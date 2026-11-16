import type { GitInstaller } from './gitInstall';
import { platformOs, type Os } from './platform';
import type { SetupStepUi } from './setupModel';

export interface GitStepState {
  installer: GitInstaller | null;
  /** The distro's install command, shown for the user to run; only when there is no installer. */
  installCommand: string | null;
  installing: boolean;
  /** A Check again is running. */
  checking: boolean;
  /** The last Check again still found no Git. */
  notFound: boolean;
  done: boolean;
}

export interface GitStepActions {
  install(): void;
  openDownload(): void;
  copyCommand(command: string): void;
  checkAgain(): void;
}

/** The step's intro line: Git for Windows brings Git Bash, the default shell there. */
export function gitStepIntro(os: Os = platformOs()): string {
  return os === 'windows' ? 'Install Git for Windows, which brings Git Bash.' : 'Install Git, which the Git pane and worktrees use.';
}

/**
 * The setup wizard's Git step, shown while Git is missing (docs/design/app.md section 4.17).
 * winget installs and reports back; macOS's Command Line Tools installer runs on its own, so
 * that path is done once the installer is open. Where only a command is known (Linux), the step
 * shows it and re-checks on request, since the app never runs it.
 */
export function renderGitStep(
  content: HTMLElement,
  state: GitStepState,
  ui: SetupStepUi,
  actions: GitStepActions,
  os: Os = platformOs(),
): void {
  const windows = os === 'windows';
  content.append(
    ui.note(
      windows ? 'Git Bash was not found. It is the default shell for new panes.' : 'Git was not found.',
    ),
  );
  const actionsRow = document.createElement('div');
  actionsRow.className = 'setup-wizard-actions';
  if (state.done) {
    const done = document.createElement('span');
    done.className = 'setup-wizard-done';
    done.textContent =
      state.installer === 'xcodeSelect' ? 'Installer opened; Git is ready once it finishes' : 'Git installed';
    actionsRow.append(done);
  } else if (state.installer) {
    const xcode = state.installer === 'xcodeSelect';
    content.append(
      ui.note(
        xcode
          ? "Install Apple's Command Line Tools, which include Git. macOS shows its own installer."
          : 'Install Git for Windows for this user with winget.',
      ),
    );
    const label = xcode ? 'Install Command Line Tools' : 'Install Git';
    const install = ui.button(state.installing ? (xcode ? 'Opening...' : 'Installing...') : label, actions.install);
    install.classList.add('setup-wizard-primary');
    install.disabled = state.installing;
    actionsRow.append(install);
    if (state.installing && !xcode) {
      const wait = ui.note('This can take a few minutes.');
      actionsRow.append(wait);
    }
  } else if (state.installCommand) {
    const installCommand = state.installCommand;
    content.append(ui.note('Install Git with your package manager, then check again.'));
    const command = document.createElement('code');
    command.className = 'setup-wizard-command';
    command.textContent = installCommand;
    content.append(command);
    if (state.notFound) content.append(ui.note('Git still was not found.'));
    const copy = ui.button('Copy', () => actions.copyCommand(installCommand));
    const check = ui.button(state.checking ? 'Checking...' : 'Check again', actions.checkAgain);
    check.classList.add('setup-wizard-primary');
    check.disabled = state.checking;
    actionsRow.append(copy, check);
  } else {
    content.append(
      ui.note(
        `Download ${windows ? 'Git for Windows' : 'Git'}, install it, then run setup again from the settings.`,
      ),
    );
    const link = ui.button('Open git-scm.com', actions.openDownload);
    link.classList.add('setup-wizard-primary');
    actionsRow.append(link);
  }
  content.append(actionsRow);
}
