Bashboard
=========

A Windows terminal for Claude Code, built with Tauri: Git Bash panes rendered by xterm.js over
a live backdrop. The full design is in [docs/design.md](docs/design.md).

## Setting up a new machine

Bashboard targets Windows 11, which already includes the WebView2 runtime. Everything else
installs with `winget` from a terminal; admin rights are needed for the Visual Studio build
tools and for machine-wide installs of the rest.

1. **Git for Windows**, which provides Git Bash and the `bash.exe` that the Claude Code hooks run through:

   ```sh
   winget install --id Git.Git -e
   ```

2. **Node.js 24 or later** and **pnpm**:

   ```sh
   winget install --id OpenJS.NodeJS.LTS -e
   winget install --id pnpm.pnpm -e
   ```

3. **C++ build tools.** Rust on Windows links with the MSVC toolchain and needs the Windows SDK.
   On a machine without Visual Studio, install the Build Tools with the C++ workload:

   ```sh
   winget install --id Microsoft.VisualStudio.BuildTools -e --override "--wait --passive --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"
   ```

   If Visual Studio is already installed, open the Visual Studio Installer instead, choose
   **Modify** on that install, check the **Desktop development with C++** workload (it includes
   the MSVC compiler and a Windows 11 SDK), and apply.

4. **Rust**, through rustup:

   ```sh
   winget install --id Rustlang.Rustup -e
   ```

   rustup installs the stable `x86_64-pc-windows-msvc` toolchain by default. If `rustup show`
   reports a `gnu` toolchain, run `rustup default stable-msvc`.

5. **Optional font.** Terminals use JetBrainsMono Nerd Font when installed and fall back to
   Cascadia Mono, which ships with Windows 11:

   ```sh
   winget install --id DEVCOM.JetBrainsMonoNerdFont -e
   ```

6. **Open a new terminal** so the updated `PATH` takes effect, then confirm the tools:

   ```sh
   git --version && node -v && pnpm -v && rustc -V && cargo -V
   ```

7. **Get the code.** When copying the folder from another machine, leave out `node_modules/`,
   `dist/`, and `src-tauri/target/`; they hold build output with machine-specific paths and are
   recreated by the build.

8. **Configure Git Bash** as described in
   [New panes in the current folder](#new-panes-in-the-current-folder).

9. **Build and run** from the repo root:

   ```sh
   pnpm install
   pnpm tauri dev
   ```

   The first run compiles every Rust dependency and takes several minutes; later runs are
   incremental.

Panes run `C:\Program Files\Git\bin\bash.exe --login -i` by default. If Git is installed
somewhere else, such as a per-user install at `%LOCALAPPDATA%\Programs\Git`, set `shell.path`
in the settings file (see [Settings](#settings)).

## Development

```sh
pnpm tauri dev      # run the app with hot reload
pnpm test           # frontend unit tests (Vitest)
pnpm tauri build    # release build and installer
pnpm build:bb       # rebuild bb.exe after editing src-tauri/src/bin/bb.rs
```

`pnpm tauri dev` builds `bb.exe` at startup, so the debug app finds it beside `bashboard.exe`.

Rust tests run with `cargo test` from `src-tauri/`.

Debug builds keep their settings, workspace, favorites, and layouts in
`%APPDATA%\dev.bashboard\dev`, so a `pnpm tauri dev` run never restores or overwrites the
installed app's workspace. The first debug run copies the installed app's `settings.json` there.

## New panes in the current folder

A new pane opens in the focused pane's working directory. Git Bash does not report its working
directory by default, so add these lines to `~/.bashrc`, below any prompt framework's init line
(such as `eval "$(starship init bash)"`):

```sh
PS0="${PS0-}"'\e]133;C\e\\'
__bashboard_prompt() {
  local status=$?
  printf '\e]133;D;%s\e\\' "$status"
  printf '\e]9;9;%s\e\\' "$(cygpath -w "$PWD")"
  return "$status"
}
PROMPT_COMMAND="__bashboard_prompt${PROMPT_COMMAND:+;$PROMPT_COMMAND}"
```

They add to `PS0` and `PROMPT_COMMAND` instead of replacing them, and hand the last command's
exit status on, so a prompt such as Starship keeps its own hooks and its error indicator.
Without them, new panes start in the home directory. Any shell that emits OSC 7 works too.
The OSC 133 markers (`PS0` and the first `printf`) tell the app exactly when a command starts
and finishes, which drives each terminal's working or idle status. In a pane without them, status follows a
check of the shell's processes every 2 seconds, so it can lag by up to that long.

## Pane CLI

`bb` is a small console program that lets a shell in a pane drive Bashboard. Each command that
opens a pane splits the pane that ran it, in that pane's tab, and focus moves to the new pane.

| Command                   | What it does                                                                |
| ------------------------- | --------------------------------------------------------------------------- |
| `bb open <path>`          | Shows a folder in a Files pane, or a file's folder with the file selected   |
| `bb edit <path>[:<line>]` | Opens the file or folder in your preferred editor, at the line when given   |
| `bb git`                  | Opens the Git pane for the current folder's repo                            |
| `bb search [<query>]`     | Opens a Search pane for the current folder's repo, with the query filled in |
| `bb scratch [<text>]`     | Opens a scratch pad holding the text, or the piped standard input           |
| `bb help`                 | Lists the commands (`bb`, `bb -h`, and `bb --help` do the same)            |

Add `--collapsed` anywhere in a command to open the pane collapsed. Relative paths resolve
against the folder `bb` runs in, and `open` and `edit` need the path to exist. `bb edit
src/main.ts:40` splits a trailing `:<digits>` off as the line number, which must be 1 or more.
`bb git` reports "not a git repository" outside a repo, while `bb search` outside a repo searches
the current folder. `bb scratch` uses its arguments as the text when it has any and otherwise
reads standard input, up to 1 MiB.

```sh
bb open docs
bb edit src/main.ts:40
git diff | bb scratch
bb search TODO
bb git --collapsed
```

`bb` works in all four shells because Bashboard puts the folder holding `bb.exe` first on every
pane's `PATH`. `bb help` works anywhere; outside a Bashboard pane every other command prints
`bb: only works inside a Bashboard pane` and exits 1. Any failure, such as a missing path, an
unknown option, or an app that cannot be reached, prints a `bb: ` message to standard error and
exits 1. A successful command prints nothing and exits 0.

## PowerShell, Windows PowerShell, and Command Prompt

Besides Git Bash, a pane can run PowerShell 7, Windows PowerShell, and Command Prompt. Each
is offered only when its program is installed, and Command Prompt is always available. PowerShell
7 (`pwsh.exe -NoLogo`) is found on `PATH` or at `%ProgramFiles%\PowerShell\7\pwsh.exe`. Windows
PowerShell (`powershell.exe -NoLogo`) is found at
`%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe`. Bashboard looks once per run, so
restart it after installing PowerShell 7. Set `shell.defaultProfile` to `gitBash`, `pwsh`,
`powershell`, or `cmd` to choose what a plain split runs, and press Alt+Shift+T to split with a
shell of your choice. A terminal's shell is saved with the workspace and restored on relaunch;
terminals not running Git Bash show a badge in the dashboard.

Command Prompt reports its folder automatically: Bashboard sets its `PROMPT` to emit the working
directory (OSC 9;9) ahead of your own `PROMPT`, so new panes open in the same folder. cmd cannot
emit the OSC 133 markers, so its working or idle status comes from the check of the shell's
processes every 2 seconds.

PowerShell 7 and Windows PowerShell do not report their folder until you tell them to. This follows Microsoft's
[Windows Terminal shell integration](https://learn.microsoft.com/en-us/windows/terminal/tutorials/shell-integration)
guidance for the working directory: add the following to your PowerShell profile (open it with
`notepad $PROFILE`). It wraps whatever `prompt` you already have and emits the folder (OSC 9;9)
ahead of it, so new panes open in the same folder. The same snippet works in Windows PowerShell. Place it after any prompt framework's init
line, such as `oh-my-posh init`:

```powershell
$Global:__BashboardOriginalPrompt = $function:prompt

function Global:prompt {
  $exit = $global:LASTEXITCODE
  $loc = $executionContext.SessionState.Path.CurrentLocation
  $out = "`e]9;9;`"$loc`"`a" + (& $Global:__BashboardOriginalPrompt)
  $global:LASTEXITCODE = $exit   # keep the last native exit code visible to the user
  return $out
}
```

The snippet deliberately leaves out the OSC 133 markers from Microsoft's example. Bashboard uses
the markers exclusively once a pane emits any of them, and PowerShell has no reliable hook for
the command-started marker (`C`), so a pane emitting only the others would show as idle while a
command runs. Like Command Prompt, a PowerShell pane's working or idle status comes from the
check of the shell's processes every 2 seconds.

## Tabs

A tab holds its own arrangement of panes. The tab strip across the top appears when there are
two or more tabs. Each tab shows a status dot, its title, and a close button on hover; the active
tab is marked, and a tab pulses when one of its terminals needs you. Click a tab to switch to it,
double-click to rename it (an empty name follows the focused terminal's title), and drag to
reorder. The "+" button adds a tab. Hold a dragged pane over a tab for half a second to switch
to it, so the pane can dock there.

Ctrl+Shift+T opens a new tab and Ctrl+Shift+W closes the current one (it asks first when a
terminal there is busy or a scratch pad there has text). Ctrl+Tab and Ctrl+Shift+Tab move to the next and previous tab,
Ctrl+Alt+1 through Ctrl+Alt+8 switch to that tab, and Ctrl+Alt+9 switches to the last one.

## Scratch pads

A scratch pad is a plain text pane for drafting a prompt or keeping notes beside your terminals.
Ctrl+Shift+N (the `newScratch` action) opens one as a split of the focused pane. The kind menu,
the first control on every title strip, turns a pane into another kind in place; it asks first
when the pad has text or the terminal is running a command. A pad's title is its first non-empty
line.

A pad saves itself about half a second after you stop typing and comes back with the workspace
on relaunch. Its toolbar has four buttons:

- **Send** (Ctrl+Enter) pastes the pad's text into the tab's most recently focused terminal
  without pressing Enter, so you can review it there first. It is disabled in a tab with no
  terminal.
- **Copy** puts all of the text on the clipboard.
- **Clear** empties the pad.
- **Save as** writes the text to a file.

Ctrl+W on a pad with text asks first, and closing a tab lists the pads in it that have text.

## Files panes

A Files pane browses a repo's folders and previews the selected file. Ctrl+Shift+E (the
`openFiles` action) opens one at the root of the focused pane's repo (the folder itself when it is
not in a git repo), as a split of the focused pane. When the active tab already has a Files pane
for that repo, Ctrl+Shift+E focuses it instead (expanding it if collapsed). The kind menu on a
title strip lists Files too, and so does the Open menu on dashboard rows (see
[Dashboard](#dashboard)). A Files pane comes back on relaunch in the same folder with the same
file selected, and layouts keep it.

The left side is a breadcrumb over the list of the current folder, with folders first and then
files, newest first. The breadcrumb has back and forward buttons (the mouse back and forward
buttons work over the pane too), the path from the repo root (click a segment to go there), Open
terminal here, and a pin button for the folder. Click a row to select and preview it, and press
Enter or double-click to open it: a folder is entered, a file opens in your editor. Up and Down
move the selection, Backspace goes up a folder, typing filters the list by name (Backspace edits
the filter, Esc clears it), and the list refreshes when files change on disk. The divider between
the list and the preview can be dragged.

The preview depends on the file:

- **Markdown** (`.md`) is rendered. Links to other files in the repo open in the pane, `http` and
  `https` links open in your browser, and other links do nothing. Images are never loaded; their
  alt text is shown instead. An Edit toggle switches to the text editor and back.
- **Text and code** show line numbers. Text files (`.txt`, or no extension) open in the text
  editor; code files are read-only, and you open them in your editor.
- **Binary and large files** (over 2 MiB, or containing NUL bytes) show a notice with the name and
  size and an Open in editor button.

The text editor saves about a second after you stop typing, when it loses focus, and on Ctrl+S.
If the file changes on disk while you have no unsaved edits, it reloads in place. If it changes
while you do (or a save finds it changed), a bar offers Reload, which discards your edits, or Keep
mine, which overwrites the file.

Hover a row for its menu: **Open terminal here** (folders), **Open in editor**, **Copy path**,
**Insert path** (pastes the path relative to the repo, or the absolute path outside it, into the
tab's most recently focused terminal without pressing Enter), **Move to** (files; the repo's pinned
folders and the current folder's subfolders), and **Pin**.

### Pins

Pins are the files and folders you keep close in a repo. Pin the current folder from the
breadcrumb, or any row from its menu; they appear in the dashboard's Repo section, where a click
opens one (a folder in a Files pane, a file in its folder with the file selected), its rename
button renames it, a handle drags it to reorder, and its remove button removes it. A pin whose file or folder is gone is
dimmed and does nothing.

Pins are kept in `repos.json` next to `settings.json`, as a list of entries, each with a repo
`root` and its `pins`. A pin's
`path` is relative to the root with forward slashes when it is inside the repo, and absolute
otherwise; `label` is optional. Roots and pins match without regard to case. The file is plain
JSON you can edit by hand, and the panel updates when you save it.

## Git pane

A Git pane shows a repo's status and lets you stage, commit, and undo the last commit without
leaving Bashboard. Ctrl+Shift+G (the `openGit` action) opens one at the root of the focused pane's
repo, as a split of the focused pane. When the active tab already has a Git pane for that repo,
Ctrl+Shift+G focuses it instead (expanding it if collapsed). In a folder outside a repo,
Ctrl+Shift+G shows a toast and opens nothing. The kind menu on a title strip lists Git too, and so
do the Repo section and the Open menu on dashboard rows, which offer Git only for a git repo (see
[Dashboard](#dashboard)). A Git pane comes back on relaunch on the same repo, and layouts keep it.

The left side stacks four regions, and the diff for the selected file or commit sits on the right:

- **Branch line** shows the branch, its upstream, and how many commits it is ahead and behind. A
  detached HEAD is shown as such.
- **Commit box** takes a multi-line message. Commit is enabled when something is staged and the
  message is not blank. Ctrl+Enter in the box also commits. Commit runs the repo's hooks as usual,
  so a failing `pre-commit` hook stops the commit: its output shows under the box and your message
  stays in it.
- **Staged** and **Changes** list the files. Changes holds unstaged, untracked, and conflicted
  files, each with its status letter. Hover a row for **Stage** or **Unstage** and **Open in
  editor**. The button in a list's header stages or unstages every row in it. A rename shows as
  `old -> new`.
- **Recent commits** lists the last 20 commits with subject, short hash, and relative time. A commit
  that no remote-tracking branch contains is marked unpushed.

Click a file row to see its diff: the unstaged change for a row in Changes, or the staged change for
a row in Staged. An untracked file shows its whole content as added. Click a commit to see its
changes. A diff over 1 MiB is cut off with a note that it was truncated.

**Undo commit** appears above the diff when you select the newest commit, and only while it is HEAD. The confirm
names the commit, and warns when it is already pushed: undoing it rewrites history the remote
has, so you'll need to force push afterward. Afterward the commit's changes are staged again and its
message goes back into the commit box, ready to edit and commit again. The undo is refused, and the
reason shows beside the button, when HEAD has moved since the pane loaded, the commit has no
parent, or a merge, rebase, cherry-pick, or revert is in
progress.

The pane refreshes when git changes the repo's `HEAD`, index, or refs (the watcher skips the
`objects` folder, and changes are debounced about 300 ms), when its window regains focus, and when
it comes back on screen. A pane in a background tab or a collapsed pane does not refresh until it is
shown again. A pane whose folder is outside a repo, or no longer exists, shows a notice in place of
its body.

The pane runs `git` from `PATH`, or else from the Git for Windows install that Git Bash comes from.
Without either, the pane shows git's "not found" error in its body.

Opening a Git pane runs `git status` and `git diff` in the repo, and a repo's own git config can
make those run programs (`core.fsmonitor`, diff and textconv drivers), as it can for `git` in a
terminal. Only open Git panes on repos you trust.

## Code search

A Search pane searches the files of a repo for a text or regex query and lists the matching lines.
Ctrl+Shift+H (the `openSearch` action) opens one for the focused pane's repo, as a split of the
focused pane. Outside a repo, it searches the folder itself. The Repo section's Search button, the
Open menu on dashboard rows, and the kind menu on a title strip open one the same way. Each of them
always adds another Search pane, even when the tab already has one. When the focused terminal has a
selection that is a single line, that text becomes the starting query.

The top bar has a query field, three toggles (**Match case**, **Whole word**, and **Regex**), and
**Files to include**. Without Regex, the query is literal. Files to include takes comma-separated
globs, such as `*.ts, src/**`; a glob with no slash matches a file name at any depth, as in a
`.gitignore`. Includes apply after the ignore rules below, so a glob cannot bring back a file that
is skipped.

The search walks the folder and honors `.gitignore` and `.ignore` files and git's global excludes,
inside a repo or not. Hidden files and folders are skipped, including `.git`. Files over 2 MiB and
files containing a NUL byte are skipped.

Results list file names that match first, under **File names**. Below them, each file with matching
lines gets a collapsible group showing its relative path and match count, and each matching line
shows its line number with the hits highlighted. The footer counts the results and files. The list
stops at the first 5,000 matching lines, and the footer says so; narrow the search to see the rest.

A search starts 250 ms after you stop typing in the query field or changing a toggle or include
glob, and Enter runs it at once. A new search cancels the previous one, so the list only ever shows
the latest query. An invalid regex or include glob shows its message under the fields.

Up and Down move through the file names and matching lines, and the preview on the right shows the
selected file with its line highlighted. The divider between the list and the preview can be
dragged. Enter, a double click on a matching line, or the Open button that shows on a hovered or
selected row opens that file in your preferred editor at the line; a file name, or the Open button
on a file's group header, opens it with no line. A file the preview cannot show, because it is binary or
over 2 MiB, shows a notice with an Open in editor button.

The pane's query and options are saved with the layout. A Search pane comes back on relaunch with
its query and options, and a non-empty query runs again as soon as the pane loads.

## Font size

Ctrl+= (or Ctrl+numpad +) enlarges the terminal font, Ctrl+- shrinks it, and Ctrl+0 resets it
to 14. Each step is 1 px, from 6 to 48, applies to every terminal, and is saved to `font.size` in
`settings.json`.

## Dashboard

The panel on the right opens on start (set `dashboard.visibleOnStart` to `false` to start
without it) and Ctrl+Shift+S toggles it, as does the × button at its top right. Drag its left
edge to make it wider or narrower; the width is saved with the workspace. **Panes** has a card for every pane in the order
they were opened (with two or more tabs, grouped under a header for each tab showing its name,
pane count, and status; click a header to switch to that tab). A terminal's card shows its status (a green check mark when it is done),
folder, and time since its status last changed; a card for any other kind of pane shows the
kind's icon and the pane's title. Click a card to focus its pane (for a pane hidden by a zoom, that brings it back and ends
the zoom in its tab), or use its close button, which
asks first when a Claude session is running there or a scratch pad has text. Click a section's
header to collapse or expand it; the choice is remembered across launches. **External sessions** lists Claude Code sessions running outside Bashboard, such as in
Windows Terminal or VS Code; click one to see its folder and session id with copy buttons. The
section appears only while there are some. Hover any favorite, recent folder, card, or session
for a folder button that opens its folder in File Explorer, and an Open menu beside it that opens
the row's repo root as a Terminal, as Files (see [Files panes](#files-panes)), as Git (see
[Git pane](#git-pane), for a git repo only), as Search (see [Code search](#code-search)), or in
your Editor.

**Repo** sits at the top and appears while the focused pane is in a folder (a scratch pad keeps the
last repo shown). Its header shows the repo folder's name and, in a git repo, the current branch, which follows
checkouts made in any shell while the dashboard is open. Its buttons open a Terminal, Files, Git
(for a git repo only), Search (see [Code search](#code-search)), or your Editor at the repo root.
Below them are the repo's pinned files and folders (see [Pins](#pins)).

**Favorites** sit above the terminals. Click one to open a terminal there as a split of the
focused pane, or Ctrl+click to open it collapsed; the "+" button adds the focused terminal's
folder (and its shell, when that is not the default), and rows can be renamed, removed, and reordered by dragging. Below them, **Recent**
lists up to five folders from Claude sessions that are not already favorites, each with a star
to promote it. Ctrl+Shift+O opens a picker that filters your favorites as you type: Enter opens
the selection as a split and Ctrl+Enter opens it collapsed. When the focused pane has no room
for another split, a toast says so and the terminal opens collapsed.

### Layouts

**Layouts** sit below Favorites and save the active tab's arrangement of panes under a name: each
pane's kind, its folder and shell (for terminals), its collapsed state, and how the panes are split.
Scratch pads are saved as panes but open empty. The "+" button asks
for a name; saving under an existing name (any capitalization) asks before it replaces that
layout. Each row shows the name and pane count; click it to open the layout, and use the row's
buttons to rename it or remove it (removing asks first). Ctrl+Shift+P opens a picker that filters
your layouts as you type.

Opening a layout adds a tab named after the layout and leaves your other tabs alone. Layouts never
store Claude sessions, so opening one does not resume Claude. Layouts are kept in `layouts.json`
next to `settings.json`; it is plain JSON you can edit by hand, and the panel updates when you
save it.

Each title strip ends with collapse, zoom, and close buttons, in that order. The close button
closes the pane as Ctrl+W does.

Ctrl+Shift+M, or the collapse button on a pane's title strip, collapses a pane into its card; the
terminal keeps running. Click a collapsed card to expand it. With a single pane the title strip
stays out of the way and appears when you hover the top edge of the terminal.

Ctrl+Shift+Z, or the zoom button on a pane's title strip, fills the tab's pane area with the
focused pane, whatever its kind, and the same again restores the layout. The zoom button
appears when the tab has two or more expanded panes, and it pulses while a hidden pane in the
zoomed tab needs attention. Hidden panes keep their state, and terminals release their WebGL
contexts until the zoom ends. Zoom is per tab and is not saved. Splitting, closing, collapsing,
docking, expanding, or moving focus ends the zoom; moving focus ends it and then moves focus as
usual. Resizing does nothing while zoomed, and a tab with one pane cannot zoom.

Drag a title strip, a card, or a favorite or recent folder over a pane to dock it: each edge
splits that pane on that side, and the center swaps two terminals (a favorite or recent folder
docks by edges only). A collapsed card dropped on a center takes that pane's place and collapses
it.

Dropping on the 24 px band along an edge of the pane area docks the dragged pane along the whole
edge of the window, taking a third of the space (more when a third would be under the minimum
size). A drop that would leave a pane below the minimum size is refused with a toast. A folder
dropped on a band opens a terminal docked on that edge.

On relaunch, Bashboard reopens your tabs and the active tab, with the terminals you had in the same
folders, layout, and collapsed state, and types `claude --resume <session id>` into each one that was running a Claude session.
Scrollback is not restored.

When a terminal starts waiting while the panel is hidden, the panel peeks open over the panes for
a few seconds and stays while the pointer is over it. Set `dashboard.peekOnWaiting` to `false`
to turn the peek off:

```jsonc
"dashboard": { "visibleOnStart": true, "peekOnWaiting": true }
```

Sessions come from the files Claude Code keeps in `~/.claude/sessions`. A session belongs to a
pane when its process descends from that pane's shell, so running `claude` in a pane names the
card after the session and shows when it is working, usually within about 10 seconds.

Each live Claude session also appears in the backdrop as its own colored lineage. It blooms
while the session is busy and thins while it is idle; set `backdrop.waitingPulse` to `true` to
also make it pulse while it waits for you. The color
matches the swatch beside the session in the dashboard.

### Containers

The **Containers** section of the dashboard lists Docker and Podman containers, grouped by Compose
project; a container with no project is its own row. Bashboard finds `docker.exe` and `podman.exe`
on `PATH` at startup, so Docker Desktop or Podman has to be installed. An engine whose CLI is
missing is left out. One that is installed but not running shows as "Docker is not running" or
"Podman is not running", and Bashboard checks it again every 10 seconds. The section appears while
an engine is found and `containers.enabled` is on (see [Settings](#settings)).

Each row shows the project's name, how many of its containers run ("1 of 2"), and, on hover, Start
when any is stopped or Stop when any is running. A project that exists on both engines is one row.
Click a row to open the Containers tab with that project expanded. Open Containers in the section's
header switches to a Containers tab that is already open, or adds one.

The **Containers pane** has a heading for each engine that is available, Docker and then Podman,
and its projects expand to their containers. A container row shows its service or container name,
image, status text, and published ports, which open `http://localhost:<port>` when clicked, and its
CPU and memory, refreshed every 5 seconds while the pane is on screen. Start, Stop, and Restart act
on a container or on a whole project. Logs opens a panel beside the list that follows the output,
starting with the last 500 lines and keeping the most recent 5000; scrolling up pauses following
until you scroll back to the end. Shell opens a terminal split beside the pane, running `bash` in
the container when it has one and `sh` otherwise, titled with the container's name. It needs a
running container.

Container shells are not restored on relaunch and are not saved in layouts. The Containers pane
itself is.

## Claude Code hooks

Without hooks, Bashboard learns a Claude session's state from its session file. Hooks add what
the file cannot: a `waiting` status when Claude needs you, and exact transitions as they
happen. They map to status like this:

| Event | Effect |
| --- | --- |
| `SessionStart` | Binds the session to its pane |
| `UserPromptSubmit` | `busy` |
| `Notification` | `waiting` (permission prompt or idle prompt) |
| `Stop` | `idle`, shown as `done` until you focus that pane |
| `SessionEnd` | Unbinds the session |

Each pane's shell has `BASHBOARD_HOOK_URL`, `BASHBOARD_HOOK_TOKEN`, and `BASHBOARD_PANE_ID` set,
and the hook script posts the event to the app with the pane id, which binds the session to its
pane. The script does nothing outside a Bashboard pane, so the same global hooks are harmless
in Windows Terminal or VS Code.

Open the dashboard and click **Install Claude Code hooks**, or use the Claude Code step of the
setup wizard. The install needs `bash.exe` on `PATH`
(Git for Windows) and refuses with an explanation without it. It shows the JSON it will add and
writes only after you confirm. It writes `~/.claude/hooks/bashboard-hook.sh` and appends one
group per event to `~/.claude/settings.json`; your existing hooks are left untouched, and an
event that already has the Bashboard hook is skipped. If `settings.json` has comments or other
non-JSON syntax, the install refuses and changes nothing. The button appears only when Claude Code
has run on this machine (`~/.claude` exists when Bashboard starts) and is hidden once everything
is installed. Claude sessions started after the install report `waiting`.

To add them by hand, copy `hooks/bashboard-hook.sh` to `~/.claude/hooks/` and add this group to
the `SessionStart`, `UserPromptSubmit`, `Notification`, `Stop`, and `SessionEnd` arrays under
`hooks` in `~/.claude/settings.json`:

```json
{ "hooks": [ { "type": "command", "command": "bash ~/.claude/hooks/bashboard-hook.sh", "timeout": 5 } ] }
```

When a terminal starts waiting or rings the bell, its pane border (or its card, if collapsed)
pulses until you look at it, and the taskbar button flashes if the window is unfocused. A
terminal you are already looking at (the focused pane in a focused window) is not marked.

When a Claude session's turn ends, its `Stop` hook marks the terminal `done` unless you are
looking at it. The status dot becomes a still green check mark on the terminal's title strip,
card, and tab. It clears when you focus that pane (typing in it focuses it), or
as soon as the session starts working or waits. `done` applies to terminals only, raises no
pulse, taskbar flash, or peek, and is not saved, so restored terminals start without it.

## Settings

Settings live at `%APPDATA%\dev.bashboard\settings.json`. The file is created with defaults
on first run, accepts `//` comments, and reloads when you save it. An invalid value falls back
to its default and shows a notice naming the field. If a save leaves the file as invalid JSON,
the running settings stay in effect and a notice appears until the file is fixed.

On first launch, a setup wizard picks the default shell, the editor, favorite repos, the Claude
Code hooks, and the look. Each choice saves as soon as you make it, and **Run setup** in the
settings dialog reopens the wizard. The Claude Code hooks step appears only when Claude Code is
detected and the hooks are not yet installed.

Most settings take effect on save. `dashboard.visibleOnStart` and `restore.*` apply at the next
launch, and `shell.*` applies to panes opened after the change.

`editor.preferred` picks the editor that Open in editor uses: `zed`, `vscode`, `cursor`,
`visualStudio`, `notepadpp`, `sublime`, or `default` (the file's default app). If the chosen editor
is not installed or will not start, the file opens in the default app and a toast says so.
`editor.command` replaces the editor with your own command line, for example
`code.cmd -g "{path}:{line}"`. Double quotes group an argument, and no shell runs it, so the
program name must include its extension when it is a shim such as `code.cmd`. `{path}` and
`{line}` are filled in wherever they appear (and only there; a command without `{path}` gets no
path), and `{line}` is 1 when no line applies. The Editor section of the settings dialog sets both
fields and lists only the editors it found.

Press F1, or click Keyboard shortcuts at the bottom of the dashboard, for a guide to every key
in effect, including your own bindings.

Most settings can also be changed from the Settings button at the bottom of the dashboard or with
Ctrl+Comma. Changes save to settings.json and keep its comments; keybindings are edited in the file.

Entries in the `keybindings` list add to or override the default keys. To remove a default so
the key reaches the shell, add an `unbound` entry. Ctrl+W closes a pane by default, so this
gives it back to bash's delete-previous-word:

```jsonc
{ "keys": "ctrl+w", "action": "unbound" }
```

The `switchToTab` action takes an `index` from 1 to 8 for that tab; the default keys bind
Ctrl+Alt+1 through Ctrl+Alt+8 to it:

```jsonc
{ "keys": "ctrl+alt+1", "action": "switchToTab", "index": 1 }
```

The background animation (the backdrop) renders at up to 60 frames per second. Raise or
lower that with `backdrop.maxFps` (0 for the display's refresh rate), or set `backdrop.animate`
to `false` to freeze it on a still frame. Ctrl+Shift+L pauses or resumes the animation and
saves the choice to that setting. The simulation itself is tuned with `speed` (generations per
second, 0.25 to 12), `capacity` (the population it sustains, 300 to 5000), `mutationRate` (0 to
4), `lineageThreads` (faint lines from parents to offspring), `orbit` (a slow camera orbit,
held still while Windows animation effects are off), `zoom` (0.5 to 3; above 1 brings the colony
closer so it fills more of the window), and `waitingPulse` (a steady brightness pulse on a
waiting Claude session's organisms, off by default). All of these are also in the Background
Animation section of the settings dialog:

```jsonc
"backdrop": {
  "animate": true,
  "maxFps": 60,
  "speed": 2,
  "capacity": 5000,
  "mutationRate": 4,
  "lineageThreads": false,
  "orbit": true,
  "zoom": 1,
  "waitingPulse": false
}
```

`shell.defaultProfile` picks the shell a plain split runs: `gitBash` (the default), `pwsh`
(PowerShell 7), `powershell` (Windows PowerShell), or `cmd`. An unknown value falls back to
`gitBash` with a notice. A profile that is not installed falls back to the first available profile
in the order Git Bash, PowerShell 7, Windows PowerShell, Command Prompt, with a notice the first
time each missing shell is asked for. `shell.path` and `shell.args` configure Git Bash only. The
Default shell select in the Terminal section of the settings dialog sets it too (see
[PowerShell, Windows PowerShell, and Command Prompt](#powershell-windows-powershell-and-command-prompt)):

```jsonc
"shell": { "defaultProfile": "gitBash" }
```

Restore on relaunch is controlled by `restore.enabled` (reopen the saved terminals) and
`restore.resumeClaude` (type `claude --resume` into terminals that had a Claude session); both
default to `true`:

```jsonc
"restore": { "enabled": true, "resumeClaude": true }
```

`containers.enabled` (default `true`) shows or hides the Containers section of the dashboard. The
Containers pane and tab still open on request.

```jsonc
"containers": { "enabled": true }
```

Bashboard also keeps `favorites.json`, `layouts.json`, `repos.json`, and `workspace.json` next to
`settings.json`. Bashboard rewrites `workspace.json` itself (version 3, holding every tab);
`favorites.json`, `layouts.json`, and `repos.json` are plain JSON you can edit by hand, and the
panel updates when you save them.

The schema and the default keys are in [docs/design.md](docs/design.md) sections 4.5 and 8.

## Find and links

Ctrl+Shift+F opens a find bar over the top-right of the focused pane. Matching is
case-insensitive and updates as you type; Enter moves to the next match and Shift+Enter to the
previous. Esc closes the bar and returns focus to the terminal. The bar also closes when its
pane closes or collapses, or when focus moves to another pane.

Ctrl+click a link in terminal output to open it in your browser. Only `http` and `https` links
open; other schemes are ignored.

## Releasing

`pnpm tauri build` produces the release app and an NSIS installer at
`src-tauri\target\release\bundle\nsis\*-setup.exe`. The
`.github/workflows/ci.yml` workflow runs the type check, tests, and Rust tests on every push to
`main` and every pull request, then builds the installer and uploads it as the
`bashboard-installer` artifact on the workflow run.

Before each release, run through this keyboard checklist in a `pnpm tauri dev` session or the
built app:

- Ctrl+F, Ctrl+R, and Ctrl+P reach the shell
- Alt+B and Alt+F move by word
- Shift+Enter sends a newline to Claude Code
- Esc reaches the shell or a running program
- copy (Ctrl+Shift+C, or Ctrl+C with a selection) and paste (Ctrl+V, Ctrl+Shift+V)
- resize a pane with Alt+Shift+Arrow
- Ctrl+Shift+F finds in scrollback, and Ctrl+click opens a link
- Ctrl+Shift+T, Ctrl+Shift+W, Ctrl+Tab, Ctrl+Shift+Tab, and Ctrl+Alt+1 through 9 work on tabs;
  confirm WebView2 does not take Ctrl+Tab
- Alt+Shift+T opens the shell picker
- Ctrl+Shift+N opens a scratch pad, and Ctrl+Enter in it sends to the tab's last terminal
- Ctrl+Shift+E opens a Files pane at the focused pane's repo root, or focuses the tab's existing
  one for that repo
- Ctrl+Shift+G opens a Git pane at the focused pane's repo root, or focuses the tab's
  existing one for that repo
- Ctrl+Shift+H opens a Search pane at the focused pane's repo root, and Enter in its query field
  runs the search
- Ctrl+Shift+Z zooms the focused pane, restores the layout on a second press, and does nothing
  in a tab with one pane
- Ctrl+=, Ctrl+numpad +, Ctrl+-, and Ctrl+0 change the font size; confirm WebView2 does not take
  Ctrl+=

## Debugging input

Set `BASHBOARD_KEYLOG` to a file path before launching, and every keystroke and paste sent to a
shell is appended there, escaped (for example `\u{6}` for Ctrl+F). Use it to confirm a key
combination actually reaches the shell rather than being taken by WebView2 or xterm.js.

```sh
BASHBOARD_KEYLOG=/tmp/keys.txt pnpm tauri dev
```

To exercise the first-run wizard on a machine that has the installed app, set
`BASHBOARD_NO_DEV_SEED=1` on the `pnpm tauri dev` run. It skips copying the installed app's
`settings.json` into the dev folder, so with the dev `settings.json` removed, that launch
creates the file and opens the wizard.

## License

MIT, see [LICENSE](LICENSE).
