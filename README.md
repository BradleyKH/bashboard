Bashboard
=========

A Windows terminal for Claude Code, built with Tauri: Git Bash panes rendered by xterm.js over
a live backdrop.

## Installing

Bashboard ships as a single installer, `Bashboard_<version>_x64-setup.exe`. Download it from the
[latest release](https://github.com/BradleyKH/bashboard/releases/latest), or build it yourself
(see [Releasing](docs/development.md#releasing)). The installer holds everything Bashboard needs: the app, the `bb`
pane CLI, and the terminal font. It installs for the current user without admin rights, adds
Bashboard to the Start menu, and offers a desktop shortcut on its last page.

The installer is not code-signed, so Windows SmartScreen shows "Windows protected your PC" the
first time. Click **More info**, then **Run anyway**.

Once installed, Bashboard checks for a newer release at launch and offers it in a banner; the
update installs from inside the app. **Check for updates** in the settings dialog or the command
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
   (see [Claude Code hooks](docs/setup.md#claude-code-hooks)).

3. **Optional:** Docker Desktop or Podman for the dashboard's containers list.

On first launch, a setup wizard walks through installing Git when it is missing, the default
shell, adding the `~/.bashrc` lines that let new panes open in the current folder (see
[New panes in the current folder](docs/setup.md#new-panes-in-the-current-folder)), the editor,
favorite repos, Claude Code hooks, and look. Each choice saves as soon as you make it, and
**Run setup** in the settings dialog reopens the wizard. The Git step appears only when Git Bash
is missing, the shell integration step only when `~/.bashrc` does not already hold the current
lines, and the Claude Code hooks step only when Claude Code is detected and the hooks are not yet
installed.

WebView2 comes with Windows 11; on a machine without it, the installer downloads it. Uninstall
from **Settings > Apps > Installed apps**.

## Documentation

- [User guide](docs/user-guide.md): tabs, panes, the dashboard, Files, Git, code search,
  attention, and the `bb` pane CLI.
- [Shell and Claude Code setup](docs/setup.md): the `~/.bashrc` and PowerShell lines that let
  new panes open in the current folder, and the Claude Code hooks.
- [Settings](docs/settings.md): the settings file and what each setting does.
- [Development](docs/development.md): building from source, releasing, and debugging input.
- [Design](docs/design.md): the spec, for anyone changing Bashboard itself.

## License

MIT, see [LICENSE](LICENSE).
