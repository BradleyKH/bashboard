# Git

Section numbers are ids shared across every file in `docs/design/`, so a citation such as
"section 4.5" names one section wherever it lives; [the index](README.md#index) maps each to its file.

## 3.9 Git (`src-tauri/src/git.rs`, `src-tauri/src/git_fetch.rs`, `src-tauri/src/git_worktrees.rs`, `src-tauri/src/git_branches.rs`)

Runs `git` (from `PATH`, else beside Git Bash's `bash.exe`) as `git -C <root> ...` with an
argument list, never through a shell, and with paths after `--`. Reads set
`GIT_OPTIONAL_LOCKS=0`, so a status refresh never takes the index lock while Claude runs its
own git commands.

| Command | Runs |
| --- | --- |
| `git_status(root)` | `status --porcelain=v2 --branch -z`: branch, upstream, ahead and behind, staged, unstaged, and untracked entries, plus the repo's remote names from `remote`, as `remotes` |
| `git_stage(root, paths)` | `add --` |
| `git_unstage(root, paths)` | `restore --staged --`, or `rm --cached --` in a repo with no commits |
| `git_diff(root, path, staged)` | One file's diff, capped at 1 MiB; an untracked file diffs against nothing |
| `git_log(root, count)` | The last commits: hash, subject, author, time, and whether any remote-tracking branch contains each |
| `git_show(root, hash)` | One commit's diff, capped at 1 MiB |
| `git_commit(root, message)` | `commit -F -` with the message on stdin; the repo's hooks run as usual |
| `git_undo_commit(root, expectedHead) -> message` | `reset --soft HEAD~1`, returning the undone commit's message |
| `git_branches(root)` | `for-each-ref` over `refs/heads` (upstream, track, tip time and subject, and the worktree that has each checked out) and `refs/remotes`; returns local branches, current first then newest first, and the remote branches no local branch tracks or shares a name with, newest first |
| `git_switch(root, name)` | `switch --no-guess <name>` |
| `git_checkout_remote(root, name)` | `switch --track <remote>/<branch>` |
| `git_create_branch(root, name, base, switchTo)` | `switch --no-track -c <name> <base>`, or `branch --no-track <name> <base>`; `base` is a local branch, or HEAD when null |
| `git_rename_branch(root, from, to) -> {upstreamCleared}` | `branch -m <from> <to>`, then `branch --unset-upstream <to>` when it had an upstream |
| `git_delete_branch(root, name, force) -> {deleted, hash, unmerged}` | `branch -d`, or `branch -D` with `force` |
| `git_restore_branch(root, name, hash)` | `branch <name> <hash>` |
| `git_fetch(root, background)` | `fetch --prune` |
| `git_pull(root)` | `pull --ff-only` |
| `git_push(root)` | `push`, or `push -u <remote> <branch>` for a branch with no upstream |
| `git_last_fetch(root) -> {time, ok, message}` | The latest fetch attempt for the repo, or null when there has been none this session |
| `git_fetch_roots(roots)` | Replaces the roots that have an open Git pane, for the background fetch |
| `git_fetch_visible(visible)` | Tells the background fetch whether the window is on screen |
| `git_watch(root)` | Starts (or shares) the metadata watcher below |
| `git_unwatch(root)` | Releases one reference to that watcher |
| `git_worktrees(root)` | `worktree list --porcelain -z`, `for-each-ref` for each branch's upstream and track, and `rev-list --left-right --count` against the comparison ref per worktree; returns the worktrees, the primary branch, and the local branches |
| `git_worktree_detail(path)` | `status --porcelain=v2 --branch -z` and `log -1` in that worktree, plus its merged state |
| `git_primary_branch(root)` | The branch worktrees are compared against, its comparison ref, and the configured value |
| `git_worktree_remove(root, path, deleteBranch)` | `worktree remove <path>`, or `worktree prune` when the folder is missing, then `branch -d <branch>` when asked |

`git_undo_commit` is refused when HEAD is not `expectedHead`, has no parent, or when a merge,
rebase, cherry-pick, or revert is in progress. A pushed commit can be undone; republishing the
branch then takes a force push, which the pane leaves to the user. A soft
reset moves only the branch; the working tree and index are untouched, so the commit's changes
stay staged.

Push never forces: a rejected push returns git's message, and a force push after undoing a
pushed commit is left to a terminal. A branch with no upstream is published to `origin`, or to
the repo's only remote; with several remotes and none named `origin`, `git_push` refuses and
says to publish from a terminal. Manual fetch, pull, and push run with `GIT_TERMINAL_PROMPT=0`,
so git never waits on a prompt it cannot show, while Git Credential Manager can still open its
own sign-in window.

Fetch records are kept per repo, keyed by common git dir, so Git panes on two worktrees of one
repo share one record and one fetch. A fetch holds a per-repo lock, so a manual and a
background fetch never run at once; `git_pull` waits on the same lock and `git_push` does not.
Every fetch attempt, and every successful pull (which fetches), records its outcome and emits
`git://fetched` with the roots that share the repo, plus the root a manual command ran on, since a
failed fetch moves no refs and so raises no `git://changed`. A failed pull records nothing.

The branch commands live in `git_branches.rs` and reuse the runner in `git.rs`. Every branch
name from the front end must pass `check-ref-format --branch`, may not start with `-` or hold
`@{`, and, for an existing branch, must exist under `refs/heads`, so git never reads one as an
option or a revision expression. A remote branch name must exist under `refs/remotes`. A new
branch never tracks its base, so it is published with Push like any branch with no upstream.
Rename clears the upstream because git keeps the old one, and a plain push then refuses the
mismatched name. Delete without `force` returns `deleted: false` and `unmerged`, the count of the
branch's commits on no other branch, remote-tracking branch, or tag, when `branch -d` refuses an
unmerged branch; every other refusal, such as the current branch or one checked out in another
worktree, returns git's output. `hash` is the tip the branch had, so the pane can restore it.
The parsers are pure functions with unit tests.

The worktree commands live in `git_worktrees.rs` and reuse the runner in `git.rs`; the reads set
`GIT_OPTIONAL_LOCKS=0`. Every worktree of the repo's common git dir is listed, the main worktree
first, then the rest by folder name. The porcelain parser, the primary branch resolution, and
the merged-state derivation are pure functions with unit tests.

The primary branch resolves, in order, from the repo's `primaryBranch` in `repos.json` (section
7, keyed by the main worktree's path) when that branch exists; from the branch
`refs/remotes/origin/HEAD` points at; then from the first of `dev`, `develop`, `main`, and
`master` that exists as a local branch or on `origin`. The comparison ref is `origin/<primary>`
when it exists, so merged means merged on the remote, and the local `<primary>` otherwise. With
no primary branch, ahead and behind are zero and the merged state is unknown.

A worktree's merged state comes from local git only. It is **Merged** when
`merge-base --is-ancestor <branch> <comparison>` succeeds, which includes a branch with no
commits of its own. It is **Probably merged** when that fails and the branch's upstream is gone
(`for-each-ref` reports `[gone]` for `%(upstream:track)`), which is how a squash-merged pull
request looks after a fetch with prune; it is as current as the repo's last fetch. Otherwise it
is **Not merged**.

`git_worktree_remove` never runs `--force` or `branch -D`. It refuses the main worktree, a locked
worktree (giving the lock reason), a worktree whose folder exists and is not clean (any staged,
changed, or untracked file), and a branch delete for a branch that is not Merged. A worktree
whose folder is missing is cleared with `worktree prune`, which clears the records of every
worktree whose folder is missing, and the clean check does not apply; it errors if git kept the
record. A failure from git itself returns git's output. A `branch -d` that fails after the
worktree is removed does not fail the command: the result carries `branchError` and the branch
stays. The check that no pane or external Claude session sits inside the folder is made by the
front end before it asks (4.6).

A background scheduler fetches each repo that has an open Git pane (`git_fetch_roots`), once per
common dir, every `git.autoFetchMinutes` (section 8; 0 turns it off). A pane opening on a repo
with no fetch yet, or a stale one, fetches at once. The scheduler pauses while the window is
hidden or minimized, on the signal the backdrop pauses on (6.4) reported through
`git_fetch_visible`, and catches up when the window is shown. Background fetches also set
`GCM_INTERACTIVE=never` and have no stdin, so they never show a credential window, and one is
killed after 60 seconds. A background failure is quiet: it shows only as the pane's "Fetch failed" label. After three background failures in a row a repo
is skipped until a manual Fetch runs. When a fetch moves refs, the watcher below emits
`git://changed` and the pane refreshes.

`git_watch(root)` and `git_unwatch(root)` run a watcher on the repo's git metadata and its
worktree. Metadata is `HEAD` and `index` in the git dir and `packed-refs` and `refs` in the
common dir, never `objects/`. The worktree is watched recursively; a change there counts unless
its path is inside a `.git` or ignored by the repo's `.gitignore` files, `info/exclude`, or the
global excludes file, so a build writing to an ignored folder does not refresh the pane. Watchers
are reference-counted per normalized root, so Git panes on one repo share one. A change emits
`git://changed` with the root, debounced 300 ms for metadata and 1 second for the worktree, and
at most 3 seconds after the first change while changes keep arriving. The payload's `metadata`
flag is true when refs, `HEAD`, the index, or a worktree record changed (or the watcher reported
an error), and false when only worktree files changed.

## 3.25 Branch size (`src-tauri/src/git_branch_size.rs`, `src-tauri/src/size_route.rs`)

The branch size meter catches a sprawling agent branch mid-session instead of at review.
`git_branch_size(path)` counts the lines and files a worktree changes against its comparison ref
(3.9) and returns `BranchSize`: `worktree`, `branch` (null when detached), `comparison` (null when
there is none), `lines` (`added` plus `removed`), `added`, `removed`, `files`, and `excludedLines`
and `excludedFiles` for what the exclusions below left out. It runs from the worktree's toplevel,
so untracked files outside the folder it was given still count, and it resolves the comparison ref
as `git_worktrees` does, honoring the repo's `primaryBranch`. With no comparison ref, or no merge
base (unrelated histories, an unborn HEAD), every count is zero.

The base is `git merge-base HEAD <comparison ref>`, so commits the branch has not merged in from
its comparison ref stay out of the count, and the count covers committed, staged, unstaged, and
untracked work together:

- Tracked changes come from `git diff --numstat -z -M --no-ext-diff <merge-base>`. A rename counts
  once, under its new path. A binary file counts as a file with no lines.
- Untracked files come from `git ls-files --others --exclude-standard -z`, so ignored files stay
  out, and each counts all its lines as added. One over 1 MiB, or with a NUL byte in its first 8
  KiB (the test git applies to call a file binary), counts as a file with no lines.
- Tests, lockfiles, and generated files are left out of `lines`, `added`, `removed`, and `files`
  and tallied in `excludedLines` and `excludedFiles` instead. A path is excluded, ignoring case,
  when any folder in it is named `test`, `tests`, `__tests__`, `spec`, `testdata`, or `fixtures`;
  when its name has a `.test.` or `.spec.` or `_test.` marker with text on both sides, or is
  `test_*.py`; when it is a lockfile: `pnpm-lock.yaml`, `package-lock.json`, `yarn.lock`,
  `bun.lock`, `bun.lockb`, `Cargo.lock`, `poetry.lock`, `uv.lock`, `Pipfile.lock`,
  `Gemfile.lock`, `go.sum`, `composer.lock`, `packages.lock.json` (NuGet), `Package.resolved`
  (SwiftPM), `pubspec.lock`, `mix.lock`, or `flake.lock`; or when it is generated:
  - a folder above it is named `generated` (Prisma's `prisma-client` output), `__generated__`
    (Relay, Apollo), or `__snapshots__` (Jest);
  - its name ends, with text before the suffix, in `ModelSnapshot.cs` or `.Designer.cs` (EF
    Core's model snapshot and each migration's designer file, plus WinForms and resx designer
    files), `.g.cs` or `.g.i.cs` (C# source generators, WPF), `.g.dart` or `.freezed.dart`,
    `.pb.go`, `_pb2.py`, `_pb2.pyi`, or `_pb2_grpc.py` (protobuf), `.min.js`, `.min.css`, or
    `.map`, or `.snap`;
  - its name has a `.generated.` or `.gen.` marker with text on both sides (TanStack Router's
    `routeTree.gen.ts`), or is `next-env.d.ts`;
  - it sits directly in a `meta` folder and is `_journal.json` or ends in `_snapshot.json`
    (drizzle-kit's per-migration schema snapshots, under whatever its output folder is named);
  - `.gitattributes` gives it `linguist-generated` or `linguist-vendored` (set or `true`), or
    unsets `diff` (`-diff`, or the `binary` macro), read with one `git check-attr -z --stdin`
    over every counted path. A repo can mark its own generated code this way.

  Hand-written migrations still count: an EF migration's own `<timestamp>_<Name>.cs`, a Prisma
  `migration.sql`, and a drizzle-kit `.sql` file are often edited by hand and are what a
  reviewer reads.

Reads set `GIT_OPTIONAL_LOCKS=0`. The numstat parser, the exclusion test, and the tally are pure
functions with unit tests.

`POST /size` on the hook receiver (3.3) serves `bb pr size` (3.13). It is admitted like `/ci`
(3.23): the per-launch token and a live pane, and each request runs on its own thread, since a
diff can take a moment on a large repo. The body is `{ cwd }`; the answer is `{ size, threshold }`,
with `size` as above and `threshold` the `git.branchSizeThreshold` setting (section 8). A folder
that is not a git repo answers 400 with `{ error: "not a git repository" }`, as does a body that
is not valid or a folder that does not exist, and a failure from git answers 500. The route only
reads.

## 3.27 New worktree (`src-tauri/src/worktree_new.rs`, `src-tauri/src/worktree_trust.rs`, `src-tauri/src/worktree_route.rs`)

A worktree for a task is one command: it branches off fresh remote state, copies the local files a
checkout lacks, and numbers the worktree so its setup can avoid colliding with the others.
`plan(cwd, branch, from)` and `create(cwd, branch, from)` do the work, behind the `worktree_plan`
and `worktree_create` commands and `POST /worktree` (below).

**Plan.** `plan` only reads and returns `WorktreePlan` (camelCase): `mainRoot`, `branch`,
`baseRef`, `baseSha`, `shortSha`, `path`, `name`, and `hint`. It fails before anything changes
when the branch is not a valid name (`git check-ref-format --branch`), a local branch of that name
exists (the error suggests another), or the folder exists.

- **Base.** The repo's comparison ref, the one the Git pane's Compare with uses (3.9), or
  `--from <ref>`; `--from HEAD` is the calling folder's current commit. `hint` is true when no
  `from` was given. The plan line the callers print is `Branching <branch> from <ref>
  (<short sha>)`, plus `; pass --from HEAD to branch from your current commit` when `hint` is true.
- **Location.** A sibling of the main worktree, `<parent of the main worktree>/<repo folder
  name>-<branch>`, where the branch has `/`, `\`, and characters Windows rejects in file names
  (`< > : " | ? *`, control characters) replaced with `-`, and leading and trailing dots and spaces
  trimmed. `name` is that folder's name.

**Create.** `create` runs the plan checks again, then:

1. Fetches. The remote is the comparison ref's, else the current branch's upstream's, else
   `origin`, with a 60 second timeout. Any failure (offline, no remote, a timeout) becomes a
   warning and creation continues from local refs.
2. Resolves the base again, since the fetch may have moved it.
3. Runs `git worktree add -b <branch> <path> <base commit>`. The branch starts at the resolved
   commit, so it has no upstream and the Git pane's Push reads Publish.
4. Copies `.worktreeinclude`, then assigns the index.

It returns `WorktreeCreated`: `plan`, `index`, `copied` (the paths copied), `warnings`, and
`setup`, which is `none` (no `.bashboard/setup.sh` in the new worktree), `trusted`, or
`needsApproval`.

**`.worktreeinclude`.** An optional file at the main worktree root that names gitignored files
(`.env`, a `node_modules` folder, a local database) to copy, not link, into the same relative
path in the new worktree. One literal relative path per line; blank lines and `#` comments are
allowed. A line is skipped with a warning when it contains a glob character (`*`, `?`, `[`),
starts with `!`, is absolute, or contains `..`, and so is a path that is missing, tracked by git,
or not ignored (`git check-ignore -q`). A file or a folder is copied; a symlink inside a copied
folder is skipped with a warning.

**Index.** `BB_WORKTREE_INDEX` is a small positive integer, stable per worktree, for offsetting
ports and database names. It is recorded in a file named `bashboard-index` in the worktree's git
admin dir (`.git/worktrees/<name>/`) and read back from there. The main worktree has no number,
so the first worktree gets 1; a new one takes the smallest integer the repo's other worktrees do
not hold, so a deleted worktree's number is reused.

**Setup script.** `.bashboard/setup.sh` is read from the new worktree, so it is the version
committed at the base. The front end runs it in the new pane (4.27) with these variables set:

| Variable | Value |
| --- | --- |
| `BB_ROOT_PATH` | The main worktree's folder |
| `BB_WORKTREE_PATH` | The new worktree's folder |
| `BB_WORKTREE_NAME` | The new folder's name |
| `BB_WORKTREE_INDEX` | The index above |

`worktree_setup_script(path)` returns the script text of the worktree at `path`, or null, for the
approval dialog's Show script button. There is no per-user override script.

**Trust.** A script from the repo runs only after the user approves it. `worktree-trust.json`, in
Bashboard's config folder beside `settings.json` and written atomically, holds one approved script
text per main worktree root. The store keeps the exact text, not a hash, so a script that differs
by a character asks again and a crafted collision cannot pass. `worktree_trust_setup(mainRoot,
path)` reads the script at `path` in the core and stores that, so the approved text is the text
that runs; a script that is not UTF-8 cannot be approved. `create` reports `trusted` when the
stored text equals the script, and `needsApproval` otherwise.

**Route.** `POST /worktree` on the hook receiver (3.3) serves `bb worktree new` (3.13). It is
admitted like `/size` (3.25): the per-launch token and a live pane, and each request runs on its
own thread, since it fetches and copies. The body is `{ cwd, branch, from?, agent?, prompt?,
dryRun }`. With `dryRun` it answers 200 `{ plan }` and changes nothing, which is how `bb` prints the
plan line before acting. Otherwise it creates and answers 200 `{ created }`, then emits
`worktree://created` with `{ ptyId, created, agent, prompt }`, where `ptyId` is the calling pane's
(`BASHBOARD_PANE_ID`, as `/cli` passes it), so the front end opens the new pane beside it. A bad
body or a failed plan check answers 400 and a git failure while creating answers 500, each with
`{ error }`. `agent` is `claude`, `codex`, or `copilot`, and any other value answers 400; `bb`
refuses `--prompt` without `--agent`, since the prompt is typed after the agent's launch command.

## 4.13 Git pane

For one git repo. A head row spans the pane: the **branch line** and the **Changes** and
**Branches** tabs. The tab shows in workspace.json as the pane's `tab`, absent for Changes.

The **branch line** shows the branch with its upstream and the ahead and behind counts, the last
fetch label, and the Fetch, Pull, and Push buttons. While the worktree's changes against its
comparison ref exceed `git.branchSizeThreshold` (3.25; 0 turns the badge off), a warning chip
after the branch name reads the line count ("512 lines"); its tooltip gives the added and
removed lines, the file count, the comparison ref, and what the exclusions left out. The chip is
absent at or under the threshold and when there is no comparison ref. The size comes from a store
shared with the session cards and the dashboard's Branch section (4.6), which refetches on the
git watcher's `git://changed` (3.9) and when an agent working in that folder stops, never on a
timer, and pauses while the window is hidden. It reads only while the pane is expanded. Clicking the branch name opens the
**branch switcher**: a filter field over the local branches, then the remote ones, ending in a
"Create branch <name>" row when the text is a valid name no local branch has. Up and Down move,
Enter picks, Escape closes. It opens on the first branch that is not current. Picking a local
branch switches to it, or opens a Git pane on the worktree that has it checked out; a remote one
checks it out (as Check out does below); Create makes the branch from HEAD and switches to it.

**Changes**, top to bottom:

- **Commit box.** A message field and a Commit button (Ctrl+Enter in the field), enabled while
  something is staged and the message is not empty. A failed commit (a hook rejecting it, for
  example) shows git's output under the box and keeps the message.
- **Staged** and **Changes** lists. Changes holds unstaged and untracked files. Each row shows
  its status letter and path, with stage or unstage and Open in editor on hover; each list's
  header has Stage all or Unstage all. Clicking a row shows its diff. A right-click on a row
  offers Show diff, Stage or Unstage, then Open in editor (disabled for a deleted file), Copy
  path, and Insert path. Staged and Changes rows drag
  their path onto a terminal or scratch pad (4.4), a deleted file's included.
- **Recent commits:** the last 20, each with subject, short hash, relative time, and a mark when
  no remote-tracking branch contains it. Clicking one shows its diff. A right-click on a commit
  offers Show diff, Copy hash, Copy subject, then a push entry on an unpushed commit while the
  branch has an upstream: Push (as the branch row's button) on HEAD, and Push up to here on an
  older one, which runs `git push <remote> <hash>:<upstream branch>` so newer commits stay local
  (never forced; git rejects it when the upstream has moved). On the commit the diff bar's Undo
  commit button targets, it also offers Undo commit (which asks first, as the button does).

Diffs show in a panel beside the lists, unified, with added and removed lines colored and hunk
headers kept. Code in the diff takes the colors of its language (4.22), under the added and
removed tints, unless the Code colors setting is None. A diff over the cap says so. The bar ends in − and + zoom buttons,
and Ctrl+wheel over the diff panel steps them, as the Files pane's do (4.12), saving to
`textZoom.gitDiff` in workspace.json.

**Undo commit** sits at the start of that bar while the selected commit is the newest one and
HEAD. It asks
first, naming the commit, noting that its changes stay staged, and warning when the commit is
already pushed that a force push will follow; then it runs `git_undo_commit`
(3.9) with the hash the pane showed, and puts the undone message into the commit box, above any
draft already there. The refusal cases in 3.9 show as an inline error beside the button.

**Remote buttons.** Fetch (`git fetch --prune`) is enabled when the repo has a remote. Pull
shows the behind count, as "Pull (3)", and runs `git pull --ff-only`; it is enabled when the
branch has an upstream and is behind it. Push is enabled when the branch has an upstream and is
ahead of it; with no upstream it reads Publish and runs `git push -u` to `origin`, or to the only
remote. Publish is disabled, with a tooltip, when the repo has no remote, HEAD is detached, there
are no commits, or there are several remotes and none is named `origin`. While one of the three
runs, all three are disabled and the running one shows an ellipsis, and the commit box stays
usable. A failure shows git's output where a failed commit's output shows, under the commit box,
until the next remote operation succeeds.

The **last fetch label** reads "Fetched 3 min ago" after a fetch, background or manual, and
"Fetch failed" after a failed one, with git's output as its tooltip. It is empty until the repo
has been fetched this session, and updates on `git://fetched` (3.9).

**Branches** fills the pane below the head row, from `git_branches` and `git_worktrees` (3.9):

- **Bar.** A field that filters both lists by name, ignoring case, and names a new branch; a
  New branch button (Enter in the field) that creates the field's name and switches to it,
  disabled with the reason as its tooltip while the name is invalid or taken; and **Clean up N
  gone**, shown while any branch other than the current one, and not checked out in another
  worktree, has a gone upstream: its remote-tracking branch was deleted. After New branch
  from here, a "from <branch> ×" chip beside the field names the base; clicking it goes back to HEAD. Escape in the field
  clears it and the chip.
- **Worktrees**, shown while the repo has two or more worktrees and open until its header is
  clicked (described below).
- **Local**, the current branch first and marked, then newest first. Each row shows the name; a
  worktree badge (its path as tooltip) when another worktree has it checked out; the upstream
  state as `↑2 ↓1`, or a **gone** badge; and the tip's subject and relative time. Hover shows
  Switch (Open, for a branch in another worktree, which opens or focuses a Git pane there),
  Rename, and Delete, which is disabled with the reason on the current branch and one in another
  worktree. A right-click offers Switch (or Open its worktree), New branch from here, Rename,
  Delete, Copy name, and Insert name.
- **Remote**, collapsed until its header is clicked, and open while the field holds a filter:
  the remote branches with no local copy, each with Check out, which creates a local branch
  tracking it and switches to it. A right-click offers Check out, Copy name, and Insert name.

Click selects a row and double-click runs its first action. With the list focused, Up and Down
move (Up from the first row returns to the field, Down from the field enters the list), Enter
runs the first action, F2 renames, and Delete deletes. Rename edits the name in place: Enter
renames, Escape or leaving the field cancels, and an invalid or taken name outlines the field and
is not sent. Renaming a branch with an upstream clears it (3.9) and says so in a toast, so Push
reads Publish.

**Delete** runs `branch -d`. When git refuses an unmerged branch, a confirm says how many of its
commits are on no other branch, and Delete anyway runs `branch -D`. **Clean up** confirms with
the branches listed, noting that a squash-merged branch looks unmerged, and deletes each with
`branch -D`. After either, a toast offers **Restore** for about 12 seconds, recreating each
branch at the tip it had.

Switching never stashes: when git refuses because of uncommitted changes, its output shows
instead. A failed branch operation shows git's output above the lists in Branches, or under the
commit box when it came from the switcher in Changes, where the next successful branch or remote
operation clears it.

Insert name sends the name, as typed, to the tab's most recently focused terminal.

**Worktrees.** Every worktree of the repo (3.9), the main worktree first, then the rest by folder
name, with the pane's own worktree marked as current. The field filters them by folder name or
branch too. Each row shows the folder name (the path on hover), the branch or the short hash
when detached, ahead and behind counts against the primary branch such as "3 ahead, 12 behind"
(omitted when both are zero), and a badge: **Merged**, **Probably merged**, **Locked**, or
**Prunable** (folder missing), in that priority; the main worktree never shows Merged. Hover
shows the Open menu (4.6) and Delete; a prunable row has no Open menu, the main worktree has no
Delete, and a locked one's is disabled with the lock reason. A right-click offers the Open
entries, Open in File Explorer, Copy path, and Delete.

Clicking a row, or Enter on it, expands it in place (again, or another row, collapses it) and
loads `git_worktree_detail`:

- **Head.** The newest commit's subject, short hash, and relative time.
- **Against primary.** The ahead and behind counts with the comparison ref, and the merged
  state in words: "Merged: every commit is in `origin/main`", "Probably merged:
  `origin/feature-x` was deleted on the remote", or "Not merged".
- **Upstream.** Its name with ahead and behind, "No upstream", or "Upstream deleted on the
  remote".
- **Working tree.** "Clean", or the counts of staged, changed, and untracked files.

A compare button at the right of the group's header names the primary branch ("Compare with
main (auto)") and opens a menu of "Automatic" (with the branch it resolves to) and the repo's
local branches, checking the current choice. Picking one writes `primaryBranch` for the repo,
keyed by its main worktree, in `repos.json` (section 7); Automatic clears it. Every Git pane's
list reloads once the file is written, and when `repos.json` changes on disk.

Delete, or the Delete key on a row, expands the row and first checks that no pane in the app (a
terminal's working directory, or another kind's folder) and no external Claude session is inside
the worktree, since a shell's working directory holds the folder open on Windows; if one is, it
shows the panes' names in the detail instead of a dialog. Otherwise it asks in a confirm dialog
naming the folder and branch, with a checkbox "Also delete branch `<name>`". The checkbox is
checked and enabled only when the state is Merged; for Probably merged it is disabled with the
note "Squash-merged branches need `git branch -D` in a terminal", since the app never runs `-D`.
For a prunable worktree the dialog adds that the folder is missing and that Delete runs
`git worktree prune`. Refusals from `git_worktree_remove` and git's own output show in the
detail.

The list is read only while the Branches tab shows, since its counts cost a `rev-list` per
worktree: on every refresh of the pane, on `git://changed` with the `metadata` flag for any of
the repo's worktree roots, and after a fetch of any of them.

The pane refreshes on `git://changed`, when it comes on screen, and when the window regains
focus; each refresh rereads the branches too. A folder that is not a git repo shows a notice
instead.

## 4.27 New worktree flow (`src/worktreeNewModel.ts`, `src/worktreeNewFlow.ts`, `src/worktreeTrustDialog.ts`, `src/worktreeNewDialog.ts`)

Two entry points reach one flow: `worktree://created` from `bb worktree new` (3.27), and the command
palette's **New worktree...**, which opens a dialog. The dialog has a branch field, a line under it
showing the plan (`worktree_plan`, so a bad or taken name shows before Create), and an optional agent
and prompt; Create calls `worktree_create`. The prompt is available only with an agent.

With the created worktree, the flow:

1. When `setup` is `needsApproval`, asks first in a dialog that offers **Show script** (the text from
   `worktree_setup_script`), **Run setup**, and **Don't run**, with focus on **Don't run** so a
   stray Enter never approves. Escape and a click outside also decline. **Run setup** calls
   `worktree_trust_setup`, which stores the script for the repo (3.27); the approval holds until the
   script's text changes. Declining skips setup, and the agent with it, since setup did not
   succeed, and a toast says so. A second worktree's question waits for the first dialog.
2. Opens a terminal pane in the new folder as a split beside the calling pane (the focused pane, for
   the dialog). Whenever it types a command on Windows (setup, or an agent with its prompt), the pane
   uses the Git Bash profile whatever the default profile is, because the command is bash syntax and
   bash quoting; with nothing to type, it uses the default profile.
3. Types one line into the pane, built by `setupCommand` in `worktreeNewModel.ts`. With setup:
   `BB_ROOT_PATH='...' BB_WORKTREE_PATH='...' BB_WORKTREE_NAME='...' BB_WORKTREE_INDEX=3 bash -e
   .bashboard/setup.sh`, followed, when an agent was chosen, by ` && ` and the agent's launch
   command from the agent table (3.24) with the prompt as one single-quoted argument. `-e` stops the
   script at its first failing command, so a failure midway fails the whole line, and the agent
   starts only if setup exits 0. Without setup, the line is the agent command alone, or nothing.
   Paths are written with forward slashes, which Git Bash accepts, and single-quoted with an
   embedded quote closed, escaped, and reopened.

`worktreeNewModel.ts` is pure and unit-tested: the quoting, the command line, and the plan line,
which matches the one `bb` prints.
