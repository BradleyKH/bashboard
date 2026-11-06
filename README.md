Bashboard
=========

**A beautiful terminal for running Claude Code on Windows.** Bashboard puts your terminal panes, a live
board of every agent session, and the Git, file, search, and CI views you'd otherwise open an IDE
or a browser for into one window, so you stop juggling apps while Claude works.

## Why Bashboard

- **See every session at a glance.** The dashboard lists each pane with its status (working,
  waiting, done, failed), folder, model, and context size. Claude sessions running in Windows
  Terminal or VS Code show up too.
- **Never miss a prompt.** A session that needs permission or finishes its turn pulses its pane
  and tab, flashes the taskbar, and says why. Ctrl+Shift+N jumps to the next one, across tabs.
  Long shell commands get the same done and failed marks.
- **Git without leaving the terminal.** The Git pane stages, commits, fetches, pulls, pushes, and
  manages branches beside the diff. A Files pane browses and previews a repo, and code search
  finds a line across it, honoring `.gitignore`.
- **CI and reviews beside the code.** The Ship pane ranks your pinned repos by what needs you: a
  failed deploy branch, a review waiting, an approved pull request ready to merge. Click in for
  pipeline runs, job logs, and pull requests from GitHub, GitLab, Bitbucket, or Azure DevOps,
  using the sign-in your terminal already has.
- **No forgotten servers.** The Ports list shows every dev server listening, which pane started
  it, and a Stop button to end it and everything it started.
- **Containers on the side.** Start, stop, tail logs, and shell into Docker or Podman containers.
- **Pick up where you left off.** Tabs, splits, and scratch pads come back on relaunch; named
  layouts rebuild a whole workspace in one click. A command palette (Ctrl+Shift+P) reaches
  everything.
- **Drive it from the shell.** `bb edit src/main.ts:40`, `git diff | bb scratch`, `bb git`: the
  `bb` CLI opens panes from any prompt, so Claude can use it too.
- **Draft prompts properly.** Scratch pads hold longer prompts and notes, then send them to the
  terminal for a final look.
- **A backdrop that's alive.** Swirling Lights is a colony simulation drifting behind your panes,
  and each live agent session grows its own colored lineage that blooms while it works. Prefer
  something else? Pick Matrix, your own image, or a slideshow of a folder, and dim it to taste.
- **More than Claude Code.** Preview support for OpenAI Codex and GitHub Copilot CLI brings the
  same status, cards, notifications, and resume on relaunch. The Local AI models section shows
  what Ollama and LM Studio have loaded, warns when a model's context is too small for an agent,
  and launches an agent on a local model.

## Installing

Download `Bashboard_<version>_x64-setup.exe` from the
[latest release](https://github.com/BradleyKH/bashboard/releases/latest) and run it. It installs
for the current user without admin rights and includes everything Bashboard needs: the app, the
`bb` pane CLI, and the terminal font. Bashboard checks for new releases at launch and updates
itself from inside the app.

The installer is not code-signed, so Windows SmartScreen shows "Windows protected your PC" the
first time. Click **More info**, then **Run anyway**.

Bashboard runs the tools you already use:

1. **Git for Windows**, which provides Git Bash, the default shell. If it's missing, the setup
   wizard offers to install it with winget (no admin rights needed), or install it yourself:

   ```sh
   winget install --id Git.Git -e
   ```

   Without Git, panes open in PowerShell or Command Prompt instead.

2. **Claude Code**, for session status, attention, and the dashboard. Run `claude` once before
   starting Bashboard so the setup wizard offers to install its hooks
   (see [Claude Code hooks](docs/setup.md#claude-code-hooks)). Codex and Copilot CLI work the
   same way, as a preview (see [Agent hooks](docs/setup.md#agent-hooks)).

3. **Optional:** Docker Desktop or Podman for the containers list.

On first launch, a setup wizard walks you through the shell, the lines that let new panes open in
the current folder, your editor, favorite repos, coding agent hooks, and the look. Each choice
saves as you make it, and **Run setup** in the Help tab (F1) brings the wizard back.

WebView2 comes with Windows 11; on a machine without it, the installer downloads it. Uninstall
from **Settings > Apps > Installed apps**. To build from source, see
[Development](docs/development.md).

## Documentation

- [User guide](docs/user-guide.md): tabs, panes, the dashboard, Files, Git, code search,
  containers, ports, the Ship pane, attention, and the `bb` pane CLI.
- [Shell and coding agent setup](docs/setup.md): the `~/.bashrc` and PowerShell lines that let
  new panes open in the current folder, the hooks for Claude Code, Codex, and Copilot, and signing
  in to GitHub, GitLab, Bitbucket, and Azure DevOps for the Ship pane.
- [Settings](docs/settings.md): the settings file and what each setting does.
- [Development](docs/development.md): building from source, releasing, and debugging input.
- [Design](docs/design/README.md): the spec, for anyone changing Bashboard itself.

## License

MIT, see [LICENSE](LICENSE).
