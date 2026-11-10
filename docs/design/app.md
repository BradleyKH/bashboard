# Pane CLI, install, updates, and the app dialog

Section numbers are ids shared across every file in `docs/design/`, so a citation such as
"section 4.5" names one section wherever it lives; [the index](README.md#index) maps each to its file.

## 3.13 Pane CLI (`bb`)

`bb` lets a shell in a pane drive the app: open a file in a Files pane, pipe output into a
scratch pad, open the Git pane. It is a small console binary (`src-tauri/src/bin/bb.rs`), a
second `[[bin]]` of the Tauri crate that the installer places beside `bashboard.exe`, so it
works the same from Git Bash, PowerShell, and Command Prompt. The core finds it beside
`current_exe()` and puts that folder first on every pane's `PATH` (3.1); Git Bash's login
profile then puts its own folders ahead of it, which is harmless since none holds a `bb`.

| Command | Does |
| --- | --- |
| `bb open <path>` | A folder shows in the tab's Files pane for its repo, or opens one; a file does the same with its folder and selects it (as a pin does, 4.12) |
| `bb edit <path>[:<line>]` | Opens the file in the preferred editor (3.12) |
| `bb git` | The Git pane for the working directory's repo, focusing an existing one (4.11) |
| `bb search [<query>]` | A Search pane for the working directory's repo, starting with the query |
| `bb scratch [<text>]` | A new scratch pad (4.15) holding the text, or standard input when it is not a terminal (`git diff \| bb scratch`) |
| `bb ship` | The Ship pane (4.20) on the working directory's repo, or the Overview outside a repo |
| `bb ports` | The Ports pane (4.19) |
| `bb containers` | The Containers pane (4.16) |
| `bb browse [<url>]` | A Local Browser pane (4.21) at a loopback address, or on its start page; a bare port, `:port`, `host:port/path`, and a path to an `.html` or `.htm` file (resolved against the shell's working folder) are accepted, and a non-loopback address is refused |
| `bb term [<folder>] [-- <command>]` | A terminal of the default profile in the working directory or `<folder>`, typing the command after `--` as one line once its shell is ready |
| `bb auth bitbucket [--clear]` | Stores a Bitbucket API token for the Ship pane (3.20), or removes it with `--clear` |
| `bb auth azure-devops <org> [--clear]` | Stores an Azure DevOps personal access token for one organization, or removes it with `--clear` |
| `bb help` | Lists the commands |

`src-tauri/cli-commands.json` holds each command's usage, summary, details, and examples. `bb help`
prints the usage and summary lines from it (embedded at build time), and the app dialog's CLI tab
(4.18) shows all of it, so the two cannot drift.

New panes open as a split of the calling pane, as a favorite does (4.6), in the calling pane's
tab, and focus moves to them. `--collapsed` opens a pane collapsed instead, and `--tab` (`-t`)
opens it as the only pane of a new tab, where `bb open` and `bb git` skip their reuse of the
tab's Files or Git pane; the core refuses the two together, since a tab holding only a collapsed
pane has nothing to type into. `bb ship`, `bb ports`, and `bb containers` instead show the
existing pane in any tab or append a tab for it, as their keys do, so the core refuses
`--collapsed` for them and `--tab` changes nothing. `--` ends the options, and for `bb term` separates the folder
from the command; for the other commands the words after it are ordinary arguments.

- **Transport.** `bb` reads `BASHBOARD_HOOK_URL`, `BASHBOARD_HOOK_TOKEN`, and
  `BASHBOARD_PANE_ID`, and posts `{ command, args, cwd, stdin? }` to `/cli` on the hook receiver
  (3.3) with the same token and pane headers. `cwd` is the process's working directory as a
  Windows path; relative paths in `args` are resolved against it in the core.
- **Answers.** 204 on success, 403 for a bad token, 404 for an unknown pane, 413 for a body over
  1 MiB, and 400 with a JSON `{ error }` for an unknown command, bad arguments, or a path that
  does not exist. `bb` prints the error to stderr and exits 1; on success it prints nothing and
  exits 0. Success means the core accepted the command, not that the front end carried it out:
  a pane whose pty is alive but which is mid-close drops the command with a console warning.
- **Outside the app** (no `BASHBOARD_HOOK_URL`), `bb` prints that it only works inside a
  Bashboard pane and exits 1, except `bb auth`.
- **`bb auth`** talks only to Windows Credential Manager, never to the app, so it works in
  any terminal. `bb auth bitbucket` stores a Bitbucket API token, and `bb auth azure-devops <org>`
  an Azure DevOps personal access token (PAT) for that one organization, so each organization
  needs its own (a PAT made for all accessible organizations stops working on January 27, 2027).
  Each reads the token from a hidden prompt (console echo off), or from standard input when that
  is not a terminal (up to 1 MiB, first line used), and stores it as a generic credential
  persisted for the local machine: `bashboard:bitbucket.org` with the user name
  `x-bitbucket-api-token-auth`, or `bashboard:dev.azure.com/<org>`, the organization lowercased,
  with the user name `x-azure-devops-pat`. A token that is empty or over 2,560 bytes (the
  Credential Manager blob limit) is refused, as is an organization that is empty, holds a slash,
  whitespace, or a control character, or is written as a flag. `--clear` follows the provider
  (and the organization) and deletes the credential, saying when none was stored. The Ship pane's
  token sources (3.20) read these credentials. The command and the app dialog's Accounts tab
  (4.20) share one store, `credential_store.rs`, which both `bb.exe` and the app compile, so they
  agree on the targets, the user names, the size limit, and how a token is cleaned; nothing else
  writes them.
- The core emits `cli://command` with the pane id and the resolved request; the front end's
  `Workspace` carries it out exactly as the matching dashboard or keyboard action would, so `bb`
  can do nothing the UI cannot.

## 3.14 Shell integration install (`src-tauri/src/shell_integration.rs`)

Working-directory reporting (OSC 9;9) and the command-start and command-end markers (OSC 133)
come from a few lines in Git Bash's `~/.bashrc`. The setup wizard (4.17) installs them with
`shell_integration_preview(shell)` and `shell_integration_install(shell)`, where `shell` is the
profile id `gitBash`; cmd and PowerShell need no lines, since the core starts them with a prompt
that reports the folder (3.1). The lines are the snippet in setup.md's "New panes in the current
folder"; a test requires it to match byte for byte, ignoring line endings.

The install writes the snippet between two marker lines at the end of the file:
`# >>> bashboard shell integration >>>` and `# <<< bashboard shell integration <<<`. The file is
`~/.bashrc`, with home as `HOME`, then `USERPROFILE`, as Git Bash resolves it.
`shell_integration_preview` returns the shell, the file's path, the status, the block to add,
whether the file or `.bash_profile` would be created, and a warning.

| Status | Meaning | Install does |
| --- | --- | --- |
| `missing` | No file, or no Bashboard lines in it | Appends the block, after a blank line |
| `installed` | A marked block equal to the current snippet | Nothing |
| `outdated` | A marked block that differs from the current snippet | Replaces the block in place |
| `handAdded` | The snippet, or an earlier published one, appears verbatim without markers | Replaces those lines with the marked block, in place |
| `custom` | A begin marker with no end marker, or lines of the user's own (a `__bashboard_prompt` function) that are not the snippet | Refuses; the user updates the lines by hand |

- **Backup.** An existing file is copied to `<file>.bashboard-backup` beside it before it is
  rewritten. The write is atomic (the helper the hook install uses, 3.3).
- **Encoding and line endings.** The file's own line endings are kept, and lines outside the
  block are rewritten byte for byte. `.bashrc` must be UTF-8; anything else is left alone with an
  error.
- **Login shells.** Git Bash's login shell reads `~/.bash_profile`, not `~/.bashrc`. When that
  file is missing, the install creates it with the two standard lines that source `~/.profile`
  and `~/.bashrc`. When it exists and never mentions `.bashrc`, the preview carries a warning
  and the file is left untouched.
- Panes already open do not pick the lines up until their shell reads the file again
  (`source ~/.bashrc`).

## 3.15 Git install (`src-tauri/src/git_install.rs`)

Git Bash is the default shell, and the Claude Code hooks run through its `bash.exe`. When no
Git Bash is found (3.1), the setup wizard's Git step (4.17) installs Git for Windows with
winget. `git_install_status` reports whether Git Bash was found and whether `winget.exe` was;
winget is looked up on `PATH`, then at the App Execution Alias under
`%LOCALAPPDATA%\Microsoft\WindowsApps`, which a GUI process may not have on its `PATH`.

`git_install` runs `winget install --id Git.Git -e --source winget --silent
--accept-package-agreements --accept-source-agreements --scope user` with no console window.
`--scope user` runs the installer for the current user, so there is no admin prompt and Git
lands in `%LOCALAPPDATA%\Programs\Git`, a location the profile detection already checks
(3.1). The command times out after 15 minutes. On failure the error carries the last lines of
winget's output, with its progress spinner collapsed. When the install succeeds, the front end
reloads the shell profiles so the new Git Bash is offered without a restart.

When winget is missing, the step offers a link to git-scm.com instead (opened through
`open_url`) and asks the user to run setup again once Git is installed.

## 3.16 Updates and releases

Installed apps update themselves through Tauri's updater plugin. `plugins.updater` in
`tauri.conf.json` holds the public signing key and one endpoint,
`https://github.com/BradleyKH/bashboard/releases/latest/download/latest.json`, which resolves to
the newest non-prerelease release. The Windows install mode is `passive`: the NSIS installer
shows its progress without prompts.

`src/updater.ts` exports `checkForUpdate({ manual, confirm })`. It runs once at launch after the
workspace is up, quietly, and again from the app dialog's About tab (4.18) or the
command palette's Check for updates entry (4.5), both of which also report "up to date" and
failures. It does not check in a dev build, which has no installed bundle to replace; a manual
check there says so in a toast. An available update shows as a banner (`updateNotice.ts`) with
Install and restart and Later. Installing first asks for confirmation through the shared confirm dialog,
because restarting ends every running shell and any command or Claude session in it; the
confirmation notes that the layout reopens on the next launch when `restore.enabled` is on. The
update then downloads with progress shown in the banner, installs, and relaunches the app.

**Signing.** Update packages are signed with a minisign key pair made by `tauri signer
generate`. The public key is committed in `tauri.conf.json`; the private key and its password
are never committed. The release workflow reads them from the repository secrets
`TAURI_SIGNING_PRIVATE_KEY` and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`, and the maintainer keeps
the key file (`~/.tauri/bashboard.key`) and its password outside the repo. Losing the private key
means installed apps cannot verify later updates, so the key is backed up. The installer itself
is not Authenticode-signed, so SmartScreen warns on first run. Local builds and the CI workflow
need no key: only the release workflow turns on `bundle.createUpdaterArtifacts`, through
`--config`.

**Release workflow** (`.github/workflows/release.yml`). `pnpm version:set <version>`
(`scripts/bump-version.ts`) sets the version in `package.json`, `src-tauri/Cargo.toml`, and
`src-tauri/Cargo.lock`; `tauri.conf.json` reads `package.json`. Pushing a `v<version>` tag runs
the workflow on a Windows runner: it checks that the tag matches `package.json`, runs the type
check, the front end tests, and the Rust tests, then builds with `tauri-action` into a draft
release named "Bashboard v<version> (beta)", not marked as a prerelease, with the NSIS
installer, its `.sig`, and `latest.json`. The release body, which also becomes the `notes` in
`latest.json`, is the annotated tag's message (if any) followed by the standard beta
SmartScreen text; a lightweight tag gets the standard text alone. A step then checks that `bb.exe` was built and is
listed in the installer script (3.13), and only after that is the release published, so a
broken build never becomes the release the updater reads.

**Installer.** The NSIS installer installs per user, shows the license page, carries the
Bashboard header and sidebar images (`src-tauri/installer/`), sets the publisher, and offers a
desktop shortcut on its finish page. The product name is Bashboard and the executable stays
`bashboard.exe`.

**Terminal font.** The JetBrainsMono Nerd Font Mono regular and bold weights ship inside the app
as WOFF2 files (`src/assets/fonts/`, declared in `src/fonts.css`, licensed under the SIL Open
Font License, whose text sits beside them). `fontsReady()` in `src/fontsReady.ts` resolves once
both weights have loaded, or after 2 seconds, and `main.ts` awaits it before building the
workspace, since xterm.js measures its character cell when a terminal opens.

## 3.18 Single instance (`src-tauri/src/second_instance.rs`)

Release builds register `tauri-plugin-single-instance` before every other plugin. A second
launch finds the running app through a named mutex keyed on the app identifier, hands it its
arguments and working directory, and exits. The running app unminimizes, shows, and focuses the
main window, then emits `instance://launched` with the folder for a new tab, or `null`. The
folder is the first argument that names an existing folder; without one, it is the working
directory, unless that is empty, missing, the exe's own folder (where Start menu and taskbar
shortcuts start), or the Windows folder or below. On a folder, the front end opens a new tab
there (4.10). Debug builds skip the plugin, since they share the identifier and a dev run starts
beside the installed app; their saved state is already separate (3.6).

A first launch keeps its own folder argument (working directory alone does not count) for the
front end, which takes it once through `startup_folder_take` after restoring the workspace: it
opens a new tab there, or starts the first pane there when nothing was restored. Taking clears
it, so a page reload does not repeat the tab.

The installer adds "Open in Bashboard" to Explorer's context menu through `installer/hooks.nsh`:
per-user verbs under `HKCU\Software\Classes` for `Directory\Background`, `Directory`, and
`Drive`, each running `bashboard.exe "%V"`, removed on uninstall. Explorer quotes a drive root as
`"C:\"`, which reaches the app as `C:"`; the folder check repairs that to `C:\`. On Windows 11
these verbs sit in the classic menu ("Show more options"), since the top-level menu takes only
shell extensions registered by a signed package.

## 4.17 Setup wizard

Shown at launch when `settings.json` did not exist before that launch (the settings payload's
`firstRun`), and from the Run setup button in the app dialog's Help tab (4.18). Each step saves through
`settings_set` as soon as a choice is made, so leaving partway keeps what was chosen. Every step
has Back, Next, and Skip setup.

1. **Git.** Shown only while Git Bash is missing (3.15). With winget available, an Install Git
   button runs the install and shows its progress and result; the step stays in the list once
   Git is installed, reading "Git installed". Without winget, a button opens git-scm.com.
2. **Shell.** The available profiles (3.1); sets `shell.defaultProfile`.
3. **Shell integration.** For the shell new panes open with: the chosen default when it is
   installed, else the first installed profile, as the core resolves it (3.1). Shown when that
   shell is Git Bash and `~/.bashrc` does not already hold the current block (3.14); hidden for
   the other shells, which need no lines, and when the file's state could not be read. The
   file's state is read in the background when the wizard opens, so changing the Shell step's
   choice adds or drops this step at once, updating the step count without re-rendering the
   Shell step. It lists the lines and the file they go in, notes the backup, any `.bash_profile`
   it will create, and any warning (a `.bash_profile` that skips `.bashrc`), and runs the install
   with Add to .bashrc. A `custom` status shows the lines and an error instead of the
   button.
4. **Editor.** The editors found (3.12) and the file's default app; sets `editor.preferred`.
5. **Favorites.** A folder field, starting at `%USERPROFILE%\source\repos` when it exists,
   listing its subfolders that are git repos with checkboxes. The subfolders come from
   `setup_repo_candidates(dir?)` (`src-tauri/src/setup.rs`), which lists the direct subfolders
   holding `.git`, as a folder or as a worktree's file. Add appends the checked ones to
   favorites, skipping any already there. When some listed repo's remote is on a code host Ship
   reads (`forge_repo`, 3.20), an unchecked-by-default box under the list, "Also pin them to the
   Ship Overview, for pull request and pipeline alerts", makes Add (reading **Add and pin**) also
   pin the checked ones that are, in one write to `ship.pinnedRepos` with each clone as the
   pin's `root` (4.20), skipping repos already pinned. Pins cost polling and, on Bitbucket, the
   request budget, so pinning is a choice rather than a side effect of favoriting.
6. **Agents.** Shown while a detected agent (3.2) lacks the hooks; lists each detected agent
   with its hook state (Codex and Copilot marked as a preview), explains the hooks, and runs each
   agent's install with its confirmation (3.3). An installed Codex hook that is not yet trusted
   says Codex will ask to trust it on its next start.
7. **Look.** Applied live, in the Settings tab's terms (6.2). Background (None, Swirling
   Lights, Galaxy, Matrix, Wave, Image, Slideshow; `backdrop.style`). Image and Slideshow open the native picker
   (`backdrop_image_pick`, 6.5) for a file or folder and save the style only once it returns a
   path (`backdrop.image.file` or `backdrop.image.folder`), so cancelling changes nothing; a line
   under the row then names the picked path with a Change button, and Fit and the slideshow's
   timing stay at their defaults for the Settings tab. Animate the background
   (`backdrop.animate`), shown only for Swirling Lights, Galaxy, Matrix, and Wave, and Brightness (Low, Medium,
   High, the scrim presets of section 5 from darkest), hidden under None. Accent
   color as swatches of its presets (`accentColor`), and Text color as an Accent tint swatch, drawn
   from the accent shown, and a White one (`contentTextColor`). Picking Matrix turns the accent
   to the Green preset while it is still at its default, to go with the green rain, and the
   accent tint follows; picking another background turns the accent back only when the wizard
   turned it green and it is still green, so a color the user chose is never overridden.

## 4.18 App dialog

One modal (`appDialog.ts`) holds the tabs Help, Settings, Accounts, Shortcuts, CLI, and About, in that order
(`appDialogModel.ts`). Each entry point opens its own tab: the dashboard's ? button and F1
(`showHelp`) open Help, ⚙ and Ctrl+, (`openSettings`) open Settings, and `showAccounts`,
`showShortcuts`, `showCli`, and `showAbout` (no default keys; all six are in the command palette,
the first as "Manage code host accounts") open the rest.
Opening it while it is open switches tabs. The dialog has one fixed size, so switching tabs never
moves its edges, and each tab scrolls inside it.

A tab builds on its first visit and stays built, with its filter and scroll, until the dialog
closes, when every built tab is torn down (Settings commits a pending edit then). Leaving
Shortcuts ends any recording or open strip. The backdrop dims the window behind the dialog except
on Settings, where it stays clear so color and brightness changes preview at their true values;
a click on it closes the dialog either way.

Keys: Escape closes. Ctrl+Tab and Ctrl+PageDown move one tab right, Ctrl+Shift+Tab and Ctrl+PageUp
left, wrapping, and Left and Right do the same while a tab button has focus. A chord or function
key bound to one of the six actions above switches to its tab, or closes the dialog when that tab
already shows, so F1 toggles Help. Plain keys never switch, since they may be typing into a field.
Up and Down scroll the open tab by a line and Page Up and Page Down by a page, whatever has focus,
except in a control that steps a value or moves through lines with them (a text area, select,
number or range input, or list); a one-line text field scrolls the tab too.
The Shortcuts tab's recorder sees keys first while it records (4.5).

- **Help** (`helpTab.ts`) is a short tour of the user guide (`helpTour.ts`), a paragraph or two
  per area, whose `{action}` tokens render as the action's live keycaps, or "no key" when it is
  unbound, followed by a link to the full user guide. Below it, Setup (`setupStatus.ts`) checks Git
  Bash (3.15), the shell integration lines of each installed shell that takes them (3.14), and the
  hooks of each agent (3.3, one row per agent, "Codex hooks (preview)" and the like), each row
  reading ✓, !, or • with a short status and, where the app can fix it, a button: Install Git
  (winget, or Download without it), Install or Update for the shell lines, and Install for the
  hooks, which opens that agent's hook preview (3.3) over the dialog. An agent that has not run
  on this machine reads "<agent> has not run on this machine".
  Missing lines warn only for the default shell; other shells get the button without the warning.
  The checks rerun on each visit and after each fix. Run setup closes the dialog and opens the
  setup wizard (4.17).
- **Settings** is the settings editor (4.6).
- **Accounts** (`accountsTab.ts`) shows where each code host's token comes from and manages it,
  with one card per host (4.20).
- **Shortcuts** is the shortcut guide and keybinding editor (4.5).
- **CLI** (`cliTab.ts`) lists each `bb` command and option from `cli-commands.json` (3.13) with
  its usage, what it does, and examples, each with a Copy button.
- **About** (`aboutTab.ts`) shows the version, Check for updates (3.16), and links to this
  version's release notes on GitHub, the documentation, and the source.
