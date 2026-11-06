Bashboard
=========

**A beautiful terminal that enhances productivity and reduces friction.** Bashboard is a
Windows terminal built around Claude Code: split terminal panes, a live status board, and the Git, file, and search views you'd otherwise leave for an IDE, so you stop jumping between apps while Claude works.

## Why Bashboard

- **See every session at a glance.** The dashboard lists each pane with its status (working,
  waiting, done, failed), folder, model, and context size. Claude sessions running in Windows
  Terminal or VS Code show up too.
- **Never miss a prompt.** A session that needs permission or finishes its turn pulses its pane
  and tab, flashes the taskbar, and says why. Ctrl+Shift+N jumps to the next one, across tabs.
  Long shell commands get the same done/failed marks.
- **Pick up where you left off.** Tabs, splits, and pads come back on relaunch; named layouts
  rebuild a whole workspace in one click. A command palette (Ctrl+Shift+P) reaches everything.
- **More than Claude Code.** Preview support for OpenAI Codex and GitHub Copilot CLI: the same
  status, cards, notifications, and resume on relaunch. A Local AI models section shows what Ollama
  and LM Studio have loaded, warns when a model's context is too small for an agent, and launches
  an agent on a local model from the Launch menu.
- **CI and reviews beside the code.** The Ship pane's Overview ranks your pinned repos by what
  needs you: a failed deploy branch, a review waiting, a pull request to fix. Click in for a repo's
  pipeline runs, job logs, and open pull requests from GitHub, GitLab, Bitbucket, or Azure DevOps,
  using the sign-in your terminal already has. An Accounts tab shows each host's sign-in and manages
  it: switch GitHub accounts, sign out of GitLab, or add and replace a Bitbucket token or an Azure
  DevOps token for each organization.
- **Containers on the side.** Start, stop, tail logs, and shell into Docker or Podman containers.
- **No forgotten servers.** The Ports list shows every dev server listening, which pane started
  it, and stops it from a right-click.
- **Drive it from the shell.** `bb edit src/main.ts:40`, `git diff | bb scratch`, `bb git`: the
  `bb` CLI opens panes from any prompt, so Claude can use it too.
- **Draft prompts properly.** Scratch pads hold longer prompts and notes, then send them to the
  terminal for a final look.

## Installing

Bashboard ships as a single installer, `Bashboard_<version>_x64-setup.exe`. Download it from the
[latest release](https://github.com/BradleyKH/bashboard/releases/latest), or build it yourself
(see [Releasing](docs/development.md#releasing)). The installer holds everything Bashboard needs: the app, the `bb`
pane CLI, and the terminal font. It installs for the current user without admin rights, adds
Bashboard to the Start menu, and offers a desktop shortcut on its last page.

The installer is not code-signed, so Windows SmartScreen shows "Windows protected your PC" the
first time. Click **More info**, then **Run anyway**.

Once installed, Bashboard checks for a newer release at launch and offers it in a banner; the
update installs from inside the app. **Check for updates** in the About tab (F1, then About) or the command
palette (Ctrl+Shift+P) checks on demand.

Bashboard runs the tools you already use:

1. **Git for Windows**, which provides Git Bash, the default shell. When Git Bash is missing, the
   setup wizard offers to install it for you with winget (no admin rights needed). To install it
   yourself:

   ```sh
   winget install --id Git.Git -e
   ```

   Without Git, panes open in PowerShell or Command Prompt instead. A per-user Git install is
   found automatically; anywhere else, set `shell.path` (see [Settings](docs/settings.md#settings)).

2. **Claude Code**, for the session status, attention badges, and dashboard. Run `claude` once
   before starting Bashboard so the setup wizard offers to install the hooks
   (see [Claude Code hooks](docs/setup.md#claude-code-hooks)). OpenAI Codex and GitHub Copilot CLI
   work the same way, as a preview (see [Agent hooks](docs/setup.md#agent-hooks)).

3. **Optional:** Docker Desktop or Podman for the dashboard's containers list.

On first launch, a setup wizard walks through installing Git when it is missing, the default
shell, adding the lines that let new panes open in the current folder to that shell's
`~/.bashrc` or PowerShell profile (see
[New panes in the current folder](docs/setup.md#new-panes-in-the-current-folder)), the editor,
favorite repos, coding agent hooks, and the look: the background (including your own picture or a
slideshow of a folder), its brightness, and the accent
and text colors. Each choice saves as soon as you make it, and **Run setup** in the Help tab
(F1) reopens the wizard. The Git step appears only when Git Bash is missing, the shell
integration step only when the default shell is Git Bash or PowerShell and its file does not
already hold the current lines, and the Coding agents step only when a coding agent is detected
and the hooks are not yet installed.

WebView2 comes with Windows 11; on a machine without it, the installer downloads it. Uninstall
from **Settings > Apps > Installed apps**.

## Documentation

- [User guide](docs/user-guide.md): tabs, panes, the dashboard, Files, Git, code search,
  containers, ports, the Ship pane, attention, and the `bb` pane CLI.
- [Shell and coding agent setup](docs/setup.md): the `~/.bashrc` and PowerShell lines that let
  new panes open in the current folder, the hooks for Claude Code, Codex, and Copilot, and signing
  in to GitHub, GitLab, Bitbucket, and Azure DevOps for the Ship pane.
- [Settings](docs/settings.md): the settings file and what each setting does.
- [Development](docs/development.md): building from source, releasing, and debugging input.
- [Design](docs/design.md): the spec, for anyone changing Bashboard itself.

## License

MIT, see [LICENSE](LICENSE).
