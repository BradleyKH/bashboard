# User guide

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
Enter or double-click to open it: a folder is entered, a file opens in your editor. Ctrl+click
adds or removes a row, Shift+click (or Shift+Up and Down) selects a range, and Ctrl+A selects
every row, as in File Explorer. Up and Down move the selection, Backspace goes up a folder, typing filters the list by name (Backspace edits
the filter, Esc clears it), and the list refreshes when files change on disk. The divider between
the list and the preview can be dragged.

The preview depends on the file:

- **Markdown** (`.md`) is rendered. Links to other files in the repo open in the pane, `http` and
  `https` links open in your browser, and other links do nothing. Images are never loaded; their
  alt text is shown instead. An Edit toggle switches to the text editor and back.
- **Text and code** open in the text editor, which saves as you type. Text files (`.txt`, or no
  extension) wrap long lines; every other text file (code, JSON, YAML, HTML, and so on) shows line
  numbers and scrolls sideways instead. A file that is not valid UTF-8 (an older encoding such as
  Latin-1) opens read-only, so saving can't mangle its characters.
- **Binary and large files** (over 2 MiB, or containing NUL bytes) show a notice with the name and
  size and an Open in editor button.

Text previews have a Find button (or Ctrl+Shift+F in the Files pane) that searches the file,
ignoring case, and highlights every match. Enter and Shift+Enter step through them, and Esc
closes the bar and selects the current match, so the editor's caret lands on it. The − and +
buttons beside Find zoom the preview, and the pair in the breadcrumb zooms the list. A new Files
pane starts at the zoom you last chose for each.

The Expand preview button after the zoom buttons fills the pane with the preview and shows the
file's name in the toolbar. The same button, or Esc (a second Esc when the find bar is open),
brings the list back. The expanded state is kept on relaunch and in layouts.

The text editor saves about a second after you stop typing, when it loses focus, and on Ctrl+S.
If the file changes on disk while you have no unsaved edits, it reloads in place. If it changes
while you do (or a save finds it changed), a bar offers Reload, which discards your edits, or Keep
mine, which overwrites the file.

Hover a row for its menu: **Open terminal here** (folders), **Open in editor**, **Copy path**,
**Insert path** (pastes the path relative to the Files pane's root, or the absolute path outside
it, quoted for the shell of the tab's most recently focused terminal, without pressing Enter),
**Move to** (files; the repo's pinned
folders and the current folder's subfolders), and **Pin**. With several rows selected, the menu
offers Copy paths, Insert paths, and Move to for all of them.

Drag files onto a folder row to move them there, for example a finished plan into `done/`. A
breadcrumb segment takes them too (to move them back up), and so does another Files pane's list,
for the folder it shows. The folder highlights and the drag reads "Move to <folder>"; a drag that
includes a folder only inserts paths.

### Dragging paths onto terminals

Drag files from File Explorer, or rows from a Files pane, a Search pane (match rows, file headers,
and file name rows), or a Git pane (Staged and Changes), onto an expanded terminal or a scratch
pad. A terminal highlights while a path is over it; dropping pastes the paths without pressing
Enter and focuses the terminal, and a scratch pad takes them at its caret. Paths inside the
terminal's repo are relative, others are absolute, and paths with spaces or special characters are
quoted for the shell. Holding a drag over a tab for half a second switches to it.

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
  detached HEAD is shown as such. It also holds a last fetch label ("Fetched 3 min ago", or "Fetch
  failed" with git's output as its tooltip) and the **Fetch**, **Pull**, and **Push** buttons.
  Fetch runs `git fetch --prune`. Pull shows how many commits you are behind and runs
  `git pull --ff-only`, so it never merges. Push sends your commits; on a branch with no upstream
  it reads **Publish** and pushes to `origin` (or the repo's only remote) and sets the upstream.
  Publish is disabled, with a tooltip, in a repo with no remote or with several and none named
  `origin`. The three buttons are disabled while one runs, and a failure shows git's output under
  the commit box.
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
changes. A diff over 1 MiB is cut off with a note that it was truncated. The − and + buttons above
the diff zoom it, and a new Git pane starts at the zoom you last chose.

Push never forces. A rejected push shows git's message, and after undoing a pushed commit the
force push stays in a terminal.

Bashboard fetches in the background for every repo with an open Git pane, every
`git.autoFetchMinutes` (5 by default; see [Settings](settings.md#settings)), so the behind count and the
label stay current. It pauses while the window is minimized or hidden and catches up when you come
back. A background fetch never prompts for credentials, and after three failures in a row it stops
for that repo until you press Fetch; a manual Fetch, Pull, or Push may show Git Credential
Manager's sign-in window.

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
shown again. A pane whose folder is outside a repo or missing shows a notice in place of its body.

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

## Dashboard

The panel opens on the right (or the left, with `dashboard.side`) on start (set
`dashboard.visibleOnStart` to `false` to start without it) and Ctrl+Shift+S toggles it, as does
the × button at its top right. F6 moves focus
into it (showing it for the moment if it is hidden), where the arrow keys move between rows, Enter
clicks the focused row, Left and Right collapse and expand sections, Tab reaches a row's buttons,
and F6 or Escape returns to the pane. Drag its inner
edge to make it wider or narrower; the width is saved with the workspace. **Panes** has a card for every pane in the order
they were opened (with two or more tabs, grouped under a header for each tab showing its name,
pane count, and status; click a header to switch to that tab). A terminal's card shows its status (a green check mark when it is done),
folder, and time since its status last changed, plus, while a Claude session runs in it, the model
and the tokens in its context (as "Opus 5.5 · 112k tokens") on a line below the folder; a card for any other kind of pane shows the
kind's icon and the pane's title. Click a card to focus its pane (for a pane hidden by a zoom, that brings it back and ends
the zoom in its tab), or use its close button, which
asks first when a Claude session is running there or a scratch pad has text. Click a section's
header to collapse or expand it; the choice is remembered across launches. Drag a section's
header, or the clock, to put the sections in a different order; that is remembered too. Settings
shows or hides each one (see [Settings](settings.md#settings)). **External sessions** lists Claude Code sessions running outside Bashboard, such as in
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

The **clock**, which is off by default, is one line at the top of the panel, above Repo: three
columns of dots showing the hours (24-hour), minutes, and seconds in binary, and the time as
`h:mm` beside them. Drag it down among the other sections to move it there, or back to the top.
It ticks only while the panel is on screen.

The **System** section is off by default; turn it on under "Show on the
dashboard" in Settings. It shows CPU use with a 60 second sparkline, memory used of total,
network receive and send rates with a sparkline for each, and free space on each fixed drive, with bars that turn amber at
80% and red at 90%. CPU and network fill in on the second sample after the section starts. It
samples only while it is expanded, the panel is on screen, and the window is shown.

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
buttons to rename it or remove it (removing asks first). Ctrl+Shift+R opens a picker that filters
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

To move a pane to another tab without leaving the one you're in, drag its title strip or card onto
that tab's group in the dashboard's Panes section. An expanded pane splits that tab's focused pane
(or lands collapsed when there's no room), and a collapsed one stays collapsed.

Dropping on the 24 px band along an edge of the pane area docks the dragged pane along the whole
edge of the window, taking a third of the space (more when a third would be under the minimum
size). A drop that would leave a pane below the minimum size is refused with a toast. A folder
dropped on a band opens a terminal docked on that edge.

On relaunch, Bashboard reopens your tabs and the active tab, with the terminals you had in the same
folders, layout, and collapsed state, and types `claude --resume <session id>` into each one that was running a Claude session.
Scrollback is not restored.

When a terminal starts waiting while the panel is hidden, the panel peeks open over the panes for
a few seconds and stays while the pointer is over it. Set `dashboard.peekOnWaiting` to `false`
to turn the peek off. It comes in from the dashboard's side:

```jsonc
"dashboard": { "peekOnWaiting": true }
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
an engine is found and `dashboard.sections.containers` is on (see [Settings](settings.md#settings)).

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

## Attention and status

When a terminal starts waiting or rings the bell, its pane border (or its card, if collapsed)
pulses until you look at it, and the taskbar button flashes if the window is unfocused. A
terminal you are already looking at (the focused pane in a focused window) is not marked.

A waiting terminal shows why: the pane card, the status dot's tooltip on the title strip, the
tab's tooltip, and an external session's row carry the message from Claude's notification (for
example that it needs your permission to use a tool), or "Waiting for you" when there is none.

Ctrl+Shift+L jumps to the next terminal that needs you, across all tabs: waiting ones first,
oldest first, then done and failed ones. It switches to the pane's tab, expands a collapsed card,
and ends a zoom in the way. Repeated presses walk the list, and a toast says "Nothing needs you"
when it is empty.

When a Claude session's turn ends, its `Stop` hook marks the terminal `done` unless you are
looking at it. The status dot becomes a still green check mark on the terminal's title strip,
card, and tab. It clears when you focus that pane (typing in it focuses it), or
as soon as the session starts working or waits. `done` applies to terminals only, raises no
pulse, taskbar flash, or peek, and is not saved, so restored terminals start without it.

A long shell command marks its terminal the same way, with no Claude session needed. A command that
runs at least `terminal.doneAfterSeconds` and finishes while you are not looking at the terminal
marks it `done`, or `failed` (a still red cross) when it exited nonzero; Ctrl+C is not a failure.
Only Git Bash with the `~/.bashrc` lines from [New panes in the current folder](setup.md#new-panes-in-the-current-folder)
reports commands, and a bound Claude session's own status takes precedence.

## Command palette

Ctrl+Shift+P opens one list over your panes, tabs, favorites, layouts, the focused repo's pins and
worktrees, and the actions, each with its keys. Typing filters the list fuzzily, and a leading `>`
shows only actions. Enter focuses a pane, switches to a tab, opens a favorite, layout, pin, or
worktree, or runs an action; a favorite or worktree opens as a split, or collapsed with Ctrl+Enter.
With an empty box, your recent picks come first.

## Find and links

Ctrl+Shift+F opens a find bar over the top-right of the focused pane. Matching is
case-insensitive and updates as you type; Enter moves to the next match and Shift+Enter to the
previous. Esc closes the bar and returns focus to the terminal. The bar also closes when its
pane closes or collapses, or when focus moves to another pane.

Ctrl+click a link in terminal output to open it in your browser. Only `http` and `https` links
open; other schemes are ignored.

## Font size

Ctrl+= (or Ctrl+numpad +) enlarges the terminal font, Ctrl+- shrinks it, and Ctrl+0 resets it
to 14. Each step is 1 px, from 6 to 48, applies to every terminal, and is saved to `font.size` in
`settings.json`.

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
