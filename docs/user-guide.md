# User guide

- [Tabs](#tabs)
- [Scratch pads](#scratch-pads)
- [Files panes](#files-panes)
  - [Dragging paths onto terminals](#dragging-paths-onto-terminals)
  - [Pins](#pins)
- [Git pane](#git-pane)
  - [Branches tab](#branches-tab)
  - [New worktree](#new-worktree)
- [Ship pane](#ship-pane)
  - [Overview](#overview)
  - [A repo's view](#a-repos-view)
- [Code search](#code-search)
- [Dashboard](#dashboard)
  - [Layouts](#layouts)
  - [Containers](#containers)
  - [Ports](#ports)
- [Local Browser](#local-browser)
- [Codex, Copilot, and local AI models (preview)](#codex-copilot-and-local-ai-models-preview)
  - [Local AI models](#local-ai-models)
- [Attention and status](#attention-and-status)
- [Cloud context chip](#cloud-context-chip)
- [Command palette](#command-palette)
- [Find and links](#find-and-links)
- [Text size](#text-size)
- [Agent glow and border lights](#agent-glow-and-border-lights)
- [Help, settings, and shortcuts](#help-settings-and-shortcuts)
- [Pane CLI](#pane-cli)
- [Keys on macOS](#keys-on-macos)

This guide names the Windows keys. On macOS the app's keys move onto Cmd and every Ctrl and
Option chord goes to the shell; see [Keys on macOS](#keys-on-macos). The Shortcuts tab (F1, then
Shortcuts) always shows the keys for the machine you are on.

## Tabs

A tab holds its own arrangement of panes. The tab strip across the top appears when there are
two or more tabs. Each tab shows a status dot, its title, and a close button on hover; the active
tab is marked, and a tab pulses when one of its terminals needs you. Click a tab to switch to it,
double-click to rename it (an empty name follows the focused terminal's title), and drag to
reorder. The "+" button adds a tab. Hold a dragged pane over a tab for half a second to switch
to it, so the pane can dock there.

To move a pane into a tab of its own, right-click its title strip and choose Move to new tab, or
drag its title strip (or its dashboard card) onto the tab strip past the last tab and drop it
there. Either way the new tab opens with just that pane. The drop target needs the tab strip, so
with a single tab use the menu item. Neither is offered for a pane that is already alone in its
tab. A favorite or recent folder dropped in the same spot opens a new tab with a terminal there.

Ctrl+Shift+T opens a new tab and Ctrl+Shift+W closes the current one (it asks first when a
terminal there is busy or a scratch pad there has text). Ctrl+Tab and Ctrl+Shift+Tab move to the next and previous tab,
Ctrl+Alt+1 through Ctrl+Alt+8 switch to that tab, and Ctrl+Alt+9 switches to the last one.

Bashboard runs as one window. Launching it again while it is running brings that window to the
front instead of starting a second copy; launched from a shell or a folder (for example
`start bashboard` in Git Bash, or the exe run from Explorer's address bar), it also opens a new
tab in that folder. The Start menu and taskbar shortcuts just bring the window forward.

The installer also adds **Open in Bashboard** to Explorer's right-click menu, on a folder, a
drive, or the empty space inside a folder. It opens a new tab in that folder, starting Bashboard
first if it isn't running. On Windows 11 it is under **Show more options** (or Shift+F10).

## Scratch pads

A scratch pad is a plain text pane for drafting a prompt or keeping notes beside your terminals.
Ctrl+Shift+S (the `newScratch` action) opens one as a split of the focused pane. The kind menu,
the first control on every title strip, turns a pane into another kind in place; it asks first
when the pad has text or the terminal is running a command. A pad's title is its first non-empty
line.

A pad saves itself about half a second after you stop typing and comes back with the workspace
on relaunch. Its toolbar has four buttons, then a − and + pair at the right that zooms the text:

- **Send** (Ctrl+Enter) pastes the pad's text into the tab's most recently focused terminal
  without pressing Enter, so you can review it there first. It is disabled in a tab with no
  terminal.
- **Copy** puts all of the text on the clipboard.
- **Clear** empties the pad.
- **Save as** writes the text to a file, and the pad becomes a Files pane showing that file,
  ready to keep editing. Edits from then on save to the file. Esc or the Expand preview button
  brings back the folder's file list.

Ctrl+wheel over the pad zooms it too, and a new pad starts at the zoom you last chose.

Ctrl+W on a pad with text asks first, and closing a tab lists the pads in it that have text.

## Files panes

A Files pane browses a repo's folders and previews the selected file. Ctrl+Shift+E (the
`openFiles` action) opens one at the root of the focused pane's repo (the folder itself when it is
not in a git repo), as a split of the focused pane. When the active tab already has a Files pane
for that repo, Ctrl+Shift+E focuses it instead (expanding it if collapsed). The kind menu on a
title strip lists Files too, and so does the Open menu on dashboard rows (see
[Dashboard](#dashboard)). A Files pane comes back on relaunch in the same folder with the same
file selected, and layouts keep it.

The title strip, after the folder's name, has Open in File Explorer, Search in this folder (⌕,
which opens a Search pane limited to the folder), and Open terminal here, all for the current
folder.

The left side is a breadcrumb over the list of the current folder, with folders first and then
files, newest first. The breadcrumb has back and forward buttons (the mouse back and forward
buttons work over the pane too), the path from the repo root (click a segment to go there), a
sort button, zoom buttons for the list, and a pin button for the folder. The sort button sorts
files by **Name**, **Type** (extension), or **Modified**; pick the current one again to reverse
it. Folders always stay on top, A to Z (Z to A when you sort by name in reverse). Each Files pane
keeps its own sort. Click a row to select and preview it, and press
Enter or double-click to open it: a folder is entered, a file opens in your editor. Ctrl+click
adds or removes a row, Shift+click (or Shift+Up and Down) selects a range, and Ctrl+A selects
every row, as in File Explorer. Up and Down move the selection, Backspace goes up a folder, typing filters the list by name (Backspace edits
the filter, Esc clears it), and the list refreshes when files change on disk. F2 renames the
selected file or folder in place: Enter saves, and Escape or clicking away cancels. Delete sends
the selection to the Recycle Bin (Cmd+Backspace to the Trash on macOS), with no prompt since you
can restore it from there. Ctrl+C and Ctrl+X copy or cut the selection and Ctrl+V pastes into the
folder shown, as in File Explorer, and they work with File Explorer itself: copy there and paste
in a Files pane, or the other way round. Cut rows show dimmed until pasted. Pasting a copy into
its own folder names it `name - Copy`, as Explorer does; a name already taken anywhere else is
reported rather than overwritten. The divider between
the list and the preview can be dragged; until a file is selected, the list fills the pane.

The preview depends on the file:

- **Markdown** (`.md`) is rendered. Links to other files in the repo open in the pane, `http` and
  `https` links open in your browser, and other links do nothing. Images are never loaded; their
  alt text is shown instead. An Edit toggle switches to the text editor and back.
- **Text and code** open in the text editor, which saves as you type. Text files (`.txt`, or no
  extension) wrap long lines; every other text file (code, JSON, YAML, HTML, and so on) shows line
  numbers and scrolls sideways instead. A file that is not valid UTF-8 (an older encoding such as
  Latin-1) opens read-only, so saving can't mangle its characters.
- **CSV and TSV files** show as a table with the first row as a sticky header. Edit switches to
  the text editor and Done back to the table. Very long files show their first 5000 rows.
- **Images** (PNG, JPEG, GIF, WebP, BMP, ICO, AVIF, and SVG, up to 32 MiB) are fitted to the
  preview, with their size on the toolbar. Click the image, or Actual size, to see it at full
  size and scroll around; click again, or Fit, to fit it back. Transparent areas show a
  checkerboard, and the image updates when the file changes on disk.
- **Binary and large files** (other files over 2 MiB, or text containing NUL bytes) show a notice with the name and
  size, an Open with default app button (the app Windows uses for that file type, such as a PDF
  reader), and an Open in editor button. Programs, scripts, installers, and shortcuts get only
  Open in editor, so a click in the preview never runs them.

Text previews have a Find button (or Ctrl+Shift+F in the Files pane) that searches the file,
ignoring case, and highlights every match. Enter and Shift+Enter step through them, and Esc
closes the bar and selects the current match, so the editor's caret lands on it. The − and +
buttons beside Find zoom the preview, and the pair in the breadcrumb zooms the list; Ctrl+wheel
over either one zooms it as well. A new Files pane starts at the zoom you last chose for each.

In a code file, Ctrl+G (the `goToLine` action) opens a Line field beside Find: type a line
number, or `line:column` as compilers print it, and the editor scrolls there as you type and
marks the line. Enter or Esc puts you back in the editor with the caret on it. Anywhere else,
including a terminal, Ctrl+G goes to the shell, so Claude Code's own Ctrl+G still works.

The Expand preview button after the zoom buttons fills the pane with the preview and shows the
file's name in the toolbar. The same button, or Esc (a second Esc when the find bar is open),
brings the list back. The expanded state is kept on relaunch and in layouts.

The text editor saves about a second after you stop typing, when it loses focus, and on Ctrl+S.
The right end of the preview's toolbar shows where that stands: a dot while an edit waits to be
saved, then a brief "✓ Saved" once it reaches the disk (Ctrl+S shows it too when there is nothing
left to save). If a save fails, "⚠ Not saved" stays there until one succeeds, a toast gives the
reason with a Retry button, and the pane's title turns red; click the indicator to try again.
Edits that could not be saved are never thrown away: Done, moving, and renaming wait until they
are saved, and if you show another file or close the pane, they open in a new scratch pad. A
lock marks a file the editor opened read-only. If the file changes on disk while you have no unsaved edits, it reloads in place. If it changes
while you do (or a save finds it changed), a bar offers Reload, which discards your edits, or Keep
mine, which overwrites the file. Ctrl+Z undoes and Ctrl+Y redoes; Enter starts the next line at
the left edge, with no auto-indent. Tab indents the selected lines, or pads the caret to the next
indent stop, and Shift+Tab unindents. Indents match the file's own: tabs if it indents with tabs,
otherwise its usual number of spaces (two in a file with no indented lines yet). To move focus out
of the editor with the keyboard, press Esc and then Tab.

Code is colored by language, as a code editor does: HTML, CSS (and SCSS, Sass, and Less),
JavaScript and TypeScript (with JSX and TSX), JSON, C#, Python, Markdown, YAML, Rust, SQL, XML,
shell, PowerShell, TOML, and Dockerfiles, including the fenced blocks of rendered markdown and
the source in Edit. The Code colors setting picks the color scheme, or None to turn the colors
off everywhere and show every character in the text color (see
[Settings](settings.md#settings)).

Hover a row for its menu: **Open terminal here** and **Search in this folder** (folders), **Open in editor**, **Open in Local Browser** (an `.html` or `.htm` file, on Windows), **Cut**, **Copy**, **Paste** (a folder, into it), **Copy path**,
**Insert path** (pastes the path relative to the Files pane's root, or the absolute path outside
it, quoted for the shell of the tab's most recently focused terminal, without pressing Enter),
**Move to** (files; the repo's pinned
folders and the current folder's subfolders), **Rename**, **Pin**, and **Delete**. With several rows selected, the menu
offers Cut, Copy, Copy paths, Insert paths, Move to, and Delete for all of them. A right-click on
empty space below the rows, or on the breadcrumb, offers **Paste** into the current folder.

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

Pins are the files, folders, and commands you keep close in a repo, or in any folder outside one.
Pin the current folder from the breadcrumb, or any row from its menu; they appear in the
dashboard's **Pins** section (the heading collapses them), where a click
opens one (a folder in a Files pane, a file in its folder with the file selected), its rename
button renames it, a handle drags it to reorder, and its remove button removes it. A pin whose file or folder is gone is
dimmed and does nothing.

A **command pin** keeps a command you run often, such as
`dotnet run --project src/Project.Name.Api`, with a name and the folder it runs in. Add one with
the **+** at the right of the Pins heading, the pin button at the right of a terminal's title
strip, or New pin in the title strip's right-click menu; each opens a popup with Name and Command
fields, in the focused pane's or that terminal's folder (the strip's pin button fills Command with
any selected text).
Clicking the pin types the command into the focused terminal when it is idle and in that folder,
or into a new terminal opened there, without pressing Enter, so you choose when to run it. A new
terminal uses the focused terminal's shell, or your default shell when no terminal has focus. The
row shows a running mark while the terminal it last typed into is busy. Its pencil button, F2,
or Edit in its menu changes the name and command; the folder stays as it was pinned.

The popup's **Scope** chooses where the pin lists: **This repo** (**This folder** outside a git
repo), the default, or **Everywhere**. A global pin lists in the Pins section for every folder, after
the repo's own pins with a globe icon, and runs in the focused pane's folder, so it suits commands
like `git fetch --prune` or `pnpm install`. Changing Scope when you edit a pin moves it between the
two lists. The globe at the right of the Pins heading hides global pins from the section, which
keeps a long list out of the way; while they are hidden, a pin button in the dashboard's top bar
drops a menu of them, sorted by name. The command palette lists them too.

Pins are kept in `repos.json` next to `settings.json`, as a list of entries, each with a repo
`root` and its `pins`. A pin's
`path` is relative to the root with forward slashes when it is inside the repo, and absolute
otherwise; `label` is optional, and a command pin adds a `command`. Roots and pins match without regard to case. Global pins are
kept in `pins.json` beside it, as a list of `{ "label": ..., "command": ... }` entries. Both files
are plain JSON you can edit by hand, and the panel updates when you save them.

## Git pane

A Git pane shows a repo's status and lets you stage, commit, undo the last commit, and manage
branches without leaving Bashboard. Ctrl+Shift+G (the `openGit` action) opens one at the root of the focused pane's
repo, as a split of the focused pane. When the active tab already has a Git pane for that repo,
Ctrl+Shift+G focuses it instead (expanding it if collapsed). In a folder outside a repo,
Ctrl+Shift+G shows a toast and opens nothing. The kind menu on a title strip lists Git too, and so
do Launch and the Open menu on dashboard rows, which offer Git only for a git repo (see
[Dashboard](#dashboard)). A Git pane comes back on relaunch on the same repo and tab, and layouts
keep it.

Across the top, the branch line sits beside the **Changes** and **Branches** tabs. In Changes, the
commit box, file lists, and recent commits stack on the left, and the diff for the selected file
or commit sits on the right:

- **Branch line** shows the branch, its upstream, and how many commits it is ahead and behind. A
  detached HEAD is shown as such. It also holds a last fetch label ("Fetched 3 min ago", or "Fetch
  failed" with git's output as its tooltip) and the **Fetch**, **Pull**, and **Push** buttons.
  Fetch runs `git fetch --prune`. Pull shows how many commits you are behind and runs
  `git pull --ff-only`, so it never merges. Push sends your commits; on a branch with no upstream
  it reads **Publish** and pushes to `origin` (or the repo's only remote) and sets the upstream.
  Publish is disabled, with a tooltip, in a repo with no remote or with several and none named
  `origin`. The three buttons are disabled while one runs, and a failure shows git's output under
  the commit box. Click the branch name for the **branch switcher**: type to filter, Up and Down
  to move, Enter to switch. Remote branches are listed after local ones, and picking one checks it
  out. When what you typed is a new valid name, the last row creates that branch from HEAD and
  switches to it.
- **Size badge.** When the branch has grown past `git.branchSizeThreshold` (400 lines by default;
  see [Settings](settings.md#settings)), an amber chip after the branch name shows the line count,
  such as "512 lines". It counts the lines changed since the branch left its comparison ref
  (the Branches tab's "Compare with" choice), committed or not and untracked files included, and
  leaves out tests, lockfiles, and generated files such as EF Core's model snapshot, a Prisma
  `generated/` folder, drizzle-kit's `meta/*_snapshot.json`, and anything `.gitattributes` marks
  `linguist-generated`, `linguist-vendored`, or `-diff`; hover it for the added and removed lines, the file count, and
  what was left out. It disappears when the branch is back under the limit, and a threshold of 0
  turns it off. Session cards in the dashboard show the same chip on a terminal in an oversized
  branch.
- **Commit box** takes a multi-line message. Commit is enabled when something is staged and the
  message is not blank. Ctrl+Enter in the box also commits. Commit runs the repo's hooks as usual,
  so a failing `pre-commit` hook stops the commit: its output shows under the box and your message
  stays in it.
- **Staged** and **Changes** list the files. Changes holds unstaged, untracked, and conflicted
  files, each with its status letter. Hover a row for **Stage** or **Unstage** and **Open in
  editor**. The button in a list's header stages or unstages every row in it. A rename shows as
  `old -> new`.
- **Recent commits** lists the last 20 commits with subject, short hash, and relative time. A commit
  that no remote-tracking branch contains is marked unpushed. Right-click an unpushed commit to
  push it: **Push** on the newest commit pushes the branch, and **Push up to here** on an older
  one pushes that commit and the ones before it, keeping newer commits local. Both need the branch
  to have an upstream; use the branch row's Publish first otherwise.

Click a file row to see its diff: the unstaged change for a row in Changes, or the staged change for
a row in Staged. An untracked file shows its whole content as added. Click a commit to see its
changes. A diff over 1 MiB is cut off with a note that it was truncated. The − and + buttons above
the diff, or Ctrl+wheel over it, zoom it, and a new Git pane starts at the zoom you last chose.
The divider between the lists and the diff can be dragged. Code in the diff is colored by the file's
language, under the green and red of added and removed lines, unless the Code colors setting is None.

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

### Branches tab

The Branches tab lists your local branches, the current one first and the rest newest first, and
under them a collapsed **Remote** section of remote branches you have no local copy of. Each row
shows the branch's last commit and how far it is ahead (↑) or behind (↓) its upstream. A **gone**
badge means its remote branch was deleted, usually because its pull request was merged. A
**worktree** badge means another worktree has it checked out; git won't switch to or delete such a
branch, so its row offers **Open**, which opens a Git pane on that worktree.

When the repo has more than one worktree, a **Worktrees** group sits above the branches. Each row
shows the worktree's folder, its branch (or commit, when detached), how far it is ahead of and
behind the primary branch, and a badge: **Merged**, **Probably merged** (its remote branch was
deleted), **Locked**, or **Prunable** (its folder is gone). Click a row, or press Enter, to see its
last commit, its upstream, and whether its working tree is clean. Its **Open** menu opens the
worktree as a Terminal, Files, Git, or Search pane, or in your editor, and **Delete** (or the
Delete key) removes it after a confirm, offering to delete a merged branch too. Delete refuses
while any pane or Claude session is working in the folder, and never deletes a worktree with
uncommitted changes. The **Compare with** button in the group's header picks the primary branch;
Automatic uses the remote's default branch, or else the first of `dev`, `develop`, `main`, and
`master` that exists. The choice is saved in `repos.json`. To create a worktree, see
[New worktree](#new-worktree).

- **Filter or create.** Typing in the field at the top filters both lists (and opens Remote).
  Press Enter, or New branch, to create a branch with that name and switch to it. It starts with
  no upstream, so Push reads Publish. Right-click a branch and choose **New branch from here** to
  base the new branch on it; the chip beside the field shows the base, and clicking it goes back
  to HEAD.
- **Switch** (or double-click, or Enter). With uncommitted changes that the switch would
  overwrite, git refuses and its message shows above the list. Bashboard never stashes for you.
- **Rename** (or F2) edits the name in place; Enter saves and Escape cancels. A branch with an
  upstream loses it on rename, since the upstream would still point at the old name, and Push reads
  Publish.
- **Delete** (or the Delete key) removes a merged branch straight away. For an unmerged one, a
  confirm says how many commits are on no other branch before you choose Delete anyway.
- **Clean up N gone** deletes every gone branch at once, after a confirm that lists them. A
  squash-merged branch looks unmerged to git, so these are deleted even when unmerged.
- **Check out** on a remote branch creates a local branch that tracks it and switches to it.

After a delete or clean-up, a toast offers **Restore** for a few seconds, putting the branches back
where they were. A right-click on a row also offers Copy name and Insert name, which types the name
into the tab's most recent terminal.

The pane refreshes when git changes the repo's `HEAD`, index, or refs (the watcher skips the
`objects` folder, and changes are debounced about 300 ms), when its window regains focus, and when
it comes back on screen. A pane in a background tab or a collapsed pane does not refresh until it is
shown again. A pane whose folder is outside a repo or missing shows a notice in place of its body.

The pane runs `git` from `PATH`, or else from the Git for Windows install that Git Bash comes from.
Without either, the pane shows git's "not found" error in its body.

Opening a Git pane runs `git status` and `git diff` in the repo, and a repo's own git config can
make those run programs (`core.fsmonitor`, diff and textconv drivers), as it can for `git` in a
terminal. Only open Git panes on repos you trust.

### New worktree

`bb worktree new <branch>` (see [Pane CLI](#pane-cli)) and the command palette's **New
worktree...** create a worktree for a task and open a terminal in it. The palette entry asks for
the branch, shows what it will branch from before you confirm, and has optional Agent and Prompt
fields.

- **Fetch first.** Bashboard fetches the remote before branching, so the branch starts from current
  remote state. The remote is the one your comparison ref uses, else your branch's upstream, else
  `origin`. If the fetch fails (offline, no remote), a warning shows and the worktree is created
  from your local refs.
- **Base.** The new branch starts at the repo's comparison ref, the same one **Compare with**
  picks in the Worktrees group, and the plan line names it with its short commit, such as
  "Branching feat/login from origin/main (a1b2c3d)". `bb worktree new <branch> --from <ref>`
  starts from another ref, and `--from HEAD` starts from the commit the folder you ran it in is
  on. The branch has no upstream, so Push reads Publish.
- **Location.** The worktree is a sibling of the main worktree's folder, named `<repo>-<branch>`
  with `/` and other characters Windows rejects in a file name replaced by `-`. The command fails
  if the branch or the folder already exists.
- **Copying local files.** A `.worktreeinclude` file at the main worktree's root lists gitignored
  files to copy into each new worktree, such as `.env` or a `node_modules` folder, one path per
  line, relative to the root:

  ```
  # copied into every new worktree
  .env
  node_modules
  ```

  Only literal paths work. A glob, a line starting with `!`, an absolute path, or a path with `..`
  is skipped with a warning, as is a path that does not exist, is tracked by git, or is not
  gitignored. Files and folders are copied, not linked; a symlink inside a copied folder is
  skipped.
- **Setup script.** If the repo has a `.bashboard/setup.sh` (commit it so everyone gets it), it
  runs in the new terminal, visible, under bash. On Windows the pane opens with the Git Bash
  profile for this, whatever your default profile is. The script runs from the new worktree's
  folder, with these environment variables:

  | Variable | Value |
  | --- | --- |
  | `BB_ROOT_PATH` | The main worktree's folder |
  | `BB_WORKTREE_PATH` | The new worktree's folder |
  | `BB_WORKTREE_NAME` | The new folder's name |
  | `BB_WORKTREE_INDEX` | A small number, 1 for the first worktree, unique among the repo's worktrees; a deleted worktree's number is reused |

  `BB_WORKTREE_INDEX` lets each worktree take its own ports, so several can run side by side. This
  setup script gives each worktree its own Postgres port:

  ```sh
  #!/usr/bin/env bash
  cp "$BB_ROOT_PATH/.env.example" .env
  echo "POSTGRES_PORT=$((5432 + BB_WORKTREE_INDEX))" >> .env
  pnpm install
  ```
- **Approval.** The first time a repo's setup script would run, Bashboard asks, with a **Show
  script** button to read it first. Approving remembers that exact script for the repo in
  Bashboard's own settings folder (`worktree-trust.json`), not in the repo. If the script changes,
  even by a character, Bashboard asks again. Declining opens the terminal without running setup,
  and without starting the agent. A script that is not UTF-8 text cannot be approved.
- **Agent.** With an agent (Claude Code, Codex, or Copilot) and a prompt, the agent starts in the
  pane after setup finishes, with the prompt as its first message. If setup fails, the agent does
  not start.

## Ship pane

A Ship pane shows how your repos' CI and pull requests are doing, from their code hosts, so you
can watch a build or see what awaits review without leaving Bashboard. It opens on an
[Overview](#overview) of the repos you have pinned, and a click on one shows that repo's own CI runs
and open pull requests. It supports GitHub (github.com and GitHub Enterprise Server), GitLab
(gitlab.com and self-managed hosts), Bitbucket Cloud, and Azure DevOps Services. The command palette's Open the Ship tab, the Ship section's button on the dashboard, and
**Ship** in the kind menu of a pane with no folder show the Overview. Click Ship in Launch, or
choose **Ship** in the kind menu of a pane with a folder, and the pane opens on the repo of that
folder, found from the repo's remote. A Ship pane comes back on relaunch where you left it, and
layouts keep it. Its title is the repo's name while it shows a repo, and "Ship" on the Overview.
In a folder outside a repo, or in a repo with no remote, it shows a notice.

It reads the host with a sign-in you already have: the GitHub CLI (`gh`) for GitHub, the GitLab CLI
(`glab`) for GitLab, a Bitbucket API token you add once in the dialog's
[Accounts tab](#help-settings-and-shortcuts) (or with `bb auth bitbucket` in a terminal), and for
Azure DevOps a personal access token for each organization, added the same way (or with
`bb auth azure-devops <org>`), or else the Azure CLI. When one is missing, the pane says so and its buttons do the
next step (install, sign in, add a token, open the token page, copy the scopes, or manage accounts),
with the notice in place of the list it could not fill. Install and sign-in commands run in a
terminal split off the pane, in the repo folder; the split closes when the command exits cleanly, and one still open when
you quit comes back as a plain shell. When you return to the window after fixing the problem, the
pane looks again on its own, unless the error is a rate limit. The full steps are in
[Code hosts](setup.md#code-hosts).

### Overview

The Overview has one row per pinned repo, across GitHub, GitLab, Bitbucket, and Azure DevOps,
ordered by what needs you first. A row shows the repo's `owner/name` with a GH, GL, BB, or AZ badge, led by an icon for its newest pipeline run on any branch (a green check, a red X, or a spinner while running), a summary of its open pull
requests ("3 PRs open, 1 draft, 1 needs you, 1 approved", highlighted while a review is waiting on you, or in green while one of your own is approved and ready to merge, with who approved it in the tooltip), the number of
pipelines queued or running on any branch ("2 pipelines running", shown only while some are), and a status icon
for each of its **health branches**: the repo's default branch, the branches its open pull requests
target (usually the deploy branches), and any you list for the pin. Each shows how its newest run
ended and how long ago, or "No recent run" when none of the repo's latest 20 runs was on it. When a
repo cannot be read, its row says why, beside the last good data, with a button for a sign-in or
install command where one applies, or one that opens the Accounts tab (**Manage accounts**, **Add
token**, or **Replace token**).

Rows are ordered by the first of these that applies: a health branch whose latest run failed, a pull
request awaiting your review, your own pull request with changes requested or failing checks or
approved and ready to merge, a health branch that is running, and then the rest by most recent activity. Rows tied on one of the
first four keep the order of your pins.

Click a row or its running count to see its Pipelines, or its pull request summary to see its Pull requests. Right-click
a row for **Open Pipelines**, **Open Pull requests**, **Open in browser**, **Open terminal here**
(when the pin has a local clone), **Copy link**, and **Unpin from Overview**; when the pane is wide enough, the same actions
(except Unpin) are buttons at the right of each row. In a repo's own view,
the **Overview** link at the start of the tabs goes back. A repo you pinned without a local clone
has no checked-out branch, so its This branch checkbox is disabled and it has no account button; it
uses the host's default account.

The Overview shows when it was last updated and has an **Add** button (see Pinning), its own **Accounts** button, which opens the
Accounts tab, and a **Refresh** button. It refreshes by
itself every 5 minutes (`ship.overviewRefreshMinutes`; 0 turns this off),
every minute while a health branch is running, and when you focus the pane after more than 30
seconds away. It polls only while the Overview or the dashboard's Ship section is on screen, or
the Needs you list is turned on, and the window is visible. Bitbucket allows 1,000 requests an hour per user and a refresh costs about
3 per repo, so with more than three Bitbucket repos pinned they refresh less often (every 3 minutes
for ten, even while running), and the bar shows the pace, such as "Bitbucket every 3 min".

**Pinning.** A repo's own view has a **Pin to Overview** button (**Unpin** while it is
pinned). The Overview's add box pins a repo without opening it. With nothing pinned it shows
under the empty note; once a repo is pinned it is tucked behind the **Add** button in the bar,
left of **Accounts**, and opens under the bar until you click **Add** again or press Escape. Its
**?** button explains the forms with examples: type `owner/name` (github.com, or
bitbucket.org when every pin is on Bitbucket), `host/owner/name`, or paste a link, which can be an
https or ssh remote URL or the address of a page in the repo, and press Enter or **Pin to
Overview**. Below the box, the folders in your repos list and favorites that are on a host the Ship
pane supports are offered as one-click pins, and pinning one records the folder as the repo's local
clone. Pins are saved as `ship.pinnedRepos` in `settings.json`, where you can also list extra
`branches` for the health row (see [Settings](settings.md#settings)).

**Dashboard.** The dashboard's Ship section, after Ports, has one line for the pipelines running (the
run itself when there is just one, else a count) and another counting the open pull requests that
aren't drafts. What the pinned repos need from you (a health branch that failed, your own pull
request with changes requested or failing checks, your own pull request that is approved and ready
to merge, pull requests awaiting your review, and a pinned repo that needs a sign-in) is in the
[Needs you](#dashboard) list instead. With no repo pinned yet, the Ship section shows a Pin repos
row that opens the Overview. The setup wizard's Favorites
step can pin repos too: tick "Also pin them to the Ship Overview" before adding, an option shown
when some listed repo is on a host the Ship pane supports. Click a line to open that
repo's Pipelines (when the line is about one repo) or the Overview (for a count across repos); the
button in the section's header opens the Overview. Turn the
section off with `dashboard.sections.ship`.

### A repo's view

Across the top, the bar holds the **Overview** link, the **Pipelines** and **Pull requests** tabs,
a **This branch** checkbox, which names the branch you have checked out, an **Open** checkbox (on
the Pull requests tab only), the repo's `owner/name`, which opens it on the host when clicked, the
account button, **Pin to Overview**, **Accounts** (which opens the Accounts tab on this repo's
host), and **Refresh**. This branch is clear by default; check it on Pipelines to list only runs
on your branch, or on Pull requests to list only pull requests from it. Each tab remembers its own
setting, so you can scope runs to your branch and still browse every pull request. Open is
checked by default, listing only open pull requests; clear it to list the latest ones in every
state, with merged and closed ones marked. The pane remembers these choices across restarts.

- **Pipelines** lists the latest 20 runs, newest first: a status icon, the commit message or run
  title, the workflow or pipeline name, number, branch, and who started it, then how long ago and
  how long it took, which redraw every second. Click a run to expand its jobs, each with its duration and, on GitHub and Azure DevOps, its steps
  with failed ones marked (an Azure DevOps job's steps are its tasks, and a job in a named stage
  starts with the stage's name; a GitLab job has no step list). **Show log** loads a job's log (the last 1 MiB of it). When Bashboard can find the first
  real error in it (a `##[error]` or `error:` line, a `TypeError:` or `panic:`, a failed test,
  and the like, skipping the "exit code 1" summary at the end), the log opens with that line marked
  and two lines of context above it, and **Jump to end** scrolls to the last line; otherwise it
  opens at the end. The buttons at the right of each run open it in the browser,
  **Re-run** it, **Re-run failed** jobs (GitHub, GitLab, and Azure DevOps), **Cancel** it, or **Copy link**; one that
  does not apply to the run right now is greyed. Right-click a run for the same actions, and for
  **Fix with agent** on a failed run (see below).
  In a narrow pane the buttons are hidden and the right-click menu has them all. Cancel asks first, with a
  button that reads "Cancel workflow run", "Cancel pipeline", or "Cancel build"; Re-run does not ask. A Bitbucket
  pipeline's jobs are its steps and have no per-command list. Re-run and Cancel on Bitbucket need
  the optional `write:pipeline:bitbucket` scope. On Azure DevOps, Re-run failed re-runs the build's
  failed stages and there is no plain Re-run, and Re-run and Cancel need the Build (Read & execute)
  scope. On GitLab, Re-run and Re-run failed both retry the pipeline's failed jobs, and with Cancel
  they need a token with the `api` scope.
- **Pull requests** lists pull requests in groups: **Review requested** (you are a requested
  reviewer who has not reviewed), **Yours**, and **Others**, each row with its author, branches,
  review state, checks, and last update. Click one to open it in the browser, or right-click to
  copy its link or branch name. The list holds the 50 most recently updated, and a note below the
  groups, such as "Showing the latest 50 of 60 open pull requests.", says when the repo has more. Bitbucket pull requests need the
  `read:user:bitbucket` scope, which sorts them into these groups. GitLab calls them merge requests,
  and a merge request's approvals and pipeline status appear one poll after the list does. On Azure
  DevOps, a reviewer's Approved or Approved with suggestions vote reads as approved, and Waiting for
  the author or Rejected as changes requested.

**Fix with agent.** Right-click a failed run in a pane showing a repo on your machine and choose
**Fix with agent** (on any host that serves job logs).
Bashboard gathers up to five failed jobs, each with its failed steps, its link, and up to 150
lines of its log starting just above the first error, and types that into a coding agent
terminal in the repo's folder, without pressing Enter, so you can read it, edit it, and send
it. It picks the terminal you used most recently in that folder whose agent is idle or done, never
one in the middle of a turn. With none, it opens a `claude` terminal next to the pane, waits for
the agent to report in (hooks need to be installed, see [Claude Code hooks](setup.md#claude-code-hooks);
without them it waits 20 seconds), and then types the prompt. Containers' logs have the same
button (see [Containers](#containers)).

A finished run raises a toast, such as "Workflow run passed: CI on main", whose **Open** action
opens the run. Several Ship panes on one repo share their requests and each finished run toasts
once. A pane showing a repo polls only while it is expanded: runs every 15 seconds while one is
queued or running and every minute otherwise, and pull requests only while their tab is showing. Bitbucket is
polled more slowly, since it allows 1,000 requests an hour per user, and Azure DevOps is never
polled faster than every 20 seconds (its pull requests every 80). Polling pauses while the
window is hidden.

**Accounts.** When you are signed in to several GitHub accounts on one host, the bar shows
"as @name". Click it to pick the account this repo uses, to sign in another one, or to open
**Manage accounts**, which is the dialog's Accounts tab (the **Accounts** button in the bar opens
it too, whatever the account count). Picking sets the
repo's `credential.username`, which Git Credential Manager also uses for push and pull, so the pane
and your pushes agree. When the repo has no account of its own, the button is shown in a warning
color: the pane is following whichever account `gh auth switch` last chose.

A host Bashboard does not recognize shows a notice; for a self-hosted GitHub Enterprise Server host
that `gh` is not signed in to, add it to `ship.hosts` (see [Settings](settings.md#settings)).
A self-managed GitLab host is recognized when GitLab CLI's config lists it or `ship.hosts` names it.
Azure DevOps Server is not served; only Azure DevOps Services (dev.azure.com) is.

### Runs on a terminal's branch

When a new CI run appears on the branch a terminal is on, usually right after a push from that
terminal, the run attaches to the terminal. Its card in the dashboard shows a chip on the model
line with the run's name, number, and status (`build #42 running`, `passed`, or `failed`), and
hovering shows the name and link. If several terminals share the worktree and branch, the one you
focused most recently gets it. The run stays on the card until a newer one starts or the terminal
moves to another branch. When it finishes while you are not looking at the terminal, a pass marks
it `done` and a failure marks it `failed`, which show on the title strip, card, and tab and join
Ctrl+Shift+N, as in [Attention and status](#attention-and-status). Bashboard only watches: it never
types into the terminal or re-runs anything, and it shows nothing when no code host account is
signed in.

## Code search

A Search pane searches the files of a repo for a text or regex query and lists the matching lines.
Ctrl+Shift+H (the `openSearch` action) opens one for the focused pane's repo, as a split of the
focused pane. Outside a repo, it searches the folder itself. Launch's Search button, the
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
selected file scrolled to its line, which is highlighted. The preview is the same text editor as
the Files pane's, with line numbers, so you can fix a match in place: it
saves as you type, and once you leave the preview after a save the search runs again, so the list
follows your edit. Esc in the preview goes back to the list, Find (or Ctrl+Shift+F in the
preview) searches the file, and Ctrl+G goes to a line. The divider between the list and the preview can be dragged.

Code in the preview is colored, as in a Files pane. A markdown file opens rendered, with **Raw** and **Preview** buttons after the zoom buttons. Switch
to Raw to see its source with line numbers and edit it; the pane remembers the choice for the next
markdown file you select. Links in the rendered file open their target in the preview.

A hovered or selected row shows two buttons: 🗀, **Show in Files**, shows the file in
the tab's Files pane for the repo (opening one if there is none), and ↗, **Open in editor**, opens it
in your preferred editor at the line. Enter and a double click on a matching line also open it in
your editor. A file's group header has the same two buttons, which act on the file with no line.
Right-click a row for the same two items plus Copy path and Insert path. A file the preview cannot
show, because it is binary or over 2 MiB, shows the same notice as the Files pane, with Open with
default app and Open in editor buttons. The − and +
buttons above the preview, or Ctrl+wheel over it, zoom its text, and a new Search pane starts at
the zoom you last chose.

The pane's query and options are saved with the layout. A Search pane comes back on relaunch with
its query and options, and a non-empty query runs again as soon as the pane loads.

## Dashboard

The panel opens on the right (or the left, with `dashboard.side`) on start (set
`dashboard.visibleOnStart` to `false` to start without it) and Ctrl+Shift+D toggles it. Its top
bar holds the **⚙** (Settings, also Ctrl+,) and **?** (Help, also F1) buttons, which open the
[app dialog](#help-settings-and-shortcuts) on those tabs, and
the × at its right end hides the panel too, the first time with a notice naming the ways back. While it is hidden, a
small handle sits on that edge of the window, halfway down; click it to bring the panel back. F6 moves focus
into it (showing it for the moment if it is hidden), where the arrow keys move between rows, Enter
clicks the focused row, Left and Right collapse and expand sections, Tab reaches a row's buttons,
F2 renames the focused favorite, layout, pin, or tab group header, and F6 or Escape returns to the pane. Drag its inner
edge to make it wider or narrower; the width is saved with the workspace. Drag it past 600 px
and the panel splits into two columns, each with its own top slot and list and each scrolling on
its own (a column's scrollbar appears while the pointer or focus is in it); narrower than that,
the two stack back into one. The first split puts the clock, Wave, System, Local AI models,
Containers, and Ports on the right, and the rest on the left. **Panes** has a card for every pane in the order
they were opened (with two or more tabs, grouped under a header for each tab showing its name,
pane count, and status; click a header to switch to that tab, or right-click it to rename the tab). A terminal's card shows its status (a green check mark when it is done),
folder, and time since its status last changed, plus, while a coding agent session runs in it, the model
and the tokens in its context on a line below the folder (as "Opus 5.5 · 112k tokens" for Claude Code, and
"Codex · gpt-5.5 · 112k / 272k tokens" for the others, which lead with the agent's name); a card for any other kind of pane shows the
kind's icon and the pane's title. A terminal in a branch over the size limit also gets an amber chip
with its line count on that line (see the [size badge](#git-pane)). Folder paths under the card titles are hidden by default; the
**↳** button on the Panes header shows them, and the choice is saved with the workspace. While
they're hidden, hover a card's title to see its full path. The sparkle button beside it shows only the
terminals running a coding agent (Claude Code, Codex, or Copilot), and that choice is saved too.
Each tab's header still counts all its panes, so a tab with no agent shows just its header; with a
single tab, the other panes fold into one "(2 other panes)" row instead. Click a card to focus its pane (for a pane hidden by a zoom, that brings it back and ends
the zoom in its tab), or use its close button, which
asks first when a Claude session is running there or a scratch pad has text. Click a section's
header to collapse or expand it; the choice is remembered across launches. Drag a section's
header, or the clock, to put the sections in a different order, in the top slot above Pins or
the list at the bottom, in either column; that is remembered too. Dragged while the panel shows
one column, a section joins the column of the section just above where you drop it. With two
columns, drag the Pins header to move Pins to the other column; they always sit at the end of
that column's top slot. Right-click an empty spot or a section header
for a menu that shows or hides each section, or use Settings (see
[Settings](settings.md#settings)). **External sessions** lists Claude Code sessions running outside Bashboard, such as in
Windows Terminal or VS Code; click one to see its folder and session id with copy buttons. The
section appears only while there are some. Hover any card or session for a folder button that
opens its folder in File Explorer, and an Open menu beside it that opens the row's repo root as a
Terminal, as Files (see [Files panes](#files-panes)), as Git (see [Git pane](#git-pane), for a
git repo only), as Search (see [Code search](#code-search)), or in your Editor. Favorites and
recent folders show the same Open menu, which also lists File Explorer, and a favorite shows a ✎
to rename it.

**Launch** sits at the top by default and appears while the focused pane is in a folder (a
scratch pad keeps the last one shown). Its row of icons opens a Terminal, Files, Git, Scratch, Search (see
[Code search](#code-search)), or Ship (see [Ship pane](#ship-pane)) pane at the
focused pane's repo root, with Git and Ship for a git repo only (Ship opens on that repo, not the
Overview); hover one for its name and shortcut. While you hover, the
panes show where the new one will open: the focused pane outlined and the new pane's share of it
highlighted, or the Files or Git pane it would bring forward, or a note that it opens collapsed
when there is no room. Like the other sections it can be dragged elsewhere or turned off; it does
not collapse.

Ctrl+Shift+L (the `openLaunch` action) opens the same choices, plus Containers and Ports, as a
menu over the focused pane, outlined in your accent color with the rest of the window dimmed:
press a letter (**t** Terminal, **g** Git, **f** Files, **o** Ship, **s** Search, **c**
Containers, **r** Ports, **b** Local Browser, **p** Scratch), or use the arrows and Enter, with the same preview as you
move. Containers appears once Docker or Podman is installed. While Launch is turned
off, a **+** button at the far left of the top bar drops this menu. Ctrl+Shift+X (the `openEditor`
action) opens the focused pane's repo in your editor directly, or its folder outside a repo.

**Needs you** sits just under Launch and holds everything you should act on, so you don't scan the
other sections for it. It has no headings, but it keeps three groups in order, oldest first within
each. First come terminals waiting for you. Then what is broken: a terminal whose session failed, a
health branch that failed, and your own pull request with changes requested or failing checks.
Last come what is ready for you: a terminal that finished, your own pull request that is approved
and ready to merge, pull requests awaiting your review, and a row asking you to sign in when a
pinned repo's host needs an account. The branch, pull request, and sign-in rows come from the repos
pinned to the Ship Overview (see [Ship pane](#ship-pane)). Usage limits join the list too: once an
agent's 5-hour or weekly limit passes 80% (change it with `needsYou.usagePercent`), a row such as
"Claude Code, 5-hour limit 84%" appears with a ring meter, under ready, and moves under broken as
"5-hour limit reached" at 100%; it leaves when the limit resets. Claude Code's numbers need the
status line wrapper its hook install adds, and Codex's come from its session file while the Panes
section or this list is shown (see [Setup](setup.md#usage-limits-and-your-status-line)); Copilot
reports none. A row shows a status icon, the pane's title or the repo's `owner/name`, a short
phrase ("needs permission", "main failed", "#12 needs your review"), and how long ago it started,
with more detail in its tooltip. Click a row to go to the thing: its terminal, the repo's Pipelines
or Pull requests in a Ship pane, or the Accounts tab (a usage row has nowhere to go). The list shows 6 rows and then "+ N more", which expands it ("Show fewer" collapses it), and
reads "Nothing needs you" when there is nothing to act on.

Right-click a Ship, usage, or sign-in row and choose **Hide until it changes** to put it away until
something about it changes, such as a new failed run, a push to the pull request, or a limit
resetting; hidden rows stay hidden after a restart. A terminal's row clears by itself when its
agent moves on. When a branch or pull request newly fails or gets changes requested, or a limit
reaches 100%, a toast appears while Bashboard has focus, and a system notification while it doesn't (the same **Notify when something needs you**
setting as for waiting terminals); rows already there at startup never toast. Ctrl+Shift+N walks
this same order (see [Attention and status](#attention-and-status)). Turn the list off with
`dashboard.sections.needs`.

**Pins**, the repo's pinned files and folders (see [Pins](#pins)), stay put just below the top
slot so the sections don't jump as pins come and go. The heading names the folder too, if it
fits.

The **clock**, which is off by default, is one line in the top slot: three
rows of dots showing the hours (24-hour), minutes, and seconds in binary, and the time as
`h:mm` beside them. Right-click the clock to show just the time or just the dots instead,
or to hide it; Clock style in the Settings tab does the same. Drag it down among the other sections to move it there, or back to the top.
It ticks only while the panel is on screen.

The **System** section is off by default; turn it on under "Show on the
dashboard" in Settings. It shows CPU use with a 60 second sparkline, memory used of total,
network receive and send rates with a sparkline for each, and free space on each fixed drive, with bars that turn amber at
80% and red at 90%. CPU and network fill in on the second sample after the section starts. It
samples only while it is expanded, the panel is on screen, and the window is shown. Hover the CPU
or Memory row to see the programs using the most of it, with all of a program's processes added
together.

The **Wave**, also off by default, is a slowly turning looped line that reacts to your machine:
it weaves tighter as CPU load rises, spins faster with network traffic, and changes shape faster
as memory fills, while it slowly tumbles end over end. Hover it
for the readings. Like the clock it has no header; drag it anywhere on the panel to move it. It
keeps moving when the background animation is paused (Ctrl+Shift+A), and holds still only when
Windows asks apps to reduce motion.

The **Branch** section is off by default; right-click the panel and choose Branch, or turn it on
under "Show on the dashboard" in Settings. It follows the folder of the focused pane (or the last
one that had a folder) and appears only while that folder is in a git repo. Its header shows the
branch, or "detached HEAD", and the worktree's folder name; click it to open the Git pane. Below
sit a meter of how much of the size limit the branch uses (full and amber once past it) with the
line count, file count, and comparison ref; how far the branch is ahead of and behind that ref;
how many commits are waiting to be pushed to or pulled from the branch's upstream, or that it has
no upstream yet or its upstream was deleted on the remote (left out when the upstream is the
comparison ref itself); the staged, changed, and untracked file counts (left out when there are none); the branch's
latest CI run, which opens the Ship pane when clicked; and the branch's pull request, with its
number and title and a Draft, Merged, or Closed badge or its review state ("approved", "changes
requested"), which opens the Ship pane's pull requests when clicked. With no comparison ref to measure against,
a muted "no comparison ref" line replaces the meter and the ahead and behind counts. It updates
when the repo changes and when an agent working in the folder stops, and checks CI again only
while a run is in progress.

**Favorites** are folders you open terminals in often. By default they live behind the
heart button in the panel's top bar, which drops a list that filters as you type;
Ctrl+Shift+O opens the same list in the middle of the window. Enter or a click opens the selection
as a split of the focused pane, and Ctrl+Enter or Ctrl+click opens it collapsed. The **+ Add**
button beside the filter adds the focused terminal's folder (and its shell, when that is not the
default); it is grayed out when that folder is already a favorite. When the focused pane has no
room for another split, a toast says so and the terminal opens collapsed.

The list also manages your favorites: F2 or the row's **✎** renames the selected one, and
Delete (once the cursor is at the end of the filter text) or the row's **×** removes it. Right-click a row
for Open, Rename, and Remove.

Turning Favorites on under "Show on the dashboard" lists them on the panel instead, above the
terminals, where rows can be renamed, removed, and reordered by dragging, and the
section's "+" adds the focused folder. Below them, **Recent** lists up to five folders from Claude
sessions that are not already favorites, each with a star to promote it. While the section is
shown, the top bar's heart button is not.

### Layouts

**Layouts** save the active tab's arrangement of panes under a name: each pane's kind, its folder
and shell (for terminals), its collapsed state, and how the panes are split. Scratch pads are
saved as panes but open empty. By default they live behind the grid button in the panel's
top bar, and Ctrl+Shift+R opens the same list in the middle of the window; both filter as you
type, and Enter or a click opens the selection. The **+ Save** button beside the filter turns it
into a name field: type a name and press Enter to save, or Escape to go back to the list. The row
under the name says "Replace" when a layout already has that name (any capitalization), so you
see it before you press Enter. F2 or the row's **✎** renames the selected layout, and Delete or the row's **×**
removes it after the row asks "Remove?" (Enter confirms, Escape keeps it). Right-click a row for
Open, Rename, and Remove.

Turning Layouts on under "Show on the dashboard" lists them on the panel instead, below
Favorites. Each row shows the name and pane count; click it to open the layout, and use the row's
buttons to rename it or remove it (removing asks first). The section's "+" asks for a name and
asks again before it replaces an existing layout.

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
folders, layout, and collapsed state, and types the agent's resume command into each one that was running a coding agent session:
`claude --resume <session id>` for Claude Code, `codex resume <session id>` for Codex, and
`copilot --resume <session id> --model <model>` for Copilot, which otherwise falls back to its default model.
Turn off **Resume agent sessions** in Settings (`restore.resumeSessions`) to restore terminals without resuming.
A session that was in a permission mode other than the default, such as bypass permissions,
resumes in that mode. The mode saved is the one Claude Code last reported through its hooks, so a
Shift+Tab change made just before closing, with no prompt after it, may not be saved.

Each terminal's scrollback comes back too, above a gray "restored scrollback" line, with the new
prompt below it. It is saved when you close the window and about once a minute while terminals
have new output, so if the app itself crashes you lose at most the last minute or so. Container shells and terminals opened from a layout start empty. Turn
off **Restore terminal scrollback** in Settings (`restore.scrollback`) to stop saving it.

If the window's web view crashes, Bashboard rebuilds the window and reconnects each terminal to
its shell, which kept running, so commands and agent sessions carry on and the screen redraws
with recent output. If the window stops responding for 30 seconds, Bashboard asks whether to
reload it; your shells keep running through the reload. The close button also still closes a
window that stopped responding, after a few seconds. If a saved pane cannot be restored, a
terminal opens in its place and a message says so. Either event is recorded in `%LOCALAPPDATA%\dev.bashboard\logs\bashboard.log`.

When a terminal starts waiting while the panel is hidden, the panel peeks open over the panes for
a few seconds and stays while the pointer is over it. Set `dashboard.peekOnWaiting` to `false`
to turn the peek off. It comes in from the dashboard's side:

```jsonc
"dashboard": { "peekOnWaiting": true }
```

Sessions come from the files Claude Code keeps in `~/.claude/sessions`. A session belongs to a
pane when its process descends from that pane's shell, so running `claude` in a pane names the
card after the session and shows when it is working, usually within about 10 seconds. Codex and
Copilot keep no such file, so their sessions come from their hooks and appear in the pane where
the agent sent its first hook.

The Background choice in the Settings tab picks what draws behind the panes (see
[Settings](settings.md#settings)): Swirling Lights, a drifting colony simulation; Galaxy, a
slowly turning swirl of stars; Matrix; Wave, a large version of the dashboard's Wave that
follows your machine's load; Image and Slideshow, which show your own pictures; or None.
Ctrl+Shift+A pauses or resumes Swirling Lights, Galaxy, Matrix, or Wave. Ctrl+Shift+B cycles
the background's brightness through full, three quarters, half, and a quarter, and saves the choice as
Brightness in the Settings tab; the blur stays as set there.

### Containers

The **Containers** section of the dashboard lists Docker and Podman containers, grouped by Compose
project; a container with no project is its own row. Bashboard finds `docker.exe` and `podman.exe`
on `PATH` at startup, so Docker Desktop or Podman has to be installed. An engine whose CLI is
missing is left out. One that is installed but not running shows as "Docker is not running" or
"Podman is not running", with a Start button at the right when Bashboard can start it, and
Bashboard checks it again every 10 seconds. The section appears while
an engine is found and `dashboard.sections.containers` is on (see [Settings](settings.md#settings)).

Each row shows the project's name and how many of its containers run ("1 of 2"). A project with
a single container shows a Start or Stop button on hover; for a project with more, click the row
to open it in the Containers tab, where each container can be started or stopped.
Right-click a row to start or stop a whole project. A project that exists on both engines is one row.
Click a row to open the Containers tab with that project expanded. The Manage button (an arrow
leaving a square) in the section's header switches to a Containers tab that is already open, or
adds one. The eye button beside it hides projects with nothing running (a project with even one
of its containers running stays), and shows them again; the choice is saved with the workspace.

The **Containers pane** has a heading for each engine that is available, Docker and then Podman,
and its projects expand to their containers. An engine's heading has a Start or Stop button for
the engine itself. Stop asks first, since it stops every container on that engine and shuts the
engine down for other apps too; the dashboard offers only Start. Bashboard starts Docker Desktop
with `docker desktop start` (or by launching Docker Desktop, which it can then only start, on
versions before 4.37) and Podman with `podman machine start`. Other setups, such as Docker Engine
inside WSL, get no buttons. A container row shows its service or container name,
image, status text, and published ports, which open `http://localhost:<port>` when clicked, and its
CPU and memory, refreshed every 5 seconds while the pane is on screen. Start, Stop, and Restart act
on a container or on a whole project; every row shows its buttons, greyed when they do not apply,
such as Start on a running container. Logs opens a panel beside the list that follows the output,
starting with the last 500 lines and keeping the most recent 5000; scrolling up pauses following
until you scroll back to the end. The − and + buttons in its header, or Ctrl+wheel over it, zoom
the log text, and the next logs panel starts at the zoom you last chose. A container started by
Docker Compose from a folder on this machine also gets a **Fix with agent** button there, which types the last 150 lines of
its log, with the container's name and image, into an agent terminal in the project's folder (the
same hand-off as the Ship pane's, without Enter). Shell opens a terminal split beside the pane, running `bash` in
the container when it has one and `sh` otherwise, titled with the container's name. It needs a
running container.

Container shells are not restored on relaunch and are not saved in layouts. The Containers pane
itself is.

### Ports

The **Ports** section of the dashboard lists what is listening for connections on your machine,
so a dev server started in the background (by you or by Claude) never goes unnoticed. Each row
shows the port, the program, and, when it was started from one of your panes, that pane's name.
Ports started from panes come first. The dot is green for a port only this machine can reach and
amber for one open to your network. Hover a row for its full command line, folder, process id,
and how long it has been up. A port that opens while you are watching flashes once.

Click a row to jump to the pane that started it, or, for one no pane started, to see it in the
Ports tab. Right-click a row to open it in your browser, copy its URL, command line, folder, or
process id, or **Stop** it. Stop asks first, then ends the program and everything it started.
The section lists dev servers: anything started from a terminal or by a program like node,
python, or dotnet. Other apps that listen, such as a music player or a sync client, are counted
in a "+ N other programs" row that opens the Ports tab, and Windows services and Bashboard itself
are left out. The section lists up to 10 ports and counts the rest in a "+ N more" row; set how
many under **Ports listed** in the Dashboard section of Settings. The Manage button (an arrow
leaving a square) in the header opens the Ports tab.

The **Ports pane** lists every listening port in columns (port, program, the pane that started
it, address, process id, and uptime), sorted by port; click a column header to sort by it, and
again to reverse. The Pane column is left out when no listed port was started from a pane. Each
port's folder gets its own column when the pane is wide enough, and sits beneath the row
otherwise; tick **Command lines** to show each full command line under its folder. Each row has
**Open**, **Go to pane**, and **Stop** buttons, a double-click opens it in a [Local Browser](#local-browser) pane
beside the Ports pane, and a right-click gives a menu like the dashboard's, with **Open in Local Browser** and **Open in system browser**.

Type in the filter to narrow the list by port, program, command, folder, or pane name (Escape
clears it). The pane opens with **Started from a pane** ticked, listing only ports your panes
started; untick it to see everything else, and on Windows tick **Windows services** to include the
system's own ports, dimmed. Opening the pane from the dashboard on a port no pane started unticks it for
you. Any pane can also become a Ports pane from its kind menu.

## Local Browser

A **Local Browser** pane shows a dev server's page beside the terminal that runs it, with a Console
and a Network panel one click away. It opens `localhost` and `127.0.0.1`, over `http` or `https`,
on any port, and local `.html` and `.htm` files (Windows only); anything else is refused, so it is
not a general browser. Open one from the
kind menu at the top left of any pane, from the Launch menu (**b**), with `bb browse` (see
[Pane CLI](#pane-cli)), from a Ports pane row (**Open**, or a double-click), from the **Open in
Local Browser** entry in the port and container menus, or by Ctrl+clicking a `localhost` link in
a terminal. Ctrl+Shift+click on such a link, and **Open in system browser** in the menus, use your
system browser instead.

**Address bar.** Type a bare port (`5173`), `:5173`, `localhost:3000/app`, or a full URL; a missing
host means `localhost`, and a missing scheme means `http`. An `http` address on a port that only
speaks https opens as `https`, so a port tile or a bare port works for an https server too; the
same goes for **Open in system browser**.
Suggestions list your bookmarks, the ports that are listening, and
addresses you visited recently; use the arrows and Enter, or Escape to put the page's address back.
Back, Forward, and Reload sit to its left (Shift+click Reload to bypass the cache), and Home opens
the `localBrowser.homeUrl` setting, or the start page, a list of listening ports and bookmarks,
when that is empty. If nothing is listening on the port, the pane says so and offers Retry.

**Local HTML files.** The address bar also takes the path to an `.html` or `.htm` file, written as
`C:\reports\q3.html`, `C:/reports/q3.html`, a Git Bash path such as `/c/reports/q3.html`, a path
starting with `~/`, or a `file:///` URL. The address bar then shows the file's own path. A file also
opens from `bb browse <file>` (see [Pane CLI](#pane-cli)) and from **Open in Local Browser** in the
Files pane's menu for an `.html` or `.htm` file. Saving the file reloads the page; with
`localBrowser.reloadOnChange` off, a "Changed on disk" notice with a Reload button appears instead.

Each file page shows a trust badge in the toolbar. **Trusted** is a file in a folder listed in
`localBrowser.trustedFolders`, which may reach any host. **Local** is any other file on this
machine, which may reach its own folder, the CDN hosts a generated page usually loads from, and the
hosts allowed for its folder. **Downloaded** is a file Windows marks as downloaded from the internet
(Mark of the Web), even inside a trusted folder; it reaches what Local reaches, but reads only other
downloaded files in its folder and is kept apart from the folder's Trusted and Local pages. Following
a link from a Local page to a downloaded file beside it opens that file as a Downloaded page.

When a file page's request to a host is refused, a bar under the toolbar lists each host with a
count of its refused requests. **Allow** adds the host to that folder's allowed hosts and reloads
the page, and every file in the folder gets it. A page opened straight from your home folder or a
drive root keeps its allowed hosts to itself. On a Downloaded page, Allow asks first, and a
Downloaded page can never reach a service on this machine (`localhost`, `127.0.0.1`, and the like):
the bar shows "Downloaded pages can't reach local services" for one instead of Allow, and an
allowed-hosts entry for one is ignored. On a Local page, Allow for a local service asks first,
naming its port. The four settings behind these, `trustedFolders`, `allowedHosts`, `cdnHosts`, and
`reloadOnChange`, are described in [Settings](settings.md#local-browser).

A file page never opens another site by itself. When it tries to navigate to one, the pane shows
"This page tried to open example.com" with an **Open** button, and the address goes to your system
browser only when you click it. A Downloaded page that tries to navigate to a service on this
machine stays put, and the pane shows "Downloaded pages can't open local services"; the address
field, Home, bookmarks, and Back still take you anywhere.

**https.** An https page loads only when Windows trusts its certificate; there is no "proceed
anyway". When it doesn't, the pane says so and names the fix: for an ASP.NET Core project, run
`dotnet dev-certs https --trust` once, then Retry. Or use the project's `http` launch profile. In a
narrow pane the address field takes a row of its own under the buttons.

**Bookmarks.** The star saves or removes the current page, and **Bookmarks** lists them. They are
kept in `settings.json` under `localBrowser.bookmarks` (see [Settings](settings.md)).

**DevTools.** The **DevTools** button, with a badge counting errors, opens a drawer you can resize
by dragging its top edge. **Console** shows what the page logs, with filters for log, info, warn,
and error, a text filter, **Clear**, and **Preserve log** (the console clears whenever the page
navigates unless it is ticked). **Network** lists each request with its method, status, path, type,
size, and time, with type and text filters; click a row for its headers and response body (JSON is
indented). **Split**, on by default, shows Console on the left and Network on the right at the same time (turn it off to show one panel at a time by tab);
drag the line between them to change their widths.

**Device sizes.** The device menu fits the page to Phone, Phone large, Tablet, Laptop, or Desktop
dimensions, scaled down to fit the pane when it is larger, with **Rotate** to turn it sideways.
Responsive fills the pane.

On a loopback page, a link to another site opens in your system browser and the pane stays where it
was; so does a page that redirects to one. Frames inside a loopback page load only local addresses
too, and the Console notes each one it stopped. Frames inside a file page load what its trust level
allows (see Local HTML files above). Pages that forbid framing (`X-Frame-Options` or
`frame-ancestors`) still show, since Bashboard lifts that restriction for local pages only. Popups
and downloads are not supported. Bashboard's own keys keep working while the page has focus,
except the terminal's copy and paste, which the page keeps. A page keeps its state (what you typed,
where you scrolled) while its tab is hidden, the pane is collapsed, or another pane is zoomed. The
page, drawer, and device size are restored on relaunch; a pane closed on its start page reopens on
it.

## Codex, Copilot, and local AI models (preview)

Besides Claude Code, Bashboard follows OpenAI Codex and GitHub Copilot CLI sessions. Their status
dots, waiting and done markers, pane borders, notifications, Panes cards, and resume on relaunch
work the way they do for Claude Code once that agent's hooks are installed (see
[Agent hooks](setup.md#agent-hooks)). A card leads its model line with the agent's name, for
example "Codex · gpt-5.5 · 112k / 272k tokens". Install each agent's hooks from the footer button
in the dashboard ("Install Codex hooks", "Install Copilot hooks") or the setup wizard's Coding
agents step. Codex asks you to trust the hooks the next time it starts.

Codex, Copilot, and Local AI models are a preview, built without a Codex or Copilot setup to test
against, so reports are welcome. Open an issue from the agent report template on GitHub with the
agent's version, a sample of its hook payloads, and a few transcript lines (see
[Reporting a problem with an agent](setup.md#reporting-a-problem-with-an-agent)).

### Local AI models

The **Local AI models** section of the dashboard lists the model servers that answer on this machine,
Ollama and LM Studio, and the models each has loaded: its name, where it runs, its context length,
and the time until it unloads. It appears only while a server answers, and says "No model loaded"
for a server with nothing in memory. A context length under `localModels.minContext` (64000 by
default) is shown in a warning color, since coding agents need about that much; hover it for the
fix, which is to raise Ollama's `OLLAMA_CONTEXT_LENGTH` environment variable and restart Ollama.
Set `localModels.minContext` to 0 to turn the warning off, and `localModels.ollamaUrl` or
`localModels.lmStudioUrl` to look for a server at another address (see
[Settings](settings.md#settings)). Hide the section with `dashboard.sections.localModels`.

While Ollama answers and `ollama` is on your `PATH`, the Launch menu gains an entry for each
detected agent, such as "Claude Code on a local model". Each is a submenu of your installed Ollama
models; picking one opens a new terminal and types
`ollama launch <agent> --model <model>`, so the agent runs against that model.

## Attention and status

When a terminal starts waiting or rings the bell, its pane border (or its card, if collapsed)
pulses until you look at it, and the taskbar button flashes if the window is unfocused. A
terminal you are already looking at (the focused pane in a focused window) is not marked.
While Bashboard is in the background, a terminal that starts waiting also shows a system
notification; click it to jump to that pane. The same setting covers the notification for a
branch or pull request that newly needs you (see [Dashboard](#dashboard)). Turn **Notify when
something needs you** off in Settings (`terminal.notifyWhenWaiting`) to stop them. On macOS, the first notification asks for
permission; if you deny it, change that in System Settings, Notifications, Bashboard.

A waiting terminal's dashboard card glows faintly in the accent color for as long as it waits,
whether or not you have looked at it.

A waiting terminal shows why: the pane card, the status dot's tooltip on the title strip, the
tab's tooltip, and an external session's row carry the message the agent sent with its hook (for
example that it needs your permission to use a tool), or, for a terminal without hooks, the one in
the program's own status report, or "Waiting for you" when there is none.

Without hooks, Claude Code 2.1.295 or later and Codex still report working, waiting, and done
through the terminal itself, once the terminal answers their probe, and the pane shows them the
same way. That needs the terminal's reply to reach the program, which works on macOS and Linux; on
Windows the reply does not reach the program, so status comes from hooks. The dashboard's session details
(model, context, and resume) still need hooks. A bound session's hooks take precedence, unless
they have been silent for over 2 minutes while the program reports it is working or waiting.

Ctrl+Shift+N jumps to the next thing that needs you, across all tabs, in the order of the
dashboard's Needs you list: waiting terminals first, oldest first, then failed terminals and
broken branches and pull requests, then finished terminals, approved pull requests, review
requests, and a sign-in. It switches to a terminal's tab, expands a collapsed card, and ends a zoom
in the way; for a branch or pull request it opens the repo in a Ship pane, and for a sign-in the
Accounts tab. Rows you hid are skipped. Repeated presses walk the list. Set `needsYou.walkAll` to
`false` to visit only terminals. When nothing needs you, it cycles through the terminals running an
agent session (Claude Code, Codex, or Copilot) instead.

When an agent session's turn ends, its `Stop` hook marks the terminal `done` unless you are
looking at it. The status dot becomes a still green check mark on the terminal's title strip,
card, and tab. It clears when you focus that pane (typing in it focuses it), or
as soon as the session starts working or waits. `done` applies to terminals only, raises no
pulse, taskbar flash, or peek, and is not saved, so restored terminals start without it.

A long shell command marks its terminal the same way, with no agent session needed. A command that
runs at least `terminal.doneAfterSeconds` and finishes while you are not looking at the terminal
marks it `done`, or `failed` (a still red cross) when it exited nonzero; Ctrl+C is not a failure.
Only Git Bash with the `~/.bashrc` lines from [New panes in the current folder](setup.md#new-panes-in-the-current-folder)
reports commands, and a bound agent session's own status takes precedence.

A CI run that starts on a terminal's branch, typically after that terminal pushes, shows as a chip
on the terminal's card (such as `build #42 running`), and marks the terminal `done` or `failed` when
the run passes or fails while you are not looking at it. Cancelled and skipped runs mark nothing.
See [Runs on a terminal's branch](#runs-on-a-terminals-branch).

## Cloud context chip

With `cloud.badge` on (it is off by default), a terminal's title strip shows a small chip, just left
of its pin button, naming the AWS profile and region the shell is using, such as
`aws prod-admin · us-east-1`. The terminal's card in the dashboard shows the same chip. The profile
and region come from the shell's `AWS_PROFILE` and `AWS_REGION` (or `AWS_DEFAULT_REGION`), so each
pane shows its own, and the chip follows the shell when you switch profiles. A region with no
profile reads `aws default · us-east-1`. The chip is hidden while neither is set.

The chip is gray, and red when the profile matches the production pattern (`prod|prd|live` by
default, matched ignoring case). Hover it for the provider, profile, and region.

The chip needs the `~/.bashrc` lines from
[New panes in the current folder](setup.md#new-panes-in-the-current-folder) in Git Bash; PowerShell
panes report without setup, and Command Prompt panes show none. Turn the chip on with **Cloud
context chips** in the Terminal section of the Settings tab (`cloud.badge`), and change what counts
as production with `cloud.productionPattern` (see [Settings](settings.md#settings)).

## Command palette

Ctrl+Shift+P opens one list over your panes, tabs, favorites, layouts, the focused repo's pins and
worktrees, and the actions, each with its keys. The actions include Open the Containers tab, Open
the Ports tab, and Open the Ship tab (the Ship [Overview](#overview)), which switch to that pane or
add a tab holding one. **New worktree...** creates a [worktree](#new-worktree) for the focused repo. Typing filters the list fuzzily, and a leading `>`
shows only actions. Enter focuses a pane, switches to a tab, opens a favorite, layout, pin, or
worktree, or runs an action; a favorite or worktree opens as a split, or collapsed with Ctrl+Enter.
With an empty box, your recent picks come first.

## Find and links

Ctrl+Shift+F opens a find bar over the top-right of the focused pane. Matching is
case-insensitive and updates as you type; Enter moves to the next match and Shift+Enter to the
previous. Esc closes the bar and returns focus to the terminal. The bar also closes when its
pane closes or collapses, or when focus moves to another pane.

Ctrl+click a link in terminal output to open it in your browser. Only `http` and `https` links
open; other schemes are ignored. A link to `localhost` or `127.0.0.1` opens a
[Local Browser](#local-browser) pane beside the terminal instead, and Ctrl+Shift+click sends it to
your system browser.

## Text size

Ctrl+= (or Ctrl+numpad +) enlarges text, Ctrl+- shrinks it, and Ctrl+0 resets it to 14. Each
step is 1 px, from 6 to 48, and is saved to `font.size` in `settings.json`. It applies to every
terminal and to the text in other panes (file lists, previews, diffs, scratch pads, Search's
code lines, and container logs); each pane's own zoom buttons adjust from there. The app's buttons,
bars, and titles follow Interface size in Settings instead.

## Agent glow and border lights

Two optional effects, both off until you turn them on under Appearance in Settings. **Agent
glow** makes a terminal glow softly while an AI agent is working in it. **Border lights** send
small lights around each pane's border, more of them on larger panes; when a pane needs you, only
that pane keeps its lights. Border light speed and density sliders appear under the toggle while
it is on. Both effects follow the accent color.

## Help, settings, and shortcuts

One dialog holds six tabs: **Help**, **Settings**, **Accounts**, **Shortcuts**, **CLI**, and
**About**. F1 or the dashboard's **?** opens it on Help, and Ctrl+, or **⚙** opens it on Settings.
The command palette lists all six, and Accounts, Shortcuts, CLI, and About can be given keys of
their own. Ctrl+Tab and
Ctrl+Shift+Tab (or Ctrl+PageDown and Ctrl+PageUp) move between tabs, pressing a tab's own key
again closes the dialog, and Escape or a click outside closes it too. Up, Down, Page Up, and Page
Down scroll the tab you're on, except in a dropdown, a number field, a slider, or a list, which use
those keys themselves.

- **Help** is a short tour of the main features with your current keys, a **Take the tour**
  button that walks you through the main keys one at a time, and a Setup list that
  checks Git Bash, each shell's [current-folder lines](setup.md#new-panes-in-the-current-folder),
  and the hooks of each coding agent that has run here. Anything missing has an Install button, and **Run setup** reopens the
  setup wizard.
- **Settings** edits every setting (see [Settings](settings.md)); type in its filter to narrow the
  list. The window behind it stays undimmed, so color and brightness changes show as they will look.
- **Accounts** shows, for each code host, where the Ship pane gets its token, and manages it. It
  has a card for GitHub (and each GitHub Enterprise Server host you use), GitLab (and each
  self-managed host), Bitbucket, and Azure DevOps. The hosts it detected on this machine come first
  (a CLI signed in to them, a stored token, or a pinned repo, open Ship pane, or terminal pane on
  them; hover a card to see why), and the other public hosts fold under a **More hosts (N)**
  toggle, which reveals them dimmed. A card shows status only, never a token. A GitHub card says whether the GitHub CLI is installed
  and lists its signed-in accounts, with the active one marked. **Sign in** (or **Sign in another
  account**) runs `gh auth login` in a new terminal pane and closes the dialog so you can see it,
  **Install GitHub CLI** runs `winget` the same way, **Make active** switches accounts, and
  **Sign out** asks first and then signs that account out of the GitHub CLI for every app that
  uses it. The GitLab card says whether the GitLab CLI is installed and who is signed in;
  **Sign in** runs `glab auth login` in a new terminal pane the same way, **Install GitLab CLI**
  runs `winget`, and **Sign out** asks first and then signs out of the GitLab CLI for every app that
  uses it. The Bitbucket card says whether an API token is stored; **Add token** (or **Replace
  token**) opens a password field, **Save** stores the token in Windows Credential Manager or the macOS Keychain, and
  **Remove token** asks first and deletes it. It also lists the scopes the token needs, with
  **Open the API token page** and **Copy scopes**. The Azure DevOps card has one row for each
  organization with a stored personal access token, each with **Replace**, **Remove** (which asks
  first), and **Test**; **Add token** opens a form with an organization field and a password
  field, **Sign in with Azure CLI** appears when `az` is installed, and **Open the token page**
  and **Copy scopes** help make the token. **Test** asks the host who the credential belongs to
  and shows the login, the granted scopes on GitHub, or the error, which for Bitbucket names a
  missing scope. On GitHub it tests each account in turn, and on Azure DevOps each organization
  with a stored token plus each one a pinned repo or open Ship pane is in. The tab refreshes when you
  return to the window, so a sign-in finished in a terminal shows up. Open it from the Ship pane's
  **Accounts** button, the account menu's **Manage accounts**, a Ship notice, or the command
  palette ("Manage code host accounts").
- **Shortcuts** lists every key and is where keys are changed (see [Settings](settings.md)).
- **CLI** lists the `bb` commands below, with examples to copy.
- **About** shows the version, **Check for updates**, and links to the release notes and docs.

## Pane CLI

`bb` is a small console program that lets a shell in a pane drive Bashboard. The app dialog's
CLI tab lists the same commands, with examples to copy. A command that opens a pane splits the
pane that ran it, in that pane's tab, and focus moves to the new pane. `bb open` and `bb git`
first look for a Files or Git pane for the same repo in that tab and, when there is one, show the
folder in it or focus it instead. `bb ship`, `bb ports`, and `bb containers` work as their keys
do: they show the existing pane wherever it is, or open a tab of their own, so `--collapsed` does
not apply to them. `bb edit` opens a pane only when your editor is Vim or Neovim.

| Command                       | What it does                                                                  |
| ----------------------------- | ----------------------------------------------------------------------------- |
| `bb open <path>`              | Shows a folder in a Files pane, or a file's folder with the file selected     |
| `bb edit <path>[:<line>]`     | Opens the file or folder in your preferred editor, at the line when given     |
| `bb git`                      | Opens the Git pane for the current folder's repo                              |
| `bb search [<query>]`         | Opens a Search pane for the current folder's repo, with the query filled in   |
| `bb scratch [<text>]`         | Opens a scratch pad holding the text, or the piped standard input             |
| `bb term [<folder>] [-- <command>]` | Opens a terminal in the current folder or `<folder>`, and runs the command when given |
| `bb ship`                     | Shows the current folder's repo in the Ship pane, or the Overview outside a repo |
| `bb ports`                    | Shows the Ports pane                                                          |
| `bb containers`               | Shows the Containers pane                                                     |
| `bb browse [<url or file>]`   | Opens a Local Browser pane at a localhost address or an `.html` file, or on its start page |
| `bb auth bitbucket [--clear]` | Stores a Bitbucket API token for the Ship pane, or removes it with `--clear` (the Accounts tab does the same) |
| `bb auth azure-devops <org> [--clear]` | Stores an Azure DevOps personal access token for one organization, or removes it with `--clear` (the Accounts tab does the same) |
| `bb ci [status] [--branch B] [--json]` | Prints the current branch's CI runs (status, name, duration, link) and its pull request |
| `bb ci wait [--branch B] [--interval SECS] [--timeout DUR] [--json]` | Waits for CI on the branch's latest commit; exits 0 passed, 1 failed, 2 gave up |
| `bb ci log [--run ID] [--job ID]` | Prints why the newest failed run (or `--run`) failed, or a whole job log with `--job` (which needs `--run`) |
| `bb ci rerun [--failed] [--run ID]` | Re-runs a run, or only its failed jobs; needs `ship.cliWrites` |
| `bb ci cancel [--run ID]`     | Cancels a run; needs `ship.cliWrites`                                         |
| `bb worktree new <branch> [--from <ref>] [--agent <id>] [--prompt <text>]` | Creates a worktree on a new branch, copies `.worktreeinclude` files, and opens a terminal in it, running `.bashboard/setup.sh` after you approve it |
| `bb pr size [--json]`         | Prints how many lines and files the branch changes, against the size limit; exits 0 at or under it, 1 over it |
| `bb skill install`            | Installs a Claude Code skill that teaches agents these commands               |
| `bb help`                     | Lists the commands (`bb`, `bb -h`, and `bb --help` do the same)               |

Add `--collapsed` anywhere in a command to open the pane collapsed, or `--tab` (`-t`) to open
it as the only pane of a new tab. With `--tab`, `bb open` and `bb git` always open a new pane.
The two cannot be combined. A `--` ends the options: every word after it is an argument, so
`bb search -- --tab` searches for `--tab`. Relative paths resolve against the folder `bb` runs
in, and `open`, `edit`, and `term` need the path to exist. `bb edit
src/main.ts:40` splits a trailing `:<digits>` off as the line number, which must be 1 or more.
`bb git` reports "not a git repository" outside a repo, while `bb search` outside a repo searches
the current folder. `bb scratch` uses its arguments as the text when it has any and otherwise
reads standard input, up to 1 MiB.

`bb browse` takes a bare port (`bb browse 5173`), `:port`, `host:port/path`, or a full `http` or
`https` URL on `localhost` or `127.0.0.1`, or the path to an `.html` or `.htm` file (`bb browse
report.html`, `bb browse C:\reports\q3.html`), and refuses any other address. A relative file path
resolves against the folder the shell is in, as the path arguments above do. With no address it opens
the start page. `--tab` and `--collapsed` work as for the other pane commands.

`bb term` opens a terminal with your default shell profile. The words after `--` are typed into
it as one line followed by Enter, the way you would type them, so they follow that shell's
syntax and the shell stays open after the command ends. `bb term --tab -- pnpm dev` gives a dev
server a tab of its own.

`bb ci` reads the CI of the repo of the folder you are in, on any host the Ship pane supports,
with the same sign-in the Ship pane uses. `--branch` and `--json` (machine-readable output) work
on every `bb ci` command, and `--flag=value` works too. `bb ci wait` checks every 30 seconds
(`--interval`; a value below 10 is raised to 10), prints a line each time something changes, and
gives up after 30 minutes (`--timeout`: seconds, or amounts such as `90s`, `10m`, `1h`, or
`1h30m`). It exits 0 when every run on the latest commit has finished without failing or the
pull request merged, 1 when a run failed or was cancelled, and 2 when it could not tell: the
timeout passed, no run appeared within 5 minutes of the latest commit, eight reads in a row
failed, or the pull request was closed unmerged. It also exits 2 when the request itself is
refused or invalid (bad arguments, a command run outside a pane, a rejected token), so that 1
always means CI failed. A run waiting for someone to approve it is not finished, and exit 2 is
not a failure. `bb ci log` prints the same failure report as Fix with agent, or with
`--run` and `--job` the whole log of one job; with no failed run on the branch it says so and
exits 1. `bb ci status` does not list run or job ids. `bb ci rerun` and `bb ci cancel` change a
pipeline that may deploy, so they do nothing until you turn on `ship.cliWrites` in
[Settings](settings.md#settings); the error says so. Azure DevOps can only re-run failed jobs, so
use `--failed` there. A refused or failed command prints the error text and exits 1. `bb skill
install` writes a skill to `~/.claude/skills/bashboard/SKILL.md` under your home folder that
tells Claude Code to run `bb ci wait` after a push and `bb ci log` after a failure (see
[Setup](setup.md#telling-an-agent-about-bb)). It works in any terminal, says so when the file is
already up to date, and refuses, with exit 1, to replace a file it did not write.

`bb pr size` counts the lines and files the current worktree changes against the merge base with
its comparison ref, the same count as the size badge: committed, staged, unstaged, and untracked
work, without tests, lockfiles, and generated files. It prints one line, such as "512 lines in 14
files against origin/main (threshold 400; tests, lockfiles, and generated files excluded: 210 lines
in 6 files)", or the whole
answer with `--json`. It exits 0 when the count is at or under `git.branchSizeThreshold`, when
that setting is 0, or when there is no comparison ref, and 1 when the count is over it. Any error,
including running outside a pane or outside a git repo, exits 2, so that 1 always means too big.
The skill from `bb skill install` tells Claude Code to run it before committing and, when it is
over, to propose splitting the work.

`bb worktree new <branch>` creates a worktree on a new branch and opens a terminal in it, split
beside the pane that ran it. It fetches the remote and branches from the repo's comparison ref;
`--from <ref>` picks another base and `--from HEAD` the commit you are on. Before it changes
anything it prints the plan, such as "Branching feat/login from origin/main (a1b2c3d); pass --from
HEAD to branch from your current commit" (the hint is left out when you gave `--from`). It then
prints the created path, each path copied from `.worktreeinclude`, any warnings, and what happens
next in the new pane: setup runs, or the script waits for your approval in Bashboard. `--agent`
(`claude`, `codex`, or `copilot`) starts that agent in the new pane once setup has succeeded, and
`--prompt` gives it a first message; `--prompt` needs `--agent`. The worktree, `.worktreeinclude`,
the setup script and its variables, and the approval are described in
[New worktree](#new-worktree).

`bb auth bitbucket` and `bb auth azure-devops <org>` never talk to Bashboard, so they work in any terminal. They ask for the token with the input hidden (or read it from standard
input), save it in Windows Credential Manager or the macOS Keychain (the same place the Accounts tab's **Add token** saves it), and do not open a pane. `--clear` removes it. Each
Azure DevOps organization has its own token. See Code hosts for [Bitbucket](setup.md#bitbucket-cloud) and [Azure DevOps](setup.md#azure-devops).

```sh
bb open docs
bb edit src/main.ts:40
git diff | bb scratch
bb search TODO
bb git --collapsed
bb term -- pnpm test --watch
bb worktree new feat/login
bb worktree new fix-typo --from HEAD
bb worktree new spike --agent claude --prompt "try the new parser"
```

`bb` works in all four shells because Bashboard puts the folder holding `bb.exe` first on every
pane's `PATH`. `bb help`, `bb auth`, and `bb skill install` work anywhere; outside a Bashboard pane every other command prints
`bb: only works inside a Bashboard pane` and exits 1. Any failure, such as a missing path, an
unknown option, or an app that cannot be reached, prints a `bb: ` message to standard error and
exits 1. A successful command prints nothing, apart from `bb auth` saying what it stored or removed and
`bb ci`, `bb pr size`, and `bb skill install` reporting their results, and exits 0 (`bb ci wait` also exits 1 or 2, above, and
exits 2 rather than 1 on any error; so does `bb pr size`).

## Keys on macOS

On macOS the shell never sees Cmd, so Bashboard puts its keys there and leaves Ctrl and Option
to the shell: Ctrl+C interrupts, Ctrl+W deletes a word, and Option+B and Option+F move by word.
The splits and pane keys follow iTerm2.

| Action | Windows | macOS |
| --- | --- | --- |
| Copy, paste | Ctrl+C, Ctrl+V | Cmd+C, Cmd+V |
| Split right, split down | Ctrl+Shift+Right, Ctrl+Shift+Down | Cmd+D, Cmd+Shift+D |
| Split auto, split with a chosen shell | Alt+Shift+D, Alt+Shift+T | Cmd+Option+D, Cmd+Option+T |
| Close pane | Ctrl+W | Cmd+W |
| Move focus | Alt+Arrow | Cmd+Option+Arrow |
| Resize pane | Alt+Shift+Arrow | Cmd+Ctrl+Arrow |
| Zoom pane | Ctrl+Shift+Z | Cmd+Shift+Enter |
| New tab, close tab | Ctrl+Shift+T, Ctrl+Shift+W | Cmd+T, Cmd+Shift+W |
| Next tab, previous tab | Ctrl+Tab, Ctrl+Shift+Tab | Cmd+Shift+], Cmd+Shift+[ (Ctrl+Tab works too) |
| Go to tab 1 to 8, last tab | Ctrl+Alt+1 to 8, Ctrl+Alt+9 | Cmd+1 to 8, Cmd+9 |
| Find | Ctrl+Shift+F | Cmd+F |
| Go to line | Ctrl+G | Cmd+L |
| Toggle the dashboard | Ctrl+Shift+D | Cmd+B |
| Settings | Ctrl+, | Cmd+, |
| Full screen | F11 | Cmd+Ctrl+F |
| Text size | Ctrl+=, Ctrl+-, Ctrl+0 | Cmd+=, Cmd+-, Cmd+0 |
| Save in the text editor | Ctrl+S | Cmd+S |
| Commit, send a scratch pad, open a favorite collapsed | Ctrl+Enter | Cmd+Enter |
| Open a link, toggle a Files row | Ctrl+click | Cmd+click |

Every other Ctrl+Shift key in this guide is Cmd+Shift on macOS: Cmd+Shift+P for the palette,
Cmd+Shift+N for the next thing that needs you, Cmd+Shift+E, G, H, and X for Files, Git,
Search, and the editor, and so on. Cmd+Q quits, saving the workspace first.
