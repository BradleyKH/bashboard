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

Bashboard runs as one window. Launching it again while it is running brings that window to the
front instead of starting a second copy; launched from a shell or a folder (for example
`start bashboard` in Git Bash, or the exe run from Explorer's address bar), it also opens a new
tab in that folder. The Start menu and taskbar shortcuts just bring the window forward.

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
- **Save as** writes the text to a file.

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
selected file or folder in place: Enter saves, and Escape or clicking away cancels. The divider between
the list and the preview can be dragged; until a file is selected, the list fills the pane.

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
buttons beside Find zoom the preview, and the pair in the breadcrumb zooms the list; Ctrl+wheel
over either one zooms it as well. A new Files pane starts at the zoom you last chose for each.

The Expand preview button after the zoom buttons fills the pane with the preview and shows the
file's name in the toolbar. The same button, or Esc (a second Esc when the find bar is open),
brings the list back. The expanded state is kept on relaunch and in layouts.

The text editor saves about a second after you stop typing, when it loses focus, and on Ctrl+S.
If the file changes on disk while you have no unsaved edits, it reloads in place. If it changes
while you do (or a save finds it changed), a bar offers Reload, which discards your edits, or Keep
mine, which overwrites the file.

Hover a row for its menu: **Open terminal here** and **Search in this folder** (folders), **Open in editor**, **Copy path**,
**Insert path** (pastes the path relative to the Files pane's root, or the absolute path outside
it, quoted for the shell of the tab's most recently focused terminal, without pressing Enter),
**Move to** (files; the repo's pinned
folders and the current folder's subfolders), **Rename**, and **Pin**. With several rows selected, the menu
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
breadcrumb, or any row from its menu; they appear in the dashboard's **Pins** section
(the heading collapses them, and is absent while the repo has none), where a click
opens one (a folder in a Files pane, a file in its folder with the file selected), its rename
button renames it, a handle drags it to reorder, and its remove button removes it. A pin whose file or folder is gone is
dimmed and does nothing.

Pins are kept in `repos.json` next to `settings.json`, as a list of entries, each with a repo
`root` and its `pins`. A pin's
`path` is relative to the root with forward slashes when it is inside the repo, and absolute
otherwise; `label` is optional. Roots and pins match without regard to case. The file is plain
JSON you can edit by hand, and the panel updates when you save it.

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
The divider between the lists and the diff can be dragged.

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
`master` that exists. The choice is saved in `repos.json`.

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
ordered by what needs you first. A row shows the repo's `owner/name` with a GH, GL, BB, or AZ badge, a summary of its open pull
requests ("3 PRs open, 1 draft, 1 needs you", highlighted while a review is waiting on you), the number of
pipelines queued or running on any branch ("2 pipelines running", shown only while some are), and a status icon
for each of its **health branches**: the repo's default branch, the branches its open pull requests
target (usually the deploy branches), and any you list for the pin. Each shows how its newest run
ended and how long ago, or "No recent run" when none of the repo's latest 20 runs was on it. When a
repo cannot be read, its row says why, beside the last good data, with a button for a sign-in or
install command where one applies, or one that opens the Accounts tab (**Manage accounts**, **Add
token**, or **Replace token**).

Rows are ordered by the first of these that applies: a health branch whose latest run failed, a pull
request awaiting your review, your own pull request with changes requested or failing checks, a
health branch that is running, and then the rest by most recent activity. Rows tied on one of the
first four keep the order of your pins.

Click a row or its running count to see its Pipelines, or its pull request summary to see its Pull requests. Right-click
a row for **Open Pipelines**, **Open Pull requests**, **Open in browser**, **Open terminal here**
(when the pin has a local clone), **Copy link**, and **Unpin from Overview**; when the pane is wide enough, the same actions
(except Unpin) are buttons at the right of each row. In a repo's own view,
the **Overview** link at the start of the tabs goes back. A repo you pinned without a local clone
has no checked-out branch, so its This branch checkbox is disabled and it has no account button; it
uses the host's default account.

The Overview shows when it was last updated and has its own **Accounts** button, which opens the
Accounts tab, and a **Refresh** button. It refreshes by
itself every 5 minutes (`ship.overviewRefreshMinutes`; 0 turns this off),
every minute while a health branch is running, and when you focus the pane after more than 30
seconds away. It polls only while the Overview or the dashboard's Ship section is on screen and
the window is visible. Bitbucket allows 1,000 requests an hour per user and a refresh costs about
3 per repo, so with more than three Bitbucket repos pinned they refresh less often (every 3 minutes
for ten, even while running), and the bar shows the pace, such as "Bitbucket every 3 min".

**Pinning.** A repo's own view has a **Pin to Overview** button (**Unpin** while it is
pinned). The box under the rows adds a repo without opening it (its **?** button explains the
forms with examples): type `owner/name` (github.com, or
bitbucket.org when every pin is on Bitbucket), `host/owner/name`, or paste a link, which can be an
https or ssh remote URL or the address of a page in the repo, and press Enter or **Pin to
Overview**. Below the box, the folders in your repos list and favorites that are on a host the Ship
pane supports are offered as one-click pins, and pinning one records the folder as the repo's local
clone. Pins are saved as `ship.pinnedRepos` in `settings.json`, where you can also list extra
`branches` for the health row (see [Settings](settings.md#settings)).

**Dashboard.** The dashboard's Ship section, after Ports, first lists what needs you across the
pinned repos: a health branch that failed, your own pull request with changes requested or
failing checks, and up to 5 pull requests awaiting your review. Below them, one line shows the
pipelines running (the run itself when there is just one, else a count), and another counts the
open pull requests that aren't drafts, adding how many await your review when that passes 5. With
no repo pinned yet, it shows a Pin repos row that opens the Overview, and when a pinned repo needs
a sign-in, a row leading the section opens the Accounts tab for it. The setup wizard's Favorites
step can pin repos too: tick "Also pin them to the Ship Overview" before adding, an option shown
when some listed repo is on a host the Ship pane supports. Click a row to open that
repo's Pipelines (for a branch or a run) or Pull requests (for a pull request), or the Overview
for a count across repos; the button in the section's header opens the Overview. Turn the
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
  starts with the stage's name; a GitLab job has no step list). **Show log** loads a job's log (the last 1 MiB of it), scrolled to the
  end, where a failure usually is. The buttons at the right of each run open it in the browser,
  **Re-run** it, **Re-run failed** jobs (GitHub, GitLab, and Azure DevOps), **Cancel** it, or **Copy link**; one that
  does not apply to the run right now is greyed. Right-click a run for the same actions.
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
the Files pane's, with line numbers (markdown shows as source), so you can fix a match in place: it
saves as you type, and once you leave the preview after a save the search runs again, so the list
follows your edit. Esc in the preview goes back to the list, and Find (or Ctrl+Shift+F in the
preview) searches the file. The divider between the list and the preview can be dragged.

A hovered or selected row shows two buttons: 🗀, **Show in Files**, shows the file in
the tab's Files pane for the repo (opening one if there is none), and ↗, **Open in editor**, opens it
in your preferred editor at the line. Enter and a double click on a matching line also open it in
your editor. A file's group header has the same two buttons, which act on the file with no line.
Right-click a row for the same two items plus Copy path and Insert path. A file the preview cannot
show, because it is binary or over 2 MiB, shows a notice with an Open in editor button. The − and +
buttons above the preview, or Ctrl+wheel over it, zoom its text, and a new Search pane starts at
the zoom you last chose.

The pane's query and options are saved with the layout. A Search pane comes back on relaunch with
its query and options, and a non-empty query runs again as soon as the pane loads.

## Dashboard

The panel opens on the right (or the left, with `dashboard.side`) on start (set
`dashboard.visibleOnStart` to `false` to start without it) and Ctrl+Shift+D toggles it. Its top
bar holds the **⚙** (Settings, also Ctrl+,) and **?** (Help, also F1) buttons, which open the
[app dialog](#help-settings-and-shortcuts) on those tabs, and
the × at its right end hides the panel too, with a notice naming the ways back. While it is hidden, a
small handle sits on that edge of the window, halfway down; click it to bring the panel back. F6 moves focus
into it (showing it for the moment if it is hidden), where the arrow keys move between rows, Enter
clicks the focused row, Left and Right collapse and expand sections, Tab reaches a row's buttons,
F2 renames the focused favorite, layout, pin, or tab group header, and F6 or Escape returns to the pane. Drag its inner
edge to make it wider or narrower; the width is saved with the workspace. **Panes** has a card for every pane in the order
they were opened (with two or more tabs, grouped under a header for each tab showing its name,
pane count, and status; click a header to switch to that tab, or right-click it to rename the tab). A terminal's card shows its status (a green check mark when it is done),
folder, and time since its status last changed, plus, while a coding agent session runs in it, the model
and the tokens in its context on a line below the folder (as "Opus 5.5 · 112k tokens" for Claude Code, and
"Codex · gpt-5.5 · 112k / 272k tokens" for the others, which lead with the agent's name); a card for any other kind of pane shows the
kind's icon and the pane's title. Folder paths under the card titles are hidden by default; the
**↳** button on the Panes header shows them, and the choice is saved with the workspace. While
they're hidden, hover a card's title to see its full path. Click a card to focus its pane (for a pane hidden by a zoom, that brings it back and ends
the zoom in its tab), or use its close button, which
asks first when a Claude session is running there or a scratch pad has text. Click a section's
header to collapse or expand it; the choice is remembered across launches. Drag a section's
header, or the clock, to put the sections in a different order, in the top slot above Pins or
the list at the bottom; that is remembered too. Right-click an empty spot or a section header
for a menu that shows or hides each section, or use Settings (see
[Settings](settings.md#settings)). **External sessions** lists Claude Code sessions running outside Bashboard, such as in
Windows Terminal or VS Code; click one to see its folder and session id with copy buttons. The
section appears only while there are some. Hover any favorite, recent folder, card, or session
for a folder button that opens its folder in File Explorer, and an Open menu beside it that opens
the row's repo root as a Terminal, as Files (see [Files panes](#files-panes)), as Git (see
[Git pane](#git-pane), for a git repo only), as Search (see [Code search](#code-search)), or in
your Editor.

**Launch** sits at the top by default and appears while the focused pane is in a folder (a
scratch pad keeps the last one shown). Its row of icons opens a Terminal, Git, Files, Ship (see
[Ship pane](#ship-pane)), Search (see [Code search](#code-search)), or Scratch pane at the
focused pane's repo root, with Git and Ship for a git repo only (Ship opens on that repo, not the
Overview); hover one for its name and shortcut. While you hover, the
panes show where the new one will open: the focused pane outlined and the new pane's share of it
highlighted, or the Files or Git pane it would bring forward, or a note that it opens collapsed
when there is no room. Like the other sections it can be dragged elsewhere or turned off; it does
not collapse.

Ctrl+Shift+L (the `openLaunch` action) opens the same choices, plus Containers and Ports, as a
menu over the focused pane, outlined in your accent color with the rest of the window dimmed:
press a letter (**t** Terminal, **g** Git, **f** Files, **o** Ship, **s** Search, **c**
Containers, **r** Ports, **p** Scratch), or use the arrows and Enter, with the same preview as you
move. Containers appears once Docker or Podman is installed. While Launch is turned
off, a **+** button in the top bar, left of **?**, drops this menu. Ctrl+Shift+X (the `openEditor`
action) opens the focused pane's repo in your editor directly, or its folder outside a repo.

**Pins**, the repo's pinned files and folders (see [Pins](#pins)), stay put just below the top
slot so the sections don't jump as pins come and go. The heading names the folder too, if it
fits.

The **clock**, which is off by default, is one line at the top of the panel, above Launch: three
rows of dots showing the hours (24-hour), minutes, and seconds in binary, and the time as
`h:mm` beside them. Right-click the clock to show just the time or just the dots instead,
or to hide it; Clock style in the Settings tab does the same. Drag it down among the other sections to move it there, or back to the top.
It ticks only while the panel is on screen.

The **System** section is off by default; turn it on under "Show on the
dashboard" in Settings. It shows CPU use with a 60 second sparkline, memory used of total,
network receive and send rates with a sparkline for each, and free space on each fixed drive, with bars that turn amber at
80% and red at 90%. CPU and network fill in on the second sample after the section starts. It
samples only while it is expanded, the panel is on screen, and the window is shown.

The **Wave**, also off by default, is a slowly turning looped line that reacts to your machine:
it weaves tighter as CPU load rises and turns faster and brighter with network traffic. Hover it
for the readings. Like the clock it has no header; drag it anywhere on the panel to move it. It
holds still when the background animation is paused (Ctrl+Shift+A) or Windows asks apps to
reduce motion.

**Favorites** are folders you open terminals in often. By default they live behind the
**Favorites** button in the panel's top bar, which drops a list that filters as you type;
Ctrl+Shift+O opens the same list in the middle of the window. Enter or a click opens the selection
as a split of the focused pane, and Ctrl+Enter or Ctrl+click opens it collapsed. The **+ Add**
button beside the filter adds the focused terminal's folder (and its shell, when that is not the
default); it is grayed out when that folder is already a favorite. When the focused pane has no
room for another split, a toast says so and the terminal opens collapsed.

Turning Favorites on under "Show on the dashboard" lists them on the panel instead, above the
terminals, where rows can also be renamed, removed, and reordered by dragging, and the
section's "+" adds the focused folder. Below them, **Recent** lists up to five folders from Claude
sessions that are not already favorites, each with a star to promote it. While the section is
shown, the top bar's Favorites button is not.

### Layouts

**Layouts** save the active tab's arrangement of panes under a name: each pane's kind, its folder
and shell (for terminals), its collapsed state, and how the panes are split. Scratch pads are
saved as panes but open empty. By default they live behind the **Layouts** button in the panel's
top bar, and Ctrl+Shift+R opens the same list in the middle of the window; both filter as you
type, and Enter or a click opens the selection. The **+ Save** button beside the filter turns it
into a name field: type a name and press Enter to save, or Escape to go back to the list. The row
under the name says "Replace" when a layout already has that name (any capitalization), so you
see it before you press Enter.

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
prompt below it. It is saved when you close the window, so after a crash you get the scrollback
from the last normal close. Container shells and terminals opened from a layout start empty. Turn
off **Restore terminal scrollback** in Settings (`restore.scrollback`) to stop saving it.

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

With the Swirling Lights background, each live agent session also appears in the backdrop as its
own colored lineage. It blooms while the session is busy and thins while it is idle; set
`backdrop.waitingPulse` to `true` to also make it pulse while it waits for you. The color
matches the swatch beside the session in the dashboard. The Matrix and None backgrounds show no
lineages, so the dashboard hides those swatches; switching back to Swirling Lights brings each live session's lineage back as a fresh
founder. The Background choice in the Settings tab picks the style (see
[Settings](settings.md#settings)), and Ctrl+Shift+A pauses or resumes it. Ctrl+Shift+B cycles
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

Each row shows the project's name, how many of its containers run ("1 of 2"), and one button on
hover. A project with a single container gets Start or Stop; a project with more gets a details
button (›) that opens it in the Containers tab, where each container can be started or stopped.
Right-click a row to start or stop a whole project. A project that exists on both engines is one row.
Click a row to open the Containers tab with that project expanded. The Manage button (an arrow
leaving a square) in the section's header switches to a Containers tab that is already open, or
adds one.

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
the log text, and the next logs panel starts at the zoom you last chose. Shell opens a terminal split beside the pane, running `bash` in
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
are left out. The Manage button (an arrow
leaving a square) in the header opens the Ports tab.

The **Ports pane** lists every listening port in columns (port, program, the pane that started
it, address, process id, and uptime), sorted by port; click a column header to sort by it, and
again to reverse. The Pane column is left out when no listed port was started from a pane. Each
port's folder gets its own column when the pane is wide enough, and sits beneath the row
otherwise; tick **Command lines** to show each full command line under its folder. Each row has
**Open**, **Go to pane**, and **Stop** buttons, a double-click opens it in your browser, and a
right-click gives the dashboard's menu.

Type in the filter to narrow the list by port, program, command, folder, or pane name (Escape
clears it). The pane opens with **Started from a pane** ticked, listing only ports your panes
started; untick it to see everything else, and tick **Windows services** to include the system's
own ports, dimmed. Opening the pane from the dashboard on a port no pane started unticks it for
you. Any pane can also become a Ports pane from its kind menu.

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
While Bashboard is in the background, a terminal that starts waiting also shows a Windows
notification; click it to jump to that pane. Turn **Notify when a terminal needs you** off in
Settings (`terminal.notifyWhenWaiting`) to stop them.

A waiting terminal's dashboard card glows faintly in the accent color for as long as it waits,
whether or not you have looked at it.

A waiting terminal shows why: the pane card, the status dot's tooltip on the title strip, the
tab's tooltip, and an external session's row carry the message the agent sent with its hook (for
example that it needs your permission to use a tool), or "Waiting for you" when there is none.

Ctrl+Shift+N jumps to the next terminal that needs you, across all tabs: waiting ones first,
oldest first, then done and failed ones. It switches to the pane's tab, expands a collapsed card,
and ends a zoom in the way. Repeated presses walk the list, and a toast says "Nothing needs you"
when it is empty.

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

## Command palette

Ctrl+Shift+P opens one list over your panes, tabs, favorites, layouts, the focused repo's pins and
worktrees, and the actions, each with its keys. The actions include Open the Containers tab, Open
the Ports tab, and Open the Ship tab (the Ship [Overview](#overview)), which switch to that pane or
add a tab holding one. Typing filters the list fuzzily, and a leading `>`
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

## Help, settings, and shortcuts

One dialog holds six tabs: **Help**, **Settings**, **Accounts**, **Shortcuts**, **CLI**, and
**About**. F1 or the dashboard's **?** opens it on Help, and Ctrl+, or **⚙** opens it on Settings.
The command palette lists all six, and Accounts, Shortcuts, CLI, and About can be given keys of
their own. Ctrl+Tab and
Ctrl+Shift+Tab (or Ctrl+PageDown and Ctrl+PageUp) move between tabs, pressing a tab's own key
again closes the dialog, and Escape or a click outside closes it too.

- **Help** is a short tour of the main features with your current keys, and a Setup list that
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
  token**) opens a password field, **Save** stores the token in Windows Credential Manager, and
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
CLI tab lists the same commands, with examples to copy. Each command that
opens a pane splits the pane that ran it, in that pane's tab, and focus moves to the new pane.

| Command                       | What it does                                                                  |
| ----------------------------- | ----------------------------------------------------------------------------- |
| `bb open <path>`              | Shows a folder in a Files pane, or a file's folder with the file selected     |
| `bb edit <path>[:<line>]`     | Opens the file or folder in your preferred editor, at the line when given     |
| `bb git`                      | Opens the Git pane for the current folder's repo                              |
| `bb search [<query>]`         | Opens a Search pane for the current folder's repo, with the query filled in   |
| `bb scratch [<text>]`         | Opens a scratch pad holding the text, or the piped standard input             |
| `bb auth bitbucket [--clear]` | Stores a Bitbucket API token for the Ship pane, or removes it with `--clear` (the Accounts tab does the same) |
| `bb auth azure-devops <org> [--clear]` | Stores an Azure DevOps personal access token for one organization, or removes it with `--clear` (the Accounts tab does the same) |
| `bb help`                     | Lists the commands (`bb`, `bb -h`, and `bb --help` do the same)               |

Add `--collapsed` anywhere in a command to open the pane collapsed. Relative paths resolve
against the folder `bb` runs in, and `open` and `edit` need the path to exist. `bb edit
src/main.ts:40` splits a trailing `:<digits>` off as the line number, which must be 1 or more.
`bb git` reports "not a git repository" outside a repo, while `bb search` outside a repo searches
the current folder. `bb scratch` uses its arguments as the text when it has any and otherwise
reads standard input, up to 1 MiB.

`bb auth bitbucket` and `bb auth azure-devops <org>` never talk to Bashboard, so they work in any terminal. They ask for the token with the input hidden (or read it from standard
input), save it in Windows Credential Manager (the same place the Accounts tab's **Add token** saves it), and do not open a pane. `--clear` removes it. Each
Azure DevOps organization has its own token. See Code hosts for [Bitbucket](setup.md#bitbucket-cloud) and [Azure DevOps](setup.md#azure-devops).

```sh
bb open docs
bb edit src/main.ts:40
git diff | bb scratch
bb search TODO
bb git --collapsed
```

`bb` works in all four shells because Bashboard puts the folder holding `bb.exe` first on every
pane's `PATH`. `bb help` and `bb auth` work anywhere; outside a Bashboard pane every other command prints
`bb: only works inside a Bashboard pane` and exits 1. Any failure, such as a missing path, an
unknown option, or an app that cannot be reached, prints a `bb: ` message to standard error and
exits 1. A successful command prints nothing, apart from `bb auth` saying what it stored or removed, and
exits 0.
