# Bashboard: design spec

A Windows desktop terminal dashboard, built with Tauri, that opens, collapses, and arranges Git
Bash terminals over a live colony-simulation backdrop, launches them from favorite folders, and shows
every local Claude Code session at a glance. The repo and binary are `bashboard`; the window
title is "Bashboard".

## 1. Goals

- **A daily-driver terminal for Claude Code.** Every key Claude Code and bash rely on reaches
  the shell; copy, paste, resizing, colors, and box drawing behave as they do in Windows Terminal.
- **A live simulation as the backdrop.** The real simulation, not a video or shader approximation, renders
  behind transparent terminals at full frame rate. One instance fills the window behind every
  terminal.
- **A terminal dashboard.** Open, collapse, and arrange terminals in tabs. Within a tab,
  expanded terminals tile the window as Windows Terminal style panes, with the same keybindings
  as the current Windows Terminal setup; collapsed terminals keep running as cards in a side
  panel, grouped by tab, each showing whether it is idle, working, waiting on you, or done
  since you last looked.
- **Favorite folders.** One click opens a terminal in a favorite folder.
- **Picks up where it left off.** On restart the app reopens the same terminals in the same
  folders and layout, and resumes the Claude Code sessions that were running in them.
- **Session awareness.** A roster of all local Claude Code sessions (in this app and elsewhere),
  their status, and which ones need attention, also expressed as organisms in the simulation.
- **Repo companions.** What usually stays open beside Claude Code (a folder of plans, a to-do
  file, git status, a code search, a scratch pad, Docker and Podman containers) opens as panes next to the
  terminals, so a repo's working set lives in one tab and a saved layout reopens all of it.

### Non-goals

- Cross-platform support. Windows 11 with WebView2 is the only target.
- Replacing Claude Code's interface. Claude runs unmodified inside a pane.
- Shells other than Git Bash, PowerShell 7, Windows PowerShell, and Command Prompt.
- Remote or SSH sessions.
- Editing code. Panes edit plain text files and scratch pads; code opens in the preferred
  editor (3.12).
- A full git client or container manager. The Git pane covers status, staging, committing,
  diffs, and undoing the last commit; the Containers pane covers existing containers.

## 2. Architecture

```
┌────────────────────────────── WebView2 (one window) ──────────────────────────────┐
│  z0  Backdrop canvas (three.js, full window)                                      │
│  z1  Pane scrims (per pane, translucent, optional blur)                           │
│  z2  Pane grid: xterm.js terminals, transparent background                        │
│  z3  Chrome: tab strip, dashboard panel, pane borders/titles, toasts              │
└──────────────▲──────────────────────────────▲───────────────────────▲─────────────┘
               │ invoke / Channel             │ events                │ events
┌──────────────┴───────────┐   ┌──────────────┴──────────┐   ┌────────┴────────────┐
│ PtyManager               │   │ SessionRoster           │   │ HookReceiver        │
│ portable-pty (ConPTY)    │   │ watches ~/.claude/      │   │ 127.0.0.1 HTTP,     │
│ one pty per pane         │   │ sessions/*.json         │   │ token-checked       │
└──────────────────────────┘   └─────────────────────────┘   └─────────────────────┘
                                 Rust (Tauri core process)
```

The Rust core owns everything that touches the OS: ptys, the clipboard, file watching, the
hook endpoint, process inspection, repo files, git, containers, and code search. The front end owns layout, rendering, and input
mapping. They talk through Tauri commands (request/response) and Tauri channels and events
(streams).

### Stack

| Layer | Choice |
| --- | --- |
| Shell | Tauri 2 on WebView2 (Chromium) |
| Pty | `portable-pty` (ConPTY) |
| Clipboard | `arboard` (text only) |
| File watching | `notify` |
| Process inspection | `sysinfo` |
| Hook endpoint | `tiny_http` on a background thread |
| Terminal | `@xterm/xterm` 6 with fit, WebGL, Unicode 11, and search addons |
| Backdrop | Colony simulation and renderer (three.js) in `src/backdrop/` (section 6) |
| Front end | TypeScript, Vite, no framework |
| Markdown | `markdown-it`, sanitized with `DOMPurify` |
| Code search | `ignore`, `grep-searcher`, and `grep-regex` (ripgrep's libraries) |
| Git, containers | The `git`, `docker`, and `podman` command-line tools, run as child processes |
| Pane CLI | `bb.exe`, a second binary in the Tauri crate, installed beside the app (3.13) |
| Updates | `tauri-plugin-updater` against GitHub releases (3.16) |
| Font list | DirectWrite through the `windows` crate (3.17) |

The chrome is a pane tree, the dashboard panel, and a few overlays, so plain TypeScript with
one class per file is enough to start. If the dashboard panel grows into real UI (richer drag
and drop, filtering, editing favorites in place), React with shadcn/ui can be introduced for
the chrome alone without touching terminals or the backdrop.

## 3. Rust core

### 3.1 PtyManager (`src-tauri/src/pty.rs`)

One pty per terminal, keyed by an id the core assigns and never reuses (a page reload restarts
the front end while older ptys may still be exiting). The pty id is what `BASHBOARD_PANE_ID`
holds and what sessions bind to (3.4); the front end gives each pane its own id (4.11) and maps
a terminal's pane id to its pty id.

| Command | Purpose |
| --- | --- |
| `pty_spawn(cols, rows, cwd?, profile?, command?, onData, onExit) -> { id, profile }` | Start a shell; `profile` is the id actually started. `command`, an argument list, runs in place of the profile's interactive shell (container shells, 4.16) |
| `shell_profiles() -> ShellProfile[]` | The shells that can be started (section 7) |
| `pty_write(id, data)` | Keystrokes and pastes |
| `pty_resize(id, cols, rows)` | After a fit |
| `pty_kill(id)` | Close a terminal |
| `pty_list() -> [{ id, pid, startedAt }]` | Reconcile after a reload |

Behavior:

- **Profiles.** A terminal runs one of four shells, each with an id:

  | Id | Name | Program | Offered |
  | --- | --- | --- | --- |
  | `gitBash` | Git Bash | `shell.path` with `shell.args` | When `shell.path` exists. When `shell.path` is the default path, also when bash.exe is found in a per-user Git install (`%LOCALAPPDATA%\Programs\Git\bin\bash.exe`) or at `<git root>\bin\bash.exe` for a `git.exe` on `PATH` under `cmd` or `bin` |
  | `pwsh` | PowerShell 7 | `pwsh.exe -NoLogo` | Only when `pwsh.exe` is found on `PATH` or at `%ProgramFiles%\PowerShell\7\pwsh.exe`; searched once per run |
  | `powershell` | Windows PowerShell | `%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe -NoLogo` | Only when that file exists |
  | `cmd` | Command Prompt | `%ComSpec%`, else `C:\Windows\System32\cmd.exe` | Always |

  A customized `shell.path` that is missing makes Git Bash unavailable.

  `pty_spawn` starts the requested profile if it is available, else `shell.defaultProfile` if
  that is available, else the first available profile in the order Git Bash, PowerShell 7,
  Windows PowerShell, Command Prompt, and returns the id it started so the front end records what
  actually runs. When that differs from the profile asked for (the requested one, else the
  default), it also returns `fallbackFrom`, and the front end shows a notice once per session for
  each missing shell.
- **Command Prompt environment.** cmd has no hook that runs before each prompt, so its spawn
  environment sets `PROMPT` to `$e]9;9;$P$e\` followed by the inherited `PROMPT` (or `$P$G` when
  there is none). The prompt itself then reports the working directory as OSC 9;9. cmd emits no
  OSC 133, so its status comes from the activity sweep (below).
  PowerShell reports nothing by default; the profile snippet in setup.md adds OSC 9;9 only. The
  front end ignores the sweep once a pane emits any OSC 133 marker (4.8), and PowerShell has no
  reliable hook for the command-started marker, so its status also comes from the sweep.
- **Output** streams over a per-pane `Channel` as raw bytes (`InvokeResponseBody::Raw`), which
  arrive in JS as an `ArrayBuffer` and go straight to `term.write(Uint8Array)`. xterm.js
  handles UTF-8 sequences split across chunks.
- **Coalescing.** The reader thread reads up to 16 KB at a time. If profiling shows IPC
  overhead during heavy redraws, add a 4 ms coalescing window before sending; until then, send
  each read immediately for the lowest latency.
- **Exit detection.** ConPTY keeps the reader blocked after the shell exits until the master is
  dropped, so a waiter thread blocks on `child.wait()`, removes the pane (dropping the master),
  and sends the exit code on `onExit`.
- **Environment.** Each shell gets `TERM=xterm-256color`, `COLORTERM=truecolor`,
  `TERM_PROGRAM=bashboard`, `BASHBOARD_PANE_ID=<id>`, and the hook endpoint variables (3.3),
  and `PATH` given to the shell starts with the folder holding `bb.exe` (3.13). The
  per-session markers Claude Code sets in its own environment (`CLAUDECODE`,
  `CLAUDE_CODE_CHILD_SESSION`, `CLAUDE_CODE_SESSION_ID`, and the rest of that list) are removed,
  so `claude` in a pane never mistakes itself for a child session when the app was launched
  from one.
- **Shell activity.** A 2 second sweep (via `sysinfo`) emits `pty://activity` with a
  `{ id, busy }` entry for every live pty, whenever the list differs from the last emission. A
  pty is busy when its shell has a foreground job. Git's launcher `bash.exe` spawns the real
  shell as its only child, so the sweep looks through any chain of `bash.exe` processes and
  judges the deepest one. MSYS can also leave a foreground job such as `sleep` parented to a
  fork stub that has already exited, which puts the job outside the shell's process tree; a
  process started since the pty began, whose parent is gone, and that shares the pane's console
  host counts as busy too, unless it is itself a `bash.exe`, which is judged like the pane's
  shell (so an idle nested shell is idle). The sweep cannot tell a background job from a
  foreground one, so a job left running with `&` keeps the pane busy until it exits. The
  front end uses the verdicts for working and idle when a shell emits no OSC 133 markers
  (4.8).
- **Orphans.** On front-end load, `pty_list` returns ptys from before a reload. In development
  they are killed; in release builds a reload does not happen in normal use.

### 3.2 SessionRoster (`src-tauri/src/roster.rs`)

Claude Code writes one JSON file per running session to `~/.claude/sessions/<pid>.json`:

```json
{
  "pid": 278404,
  "sessionId": "86940a84-...",
  "cwd": "C:\\Users\\me\\repos\\app",
  "startedAt": 1792939849277,
  "procStart": "134374134486766877",
  "version": "2.1.310",
  "kind": "interactive",
  "entrypoint": "cli",
  "name": "app",
  "updatedAt": 1792952749589,
  "status": "busy",
  "statusUpdatedAt": 1792952749589
}
```

This format is internal to Claude Code and undocumented, so the roster treats it defensively:

- Parse with every field optional (`#[serde(default)]`); a file that fails to parse is skipped
  and logged, never fatal.
- `status` maps to `busy`, `idle`, or `unknown`. Unknown values pass through as `unknown`
  with the raw string kept for display.
- **Liveness.** A session counts as live only if its `pid` exists and the process start time
  matches `procStart` (a Windows FILETIME), which guards against pid reuse after a crash left a
  stale file behind.
- **Watching.** `notify` watches the directory; changes are debounced 100 ms. A 10 second
  sweep re-checks liveness, since a killed process may never delete its file.
- **Events.** The roster emits `sessions://changed` with the full list whenever anything
  differs. The list is small (tens of entries), so diffs are not worth the complexity.

Never read or forward `messagingSocketPath`, messaging tokens, or bridge ids; the roster model
(section 7) has no fields for them.

### 3.3 HookReceiver (`src-tauri/src/hooks.rs`)

The roster says whether a session is busy; hooks add what it cannot: "waiting for you" and
exact transitions as they happen.

- On startup the core binds `127.0.0.1:0` (an OS-assigned port) and generates a random
  128-bit token. Every pane's environment gets `BASHBOARD_HOOK_URL` and `BASHBOARD_HOOK_TOKEN`.
- The app ships `hooks/bashboard-hook.sh`, installed to `~/.claude/hooks/`:

  ```sh
  #!/usr/bin/env bash
  # Forwards a Claude Code hook event to Bashboard. Silent no-op outside a Bashboard pane.
  [ -n "$BASHBOARD_HOOK_URL" ] || exit 0
  curl -s -m 1 -X POST \
    -H "X-Bashboard-Token: $BASHBOARD_HOOK_TOKEN" \
    -H "X-Bashboard-Pane: $BASHBOARD_PANE_ID" \
    --data-binary @- "$BASHBOARD_HOOK_URL/hook" >/dev/null 2>&1 || true
  exit 0
  ```

  Because the variables exist only inside this app's panes, the same global hook config does
  nothing for sessions in Windows Terminal or VS Code.
- Hook registration in `~/.claude/settings.json`, merged next to the existing `Notification`
  hooks (the toast and bell stay):

  | Event | Meaning in the app |
  | --- | --- |
  | `SessionStart` | Session bound to its pane |
  | `UserPromptSubmit` | `busy` |
  | `Notification` | `waiting` when its `notification_type` needs input (a permission prompt, an elicitation dialog, or an agent needing input; or no type, from older Claude Code); other notices, including the idle prompt, change nothing; carries `message` |
  | `Stop` | `idle`, shown as `done` until the pane is looked at (4.8) |
  | `SessionEnd` | Session unbound from its pane |

  Each event gets one group appended, and the registered command is exactly:

  ```json
  { "hooks": [ { "type": "command", "command": "bash ~/.claude/hooks/bashboard-hook.sh", "timeout": 5 } ] }
  ```

  An event that already holds a hook whose command contains `bashboard-hook.sh` is skipped, and
  existing groups are never altered. The install checks that `bash.exe` is on `PATH`, since the
  registered command runs through bash.

  Installing hooks requires bash, which comes with Git for Windows; without it the install is
  refused with an explanation. The dashboard panel has an "Install Claude Code hooks" button, shown while Claude Code is
  detected (`~/.claude` exists, checked at startup) and the hooks are not fully installed. It shows the exact JSON it will merge and writes it only after
  confirmation; it never edits `settings.json` silently. The install writes the script to
  `~/.claude/hooks/bashboard-hook.sh` (home is `USERPROFILE`, else `HOME`), then re-reads
  `settings.json` and merges the groups, through a temporary file and a rename. A missing
  `settings.json` is created. A `settings.json` that is not plain JSON (comments, trailing
  commas) is refused with an error naming the file, and nothing is written.
- The receiver accepts `POST /hook` and `POST /cli` (3.13). For `/hook` it answers with these
  codes, checked in this order:
  404 for any other path or method, 403 for a missing or wrong `X-Bashboard-Token`, 413 for a
  body over 64 KiB, 400 for a body that is not JSON or has no string `session_id`, and 204 on
  success. The receiver keeps only `session_id`, `hook_event_name`, `cwd`, `message`, and
  `transcript_path`, and emits `sessions://hook` with the first four plus the pane id from the
  header and the receive time. `transcript_path` is not forwarded; the overlay entry keeps the
  latest one an event carried, for the transcript reads behind the Panes cards' Claude line (3.4).
- The hook overlay keeps the `message` of the `Notification` that set `waiting`, trimmed and cut
  at 200 characters, and clears it whenever the overlay's status leaves `waiting`. Held in the
  core, it survives a page reload and covers external sessions. The roster payload carries it as
  `waitingReason` (section 7).

### 3.4 Pane to session binding

A session is bound to a pane by, in order:

1. The `X-Bashboard-Pane` header on its hook events.
2. Process ancestry: walking parents from the session's `pid` (via `sysinfo`) until reaching a
   pane's shell pid, for sessions started before hooks were installed.

Sessions that bind to no pane are external (Windows Terminal, VS Code) and appear in the
roster without a pane link.

**Transcripts.** Each pane-bound session's Panes card (4.6) shows its model and context, which `transcript.rs` reads from the session's transcript, the JSONL file
Claude Code appends to under `~/.claude/projects/`. The format is internal and undocumented, so
every field is optional and an unreadable line is skipped. The file is the hook overlay's
`transcript_path` when there is one; for a session bound by ancestry, which sends no hooks, it is
the first `~/.claude/projects/*/<sessionId>.jsonl`, searched again at most every 5 seconds until
found. The reading is the newest line of `type` `assistant` that is not `isSidechain` and carries
`message.usage` (a `<synthetic>` model is skipped): context is `input_tokens +
cache_creation_input_tokens + cache_read_input_tokens`, and the model is `message.model`. The
core reads only the file's last 64 KiB, widening to the whole file, streamed line by line, when
the tail holds no such line. A `notify` change marks the session dirty, and a dirty session is
re-read at most once per second. A changed model or context emits `claude://context` (section 7),
and `claude_context()` returns every known entry so a page reload shows them at once. Nothing is
tracked until the dashboard first calls `claude_context()`, which it does while the Panes section
is enabled, and `claude_context_stop()` when it is turned off; entries are pruned with the hook
overlay.

### 3.5 Platform glue

- **Browser accelerators.** WebView2's `AreBrowserAcceleratorKeysEnabled` is set to false at
  window creation (`lib.rs`), so Ctrl+F, Ctrl+R, Ctrl+P, F5, and zoom keys reach the page.
  Verified in the keyboard test.
- **Clipboard.** `clipboard_read_text` reads through `arboard` because WebView2 puts
  `navigator.clipboard.readText` behind a permission prompt. Writes use
  `navigator.clipboard.writeText`, which needs no prompt.
- **Links.** `open_url` (`src-tauri/src/links.rs`) opens a URL in the system browser through
  `tauri-plugin-opener`, called from Rust. It accepts only `http` and `https` and returns an
  error for anything else. The page gets no opener permission, so it cannot launch other
  programs or schemes directly.
- **Attention.** `window.request_user_attention` flashes the taskbar button when a session in
  an unfocused window starts waiting.

### 3.6 Settings (`src-tauri/src/settings.rs`)

Stored at `%APPDATA%\dev.bashboard\settings.json`, watched and hot-reloaded. Schema in
section 8. Debug builds use the `dev` subfolder for this file and for workspace.json,
favorites.json, and layouts.json (`config_dir.rs`), seeding settings.json from the installed app's
copy on first run.

The app never rewrites the file whole. `settings_set(path, value)` changes one value in place
(`src-tauri/src/settings_edit.rs`), adding the key and any missing parent objects, and keeps
comments and formatting everywhere else; the write goes to a temp file renamed into place. The
watcher then reloads it like a hand edit, so changes reach the front end through
`settings://changed` either way. A file that is not valid JSONC is left alone and the change
fails.

### 3.7 Workspace and favorites (`src-tauri/src/workspace.rs`)

Four app-owned files next to `settings.json`, each read and written whole through a pair of
commands, with writes going to a temp file and renamed into place so a crash never leaves half
a file:

| File | Commands | Contents |
| --- | --- | --- |
| `workspace.json` | `workspace_load`, `workspace_save` | Open tabs, their panes, and layouts (section 7), for restore (4.9); dashboard state and pane text zoom |
| `favorites.json` | `favorites_load`, `favorites_save` | Favorite folders (4.6) |
| `layouts.json` | `layouts_load`, `layouts_save` | Named layouts (4.6) |
| `repos.json` | `repos_load`, `repos_save` | Pinned files and folders per repo (4.12), and the branch worktrees are compared with (4.6) |

The core treats all four as opaque JSON, except that the worktree commands (3.9) read each repo's
`primaryBranch` from `repos.json`; the front end owns their shape and validation.
`favorites.json`, `layouts.json`, and `repos.json` are hand-editable, so they are watched and
hot-reloaded like `settings.json`, emitting `favorites://changed`, `layouts://changed`, and
`repos://changed`. They are kept out of `settings.json` because the app rewrites them from the
dashboard, and rewriting a hand-edited JSONC file would drop its comments.

Scratch pads (4.15) live beside them as `scratch/<id>.txt`, written by `scratch_save(id, text)`
and removed by `scratch_delete(id)`; `scratch_load(id)` reads one back on restore.

### 3.8 Repo files (`src-tauri/src/files.rs`)

A path's repo is the nearest folder at or above it holding `.git` (a directory, or the file a
worktree has); a folder in no repo is its own repo, without git. A linked worktree is its
own repo root here, so each worktree of one repository has its own `repo_root`; the Repo
section lists them together through the worktree commands in 3.9.

| Command | Purpose |
| --- | --- |
| `repo_root(path) -> { root, isGit, branch? }` | The repo a folder belongs to |
| `fs_list(dir) -> Entry[]` | Folders, then files, each with name, size, and modified time |
| `fs_read_text(path) -> { text, modified, lossy }` | Up to 2 MiB; a file with a NUL byte in its first 8 KiB is refused as binary. Invalid UTF-8 decodes with U+FFFD in place of the bad bytes and sets `lossy` |
| `fs_write_text(path, text, expectedModified)` | Writes through a temp file and a rename; refused when the file's modified time differs from `expectedModified`, so a save never overwrites a change made on disk since the read, and refused when the file on disk is not valid UTF-8 |
| `fs_move(path, toDir)` | Moves a file into another folder; refused when the target name exists |
| `fs_watch(dir, onChange) -> id`, `fs_unwatch(id)` | One folder, not recursive, debounced 200 ms |

Paths must be absolute and are normalized before use, so `..` segments cannot step outside the
folder they name. `fs_write_text` and `fs_move` work on any existing file, and nothing creates or
deletes files except the scratch commands above.

### 3.9 Git (`src-tauri/src/git.rs`, `src-tauri/src/git_fetch.rs`, `src-tauri/src/git_worktrees.rs`)

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
an error), and false when only worktree files changed. The Repo section holds its own reference
to this watcher, on the repo's main worktree, while it shows a worktree list (4.6), so
`git://changed` reaches the list whether or not a Git pane is open.

### 3.10 Containers (`src-tauri/src/containers.rs`)

Two engines, each through its own CLI: `docker` (Docker Desktop) and `podman` (Podman, with
its machine on Windows). At startup each CLI (`docker.exe`, `podman.exe`) is searched for on
`PATH`, and its `version --format json` probe decides whether that engine is running. An engine
whose CLI is missing is left out everywhere, and with neither, nothing in the app mentions
containers, except that a Containers pane restored from a saved workspace or layout says "No
container engine found." An engine whose CLI is found but is not running is still listed, as not running. Both CLIs take the same commands, but their `--format json` output
differs (Podman prints one array with `Names` and `Labels` as structures, Docker one object per
line with strings), so each engine has its own parser into the shared `Container` shape
(section 7).

| Command | Runs, on the container's engine |
| --- | --- |
| `containers_list() -> ContainersSnapshot` | `ps -a --format json` on every running engine: the engines with their running state, plus each container's engine, id, name, image, state, status text, published ports, and the Compose project and service labels. An engine whose `ps` fails is reported as not running |
| `containers_action(engine, ids, action)` | `start`, `stop`, or `restart`; ids follow `--` |
| `containers_logs(engine, id, onData) -> streamId`, `containers_logs_stop(streamId)` | `logs -f --tail 500`, stdout and stderr streamed over a `Channel` as raw bytes |
| `containers_stats(engine, ids) -> ContainerStats[]` | `stats --no-stream --format json`: CPU and memory |

`containers://changed` carries the same `ContainersSnapshot` as `containers_list`, so the front
end learns which engines exist and run from the same message as the list. Every CLI runs with an
argument list and no console window.

The Compose project comes from `com.docker.compose.project`, else `io.podman.compose.project`
(podman-compose), and the service likewise.

For each running engine, an `events --filter type=container --format json` child triggers
`containers://changed` with a fresh snapshot, debounced 300 ms. Events for exec, attach, and
resize, which leave the list as it was, do not trigger one. When the events child exits, or the
engine is not running, the core marks that engine not running, emits a snapshot, and probes it
again every 10 seconds; on recovery it restarts the events child and emits. The logs and events
children are killed when the app exits.

Container shells open through `pty_spawn` with the command
`<engine>.exe exec -it <id> sh -c "command -v bash >/dev/null && exec bash || exec sh"`.

### 3.11 Code search (`src-tauri/src/search.rs`)

`search_start(root, query, options, onBatch) -> id` searches a repo on a background thread and
streams results over a `Channel`; `search_cancel(id)` stops it, and a new search from the same
pane cancels the previous one.

- The walk uses `ignore`, so `.gitignore`, `.ignore`, and global git excludes apply, and hidden
  files and `.git` are skipped. Files over 2 MiB and binary files are skipped.
- The query is literal unless `regex` is set; `caseSensitive`, `wholeWord`, and an `include`
  glob narrow it (section 7).
- Paths whose file name contains the query arrive first, as one batch. Line matches follow,
  batched per file with line numbers and match offsets.
- A search stops at 5,000 matches and reports that it was truncated.

### 3.12 Editors (`src-tauri/src/editors.rs`)

`editors() -> { id, name }[]` lists the editors found on `PATH` or in their usual install folders;
`name` is the display name from the table below. The front end labels a saved
`editor.preferred` that is not in the list by its raw id.
`open_in_editor(path, line?)` opens a file or folder in `editor.preferred` (section 8):

| Id | Editor | Arguments |
| --- | --- | --- |
| `zed` | Zed | `zed <path>:<line>` |
| `vscode` | VS Code | `code -g <path>:<line>` |
| `cursor` | Cursor | `cursor -g <path>:<line>` |
| `visualStudio` | Visual Studio | `devenv /edit <path>` (no line) |
| `notepadpp` | Notepad++ | `notepad++ -n<line> <path>` |
| `sublime` | Sublime Text | `subl <path>:<line>` |
| `rider` | Rider | `rider64 --line <line> <path>` |
| `intellij` | IntelliJ IDEA | `idea64 --line <line> <path>` |
| `webstorm` | WebStorm | `webstorm64 --line <line> <path>` |
| `pycharm` | PyCharm | `pycharm64 --line <line> <path>` |
| `rustrover` | RustRover | `rustrover64 --line <line> <path>` |
| `goland` | GoLand | `goland64 --line <line> <path>` |
| `clion` | CLion | `clion64 --line <line> <path>` |
| `phpstorm` | PhpStorm | `phpstorm64 --line <line> <path>` |
| `windsurf` | Windsurf | `windsurf -g <path>:<line>` |
| `vscodeInsiders` | VS Code Insiders | `code-insiders -g <path>:<line>` |
| `vscodium` | VSCodium | `codium -g <path>:<line>` |
| `default` | The file's default app | Opened through the shell (no line) |

With no line, each editor above except Visual Studio and the default app takes the path alone.

Windsurf, VS Code Insiders, and VSCodium, like VS Code, put only a `.cmd` shim on `PATH`
(`windsurf.cmd`, `code-insiders.cmd`, `codium.cmd`), which is traded for the exe one folder up.
Their install folders are `%LOCALAPPDATA%\Programs\Windsurf`; `%LOCALAPPDATA%\Programs\Microsoft
VS Code Insiders` then `%ProgramFiles%\Microsoft VS Code Insiders`; and
`%LOCALAPPDATA%\Programs\VSCodium` then `%ProgramFiles%\VSCodium`.

The JetBrains launchers hand the file to a running instance of the same IDE and exit, and a
folder opens as a project. Each IDE is found in three steps, first match wins: its launcher exe
(`rider64.exe`, `idea64.exe`, and so on) on `PATH`; a Toolbox App script on `PATH` (`rider.cmd`,
`idea.cmd`, and so on), read for the exe path it names and never run, since running it would go
through `cmd.exe` (section 9); then `*\bin\<exe>` under `%LOCALAPPDATA%\Programs` and
`%ProgramFiles%\JetBrains`, taking the highest `version` in the install's `product-info.json`
(compared segment by segment as numbers, an install without a version ranking last). Installs
are matched by exe name, never by folder name, and the free and paid editions of IntelliJ IDEA
and PyCharm share exe names, so either counts.

Terminal editors are not in the table. Emacs is reachable through `editor.command`
(`emacsclientw -n +{line} {path}`).

A non-empty `editor.command` replaces the table: it is split into arguments, with `{path}` and
`{line}` filled in (an absent line fills `1`). When the preferred editor is not found, the file
opens in its default app and a toast says so.

### 3.13 Pane CLI (`bb`)

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
| `bb help` | Lists the commands |

New panes open as a split of the calling pane, as a favorite does (4.6), in the calling pane's
tab, and focus moves to them. `--collapsed` opens a pane collapsed instead.

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
  Bashboard pane and exits 1.
- The core emits `cli://command` with the pane id and the resolved request; the front end's
  `Workspace` carries it out exactly as the matching dashboard or keyboard action would, so `bb`
  can do nothing the UI cannot.

### 3.14 Shell integration install (`src-tauri/src/shell_integration.rs`)

Working-directory reporting (OSC 9;9) and the command-start and command-end markers (OSC 133)
come from a few lines in Git Bash's `~/.bashrc`. The setup wizard (4.17) installs them with
`shell_integration_preview` and `shell_integration_install`. The lines are the snippet in
setup.md's "New panes in the current folder" section; a test requires the two to match byte for
byte, ignoring line endings.

The install writes the snippet between two marker lines at the end of the file:
`# >>> bashboard shell integration >>>` and `# <<< bashboard shell integration <<<`. The home
directory is `HOME`, then `USERPROFILE`, as Git Bash resolves it. `shell_integration_preview`
returns the `.bashrc` path, the status, the block to add, whether `.bashrc` or `.bash_profile`
would be created, and a warning about `.bash_profile`.

| Status | Meaning | Install does |
| --- | --- | --- |
| `missing` | No `.bashrc`, or no Bashboard lines in it | Appends the block, after a blank line |
| `installed` | A marked block equal to the current snippet | Nothing |
| `outdated` | A marked block that differs from the current snippet | Replaces the block in place |
| `handAdded` | The snippet appears verbatim, without markers | Replaces those lines with the marked block, in place |
| `custom` | A begin marker with no end marker, or a `__bashboard_prompt` function that is not the snippet | Refuses; the user updates the lines by hand |

- **Backup.** An existing `.bashrc` is copied to `~/.bashrc.bashboard-backup` before it is
  rewritten. The write is atomic (the helper the hook install uses, 3.3).
- **Line endings.** The file's own line endings are kept, and lines outside the block are
  rewritten byte for byte. A `.bashrc` that is not UTF-8 is left alone with an error.
- **Login shells.** Git Bash's login shell reads `~/.bash_profile`, not `~/.bashrc`. When that
  file is missing, the install creates it with the two standard lines that source `~/.profile`
  and `~/.bashrc`. When it exists and never mentions `.bashrc`, the preview carries a warning
  and the file is left untouched.
- Panes already open do not pick the lines up until their shell reads `~/.bashrc` again
  (`source ~/.bashrc`).

### 3.15 Git install (`src-tauri/src/git_install.rs`)

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

### 3.16 Updates and releases

Installed apps update themselves through Tauri's updater plugin. `plugins.updater` in
`tauri.conf.json` holds the public signing key and one endpoint,
`https://github.com/BradleyKH/bashboard/releases/latest/download/latest.json`, which resolves to
the newest non-prerelease release. The Windows install mode is `passive`: the NSIS installer
shows its progress without prompts.

`src/updater.ts` exports `checkForUpdate({ manual, confirm })`. It runs once at launch after the
workspace is up, quietly, and again from the settings dialog's Check for updates button or the
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
release named "Bashboard v<version> (alpha)", not marked as a prerelease, with the NSIS
installer, its `.sig`, and `latest.json`. The release body, which also becomes the `notes` in
`latest.json`, is the annotated tag's message (if any) followed by the standard alpha
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

### 3.17 Fonts (`src-tauri/src/fonts.rs`)

`fonts() -> { family, monospace }[]` lists the installed font families for the settings dialog's
Font family suggestions (4.6). It is an `async` command, so the enumeration runs off the main
thread. It reads DirectWrite's system font collection through the `windows` crate, which
includes fonts installed for the current user only. A family's name is its `en-us` localized
name, or its first name when it has no `en-us` one; a family whose name cannot be read is
skipped. `monospace` is `IDWriteFont1::IsMonospacedFont` on the family's first font, false when
that call fails. The list is sorted with monospace families first, then by name ignoring case,
and a name repeated ignoring case is dropped, so a family read both as monospace and not keeps
its monospace entry. The collection is read on every call, with DirectWrite asked to check for
updates, so a font installed while the app runs shows up on the next call. If DirectWrite fails
the list is empty. On other platforms the list is always empty.

### 3.18 Single instance (`src-tauri/src/second_instance.rs`)

Release builds register `tauri-plugin-single-instance` before every other plugin. A second
launch finds the running app through a named mutex keyed on the app identifier, hands it its
working directory, and exits. The running app unminimizes, shows, and focuses the main window,
then emits `instance://launched` with the folder for a new tab, or `null` when the working
directory is empty, missing, the exe's own folder (where Start menu and taskbar shortcuts start),
or the Windows folder or below. On a folder, the front end opens a new tab there (4.10). Debug
builds skip the plugin, since they share the identifier and a dev run starts beside the
installed app; their saved state is already separate (3.6).

## 4. Front end

### 4.1 Layers

`index.html` stacks four fixed layers (section 2). The backdrop owns z0 and receives no pointer events;
it never reacts to clicks, drags, or scrolls meant for terminals. Terminals draw with a fully
transparent background (`allowTransparency`, theme background `#00000000`, and an override
of xterm.css's black viewport), so whatever is under them shows through.

There is one backdrop instance for the whole window. Terminals and tabs never get their own copy:
expanded terminals sit over it, collapsed ones and those in background tabs cost it nothing,
and creating or switching tabs neither resets nor interrupts it.

### 4.2 Pane layout

Each tab (4.10) arranges its expanded panes by its own binary split tree, which is empty when
every pane in the tab is collapsed (4.3). Only the active tab's tree is on screen. A leaf holds
a pane of any kind (4.11); this section says "terminal" where only terminals apply.

```ts
type Layout =
  | { kind: 'pane'; paneId: string }
  | { kind: 'split'; dir: 'row' | 'column'; ratio: number; a: Layout; b: Layout };
```

- Rendered as nested flex containers with a 4 px divider that can be dragged; ratios clamp so
  no pane drops below 20 columns by 5 rows.
- **Splitting** replaces the focused leaf with a split whose first child is the original pane.
  "Auto" picks `row` when the pane is wider than it is tall (in pixels), as Windows Terminal
  does.
- **Closing** closes the pane (killing a terminal's shell) and replaces the parent split with
  the surviving sibling. Closing a tab's last pane, expanded or collapsed, closes the tab, and
  closing the last tab closes the window. When every pane in the active tab is collapsed, the backdrop
  fills the window.
- **Docking.** Dragging a pane's title strip or a dashboard card over a pane shows five drop
  targets: each edge splits that pane in that direction with the dragged pane on that side,
  and the center swaps the two. A pane dragged from elsewhere in the tree leaves its old spot
  first, the same way closing does but without closing it. A collapsed card dropped on
  a center takes the target's place and collapses the target. A card from another tab docks the
  same way and moves its pane into the active tab; a tab left with no panes closes.
  Dragging a favorite or recent
  folder (4.6) shows the four edge targets only, since a folder has nothing to swap with; the
  drop opens a new terminal there.
- **Window-edge docking.** While anything dockable is dragged and the tab has at least one
  expanded pane, a 24 px band along each edge of the pane area is a fifth kind of target, drawn
  over the pane targets beneath it. Dropping there splits the root of the tree, so the dragged
  pane runs the full length of that edge and takes a third of the area, or more when a third
  would be under the minimum size. Drags use pointer events and begin after the pointer moves
  4 px, so a plain click still clicks and a finished drag does not also click its source. A drop
  that would leave a pane below the minimum size is refused with a toast.
- **Focus** follows click and the move-focus keys; the focused pane has a 1 px accent border
  and the others dim their cursor. Each tab remembers its own focused pane, and moving focus or
  resizing never leaves the active tab.
- **Zoom** (Ctrl+Shift+Z, or the title strip's zoom button) fills the tab's pane area with the
  focused pane, as Windows Terminal's pane zoom does, and the same again restores the layout.
  The tree is unchanged; the other panes leave the DOM as a background tab's do (4.10) and
  release their WebGL contexts. Zoom is per tab and is not saved. It ends before anything that
  changes the tab's tree (split, close, collapse, dock, expand, opening a pane into the tab) and
  before moving focus, which then moves as usual; resizing does nothing while zoomed. A tab with
  one expanded pane cannot zoom. While a hidden pane in the zoomed tab is marked for attention
  (4.7), the zoom button pulses.

**Duplicating the working directory.** A new pane or tab starts in the focused pane's current
directory, read from OSC 9;9 (what Windows Terminal uses) or OSC 7 sequences that xterm.js
handlers capture. Git Bash emits neither by default, so the `~/.bashrc` lines in
[setup.md](setup.md#new-panes-in-the-current-folder) (installed by 3.14) emit OSC 9;9 along with
the OSC 133 command markers terminal status uses (4.8). Without them, new panes start in the home
directory.

### 4.3 Collapsing

A terminal is one pty plus its xterm instance, and belongs to one tab. Expanded, it occupies a
leaf of its tab's layout; collapsed, it leaves the tree and appears only as a card in the
dashboard panel (4.6). Its pty keeps running and its xterm instance stays alive off the DOM, so
output keeps arriving and the scrollback is intact when it comes back. Terminals in a tab that
is not active are off the DOM in the same way, expanded or not.

- **Collapse** (Ctrl+Shift+M, or the title strip's button) removes the leaf the same way
  closing does, without killing the terminal; focus moves to the sibling.
- **Expand** (clicking the card) switches to the card's tab if it is not active, then splits
  that tab's focused pane in the auto direction with the terminal as the new side, or fills the
  window when the layout is empty. When the focused pane has no room to split, a toast says so
  and the terminal stays collapsed. Dragging the card docks it anywhere in the active tab
  instead (4.2).
- The pty keeps its last size while collapsed, and the terminal is refit when it expands.
- A collapsed terminal releases its WebGL context (4.4).

### 4.4 Terminal pane (`pane.ts`)

One `TerminalPane` per terminal: an xterm `Terminal` with fit, WebGL, Unicode 11, and search
addons, bound to one pty. Font defaults to the bundled `JetBrainsMono Nerd Font Mono` (3.16),
with `Cascadia Mono` as the fallback, 14 px.

**WebGL context budget.** Chromium allows roughly 16 live WebGL contexts per page, and the backdrop uses
one. Only expanded terminals in the active tab count: each uses the WebGL renderer until 8 are
on screen, and past that, newly shown ones use the DOM renderer. Collapsing a terminal, or
switching away from its tab, disposes the WebGL addon, freeing its context; expanding it or
switching back attaches one again if the budget allows. If the browser drops a WebGL context
(`onContextLoss`), that pane falls back to the DOM renderer instead of going blank.

**Title strip:** the kind menu (4.11), the status dot (4.8), the bound session's name or the
shell's working directory, then a collapse button, a zoom button (with two or more expanded
panes in the tab, 4.2), and a close button that acts as Ctrl+W (`requestClosePane`); the rest of
the strip is the drag handle for docking. The status dot's tooltip shows the waiting reason
(3.3) while the terminal is `waiting`; the strip's text is unchanged. Every pane kind
has the same strip, with its own title and no status dot. With two or more panes in the tab the strip
sits in the layout above each terminal. A lone pane's strip is an overlay, so it never reflows
the terminal; it is invisible until the pointer enters its own top band, so the pointer resting
elsewhere in the terminal never covers the first row.

**Title strip menu.** A right-click on a title strip of any pane kind opens Change kind (a
submenu of the kind menu's entries, 4.11), Collapse, Zoom or Restore (only while the zoom button
shows, 4.2), and, after a separator, Close pane. Each item does what its button does.

**Right-click.** A right-click in a terminal does whatever xterm.js and the running program do
with it, in every profile, and no menu opens. `main.ts` registers one `contextmenu` listener on
`window` in the capture phase, before anything else mounts, that cancels the default and never
stops propagation, so xterm.js still sees the event (it moves its hidden textarea under the
pointer, and passes the button to a program that turned on mouse reporting). The cancelled
default is WebView2's built-in menu, whose Refresh reloads the page and kills every pty as an
orphan. The app adds no terminal menu and no right-click handling of its own.

**Context menus** (`contextMenu.ts`, `contextMenuModel.ts`). Right-clicking an element the app
knows opens a menu of that element's actions; right-clicking anything else does nothing. One
module draws every menu, including the Open menu (4.6) and the kind menu (4.11), so they all look
and behave alike.

- **Content.** A menu holds items, separators, and submenus, one level deep. An item can be
  disabled, or drawn as a radio choice with a check mark. Builders append groups
  conditionally; leading, trailing, and doubled separators are dropped (in submenus too), a
  submenu with no enabled item is disabled, and a menu with nothing left opens nothing.
- **Placement.** A menu opens at the pointer, or below its button with the left or right edge
  aligned. It flips above when there is room there and none below, shifts left from the right
  edge, stays 4 px inside the window, and scrolls when taller than the window. A submenu opens to
  the right of its item, or to the left when there is no room.
- **Keys.** Up, Down, Home, and End move over enabled items, wrapping; Enter or Space chooses;
  Right opens a submenu and Left closes it; Esc closes. Opened from a button or key, the menu
  focuses its checked item or its first enabled one; opened by pointer, it focuses nothing until
  a key or hover. `keydown`, `keypress`, and `keyup` stop inside the menu, so `keys.ts` and
  xterm.js never see them.
- **Closing.** A menu closes on a choice, Esc, a press outside it, the window losing focus, or a
  switch to another tab, and returns focus to the element that had it. Only one menu is open at a
  time; opening one closes the other. A press on the button a menu opened from is left to that
  button's click, so the button toggles its menu.
- **Owners.** Each element attaches its own menu (`attachContextMenu`): the owner builds the
  items on `contextmenu`, and the innermost owner wins because it stops the event. An owner with
  nothing to offer at that spot returns no menu and lets the event bubble to an outer owner. A
  builder may be asynchronous (the Open menu's git probe); its menu opens only if no menu opened
  or closed while it waited.
- **Row outline.** A right-clicked row is outlined while its menu is open but not selected: the
  Files preview, the Git diff, and the Search preview do not change, so a menu can act on a row
  without losing the one being read.
- **Keyboard.** The Menu key and Shift+F10 fire `contextmenu` in WebView2 and open the focused
  row's menu, anchored at its bottom left. Lists that hold focus themselves (Files, Git, Search)
  use the selected row.
- **Second way in.** Every item is an action the app has elsewhere (a button, a hover menu, or
  a key), or a copy of text the element shows.

**Text fields.** Every `input` and `textarea` outside a terminal (the scratch pad, the Files
text editor, the commit message, find bars, filters, the palette, and inline renames) gets Undo,
Cut, Copy, Paste, and Select all from one listener on `document` (`textFieldMenu.ts`). Cut and
Copy are disabled with no selection (always, in a password field); Undo, Cut, and Paste are
disabled in a read-only or disabled field. Paste reads the clipboard through the core, as
Ctrl+V does. A field can add items after a separator; the scratch pad's are in 4.15. A text
field menu opened by key sits at the field's bottom left.

**Copy path** copies an absolute path with backslashes and no quotes, as File Explorer's Copy as
path does. **Insert path** goes through `pathInsertText` (Dropping paths, below) with the pane's own
root as the base, so the path is relative to the Files, Git, or Search pane it comes from, and
quoted and slashed for the target terminal as a drop is.

**Find bar** (`findBar.ts`): Ctrl+Shift+F opens one bar over the top-right corner of the
focused pane, or refocuses its input if it is already open. Matching is case-insensitive and
runs as you type, with Enter for the next match and Shift+Enter for the previous. The count
reads "n of m" or "No results". Esc closes the bar, clears the highlights, and returns focus
to the terminal. Closing the pane, collapsing it, moving focus to another pane, or switching
tabs also closes the bar.

**Dropping paths.** Dropping files onto a terminal inserts their paths as a bracketed paste
without Enter, then focuses that terminal (a collapsed target is expanded). Sources are:

- File Explorer, through Tauri's webview drag-drop events. The physical position is divided by
  `devicePixelRatio` and hit-tested with `elementFromPoint`, and the window is brought forward on
  the drop so the terminal can take keystrokes.
- Rows inside the app: Files pane rows (4.12), Staged and Changes rows in the Git pane (4.13), and
  Search pane match rows, file group headers, and file name rows (4.14). They drag with the
  `attachBodyDrag` pointer threshold, so a click still selects, and a ghost with the file name
  follows the pointer.

An expanded terminal highlights while a path is over it and takes the paste. A scratch pad (4.15)
takes the text at its caret, formatted for the terminal its Send would use (the tab's most
recently focused terminal). A tab with no terminal has none, so the text uses the default shell
profile, without the Claude Code rules; with no base root, as when a drop lands on the pad, the
paths come out absolute. Nothing else is a target; a drop elsewhere does nothing.

`pathInsertText(paths, baseRoot, profile)` in `filesRouting.ts` formats every path insertion,
including the Files pane's Insert path. A path inside `baseRoot` is relative with forward slashes,
`.` for the root itself, and otherwise absolute. Git Bash, PowerShell, and Claude Code get forward
slashes; Command Prompt without Claude Code gets backslashes, on relative paths too. A path with any character outside `A-Z a-z 0-9 . _ - /
: @ +` is quoted for the profile (single quotes in Git Bash and PowerShell, double quotes in
Command Prompt). Paths are joined by spaces and the text ends with a space. A drop's `baseRoot` is
the target terminal's repo; Insert path uses the Files pane's root.

### 4.5 Key handling

The custom key handler (`keys.ts`) runs before xterm.js. Any key it handles is swallowed for
keydown, keypress, and keyup alike, since xterm.js acts on the keypress that follows a keydown.

Defaults mirror the current Windows Terminal settings:

| Keys | Action |
| --- | --- |
| Ctrl+Right | Split right (duplicate) |
| Ctrl+Down | Split down (duplicate) |
| Alt+Shift+D | Split auto (duplicate) |
| Ctrl+W | Close pane |
| Ctrl+Shift+M | Collapse pane |
| Ctrl+Shift+Z | Zoom or unzoom the focused pane (4.2) |
| Ctrl+Shift+O | Open a favorite (picker; Enter opens it as a split, Ctrl+Enter opens it collapsed) |
| Ctrl+Shift+R | Open a named layout (picker; opens it as a new tab, 4.6) |
| Ctrl+Shift+P | Open the command palette (below) |
| Alt+Shift+T | Split with a chosen shell (picker of the available profiles; Enter opens a split, Ctrl+Enter opens it collapsed) |
| Ctrl+Shift+T | New tab (4.10) |
| Ctrl+Shift+W | Close tab |
| Ctrl+Shift+N | New scratch pad (4.15) |
| Ctrl+Shift+E | Files pane for the focused pane's repo (4.12) |
| Ctrl+Shift+G | Git pane for the focused pane's repo (4.13) |
| Ctrl+Shift+H | Search pane for the focused pane's repo (4.14) |
| Ctrl+Tab, Ctrl+Shift+Tab | Next tab, previous tab (wrapping) |
| Ctrl+Alt+1 to Ctrl+Alt+8 | Switch to that tab |
| Ctrl+Alt+9 | Switch to the last tab |
| Alt+Arrow | Move focus |
| Alt+Shift+Arrow | Resize pane |
| Ctrl+Shift+F | Find in scrollback, or in the file preview of a Files pane (4.12) |
| Ctrl+C | Copy if there's a selection, otherwise pass ^C |
| Ctrl+Shift+C | Copy |
| Ctrl+V, Ctrl+Shift+V | Paste text (bracketed when the app enabled it); with no text on the clipboard, pass ^V so Claude Code can paste an image |
| Shift+Enter | Send ESC+CR (Claude Code's newline) |
| Ctrl+Shift+S | Toggle dashboard panel |
| F6 | Move focus into the dashboard panel, or back to the focused pane (4.6) |
| Ctrl+Shift+B | Cycle backdrop scrim strength (saved to `scrim.opacity`) |
| Ctrl+Shift+D | Pause or resume the background animation (saved to `backdrop.animate`) |
| Ctrl+Shift+L | Focus the next terminal that needs you, across all tabs (4.7) |
| Ctrl+= or Ctrl+Numpad+ | Increase the terminal font size by 1 px (saved to `font.size`; applies to every terminal; 6 to 48 px) |
| Ctrl+- | Decrease the terminal font size by 1 px (saved to `font.size`; applies to every terminal; 6 to 48 px) |
| Ctrl+0 | Reset the terminal font size to the default, 14 px (saved to `font.size`; applies to every terminal) |
| F1 | Show the keyboard shortcut guide, built from the live keymap so overrides show; keys are changed there (below) |
| Ctrl+, | Open the settings dialog |
| F11 | Toggle full screen |

These are built-in defaults. Entries in the settings file (section 8) layer on top, as in
Windows Terminal: an entry for a chord that has a default replaces it, a new chord adds a
binding, and `"action": "unbound"` removes a default so the key reaches the shell.

**Keybinding editor.** Keys are changed in the F1 guide (`helpDialog.ts`), which lists every
action by section with its live chords. Every action in the name list has a row, including one
with no default. An action that takes an argument has one row per argument: Move focus and Resize
pane per direction, Go to tab 1 through 8. Each `sendInput` binding has its own row labeled by
its input (Shift+Enter reads "Claude Code newline"); a new `sendInput` binding is added in the
file, since it needs text the guide has no field for. "In pickers and bars" is read-only.

A row shows its chords as keycaps. `+` after the last keycap records another chord, a clicked
keycap records a replacement for that chord, its `x` removes it, and Reset, shown only while the
row differs from the defaults, restores the default chords. A row that differs has an accent dot
by its label, and a row with no chord reads "No key", dimmed. The filter field matches labels,
and Find by key records one chord and scrolls to the row that owns it, or says "Not bound:
reaches the shell".

Recording (`keybindingRecorder.ts`) listens for `keydown` in the capture phase, ahead of
`keys.ts`, so a bound chord is recorded instead of run. Modifiers alone keep it waiting; Escape
or a click elsewhere cancels. The pure rules in `keybindingEdit.ts` check each recorded chord:

| Chord | Result |
| --- | --- |
| A printable key with no modifier or with Shift alone; Escape, Enter, Tab, or Backspace with no modifier | Refused inline ("Shift+A would stop typing A"), still listening |
| Already on this action | "Already bound here", nothing changes |
| Unbound and not a shell key | Saved at once |
| Unbound, but the shell or Claude Code uses it | Saved at once, with a dimmed note under the row for as long as the binding stands |
| Bound to another action | The move strip |

The shell-key list (Ctrl+A, E, K, U, W, R, L, D, Ctrl+Left and Ctrl+Right, and a few more) gives
each key a few words on what it does in the shell, so the note under a row names the shell
feature the binding takes over (Ctrl+R: bash's reverse search). Only listed chords get a note,
and only when the row does not hold them by default.

When the recorded chord belongs to another action, the field holds it and a move strip
(`keybindingMoveStrip.ts`) opens under the row, naming the action that gives it up and adding "It
will have no key." when the move would leave that action empty. Enter moves, Escape cancels, and
a different chord records that one instead. A move is a single write. The other action's row
flashes once with the chord struck through, and a notice (`keybindingNotice.ts`) at the bottom of
the dialog says where the chord moved from, with Undo and, when that action has no key left,
Assign a key, which scrolls to its row and starts recording there. The notice stays until the
next edit or 10 seconds. Undo is a single write that restores both rows. Reset on a row whose
default chord another action holds opens the strip for those chords (all of them when there are
several) as "Move it back?", and Cancel resets nothing. Reset all, in the footer, confirms and
then empties the `keybindings` array, with the same notice and Undo.

The dialog never writes the merged keymap. It sends ops to `settings_keybindings_edit` (in
`settings.rs`), which applies them to the raw `keybindings` array in settings.json under the
settings write lock:

| Op | Effect on the array |
| --- | --- |
| `bind` | Removes the entries for the chord, then adds `{ keys, action, ...args }` unless the default for the chord is exactly that |
| `unbind` | Removes the entries for the chord, then adds `"action": "unbound"` when the chord has a default |
| `reset` | Removes the entries for the chord |
| `resetAll` | Empties the array |

Chords match through `normalize_chord`, aliases included, so `Shift+Ctrl+L` in the file is the
entry for `ctrl+shift+l`. Entries the loader rejected and the order of the others are kept, so an
edit to one entry never deletes a typo in another. The array is written whole by
`set_array_lines` in `settings_edit.rs`, one entry per line; comments outside the array survive
and comments inside it are not kept. The dialog does not update itself after a save: the watcher's
`settings://changed` rebuilds the keymap and re-renders the dialog, as a hand edit does. A failed
save leaves the rows as they were and shows the error in the notice.

In panes other than terminals, copy, paste, Shift+Enter, Ctrl+Shift+F, and typing act on the
pane's own text fields as a browser would; every other action applies as it does in a
terminal. The Files pane is the exception for Ctrl+Shift+F, which opens its preview's find bar
(4.12).

**Command palette.** Ctrl+Shift+P (`openPalette`) opens one filterable list over every pane, tab,
favorite, layout, the focused repo's pins and worktrees, and every keymap action that makes sense
without a key context. Each row shows its category at the right edge. Enter behaves as the item's
own control does: a pane is focused (expanded first when collapsed), a tab is switched to, a
favorite opens as a split, a layout opens as a new tab, a pin opens as clicking it in the Repo
section does, a worktree opens a terminal there as a split, and an action runs as its key would.
Ctrl+Enter opens a favorite or worktree collapsed. Pins whose path is missing are left out.

Actions left out are `copy`, `paste`, `sendInput` (Claude Code's newline), `switchToTab` (tabs are
items instead), and `openPalette` itself. Labels come from `helpModel.ts`, so the palette and the
F1 guide agree, and each action's hint lists its chords from the live keymap, so overrides show.
`moveFocus` and `resizePane` get one row per direction. Check for updates (3.16) is an action
row with no keymap action behind it (`PALETTE_COMMANDS` in `paletteModel.ts`), so it never
appears in the F1 guide or takes a key.

Matching is fuzzy over the label, then the detail (a pane's tab name, a favorite's path), and a
detail-only match ranks after every label match. Consecutive characters and matches at word starts
score higher. With an empty query, the session's recent picks come first (most recent first, kept
in memory and not saved), then every row in category order. A leading `>` limits the list to
actions.

Choosing a row refocuses the pane that had focus before the palette opened, then runs the
choice, so actions such as split, find, and close apply to that pane.

### 4.6 Dashboard panel

A collapsible panel docked on the side `dashboard.side` names (`right` by default, or `left`;
an unknown value falls back to `right` with a warning), open on start by default, toggled with
Ctrl+Shift+S, hidden by a × button at its top right on either side (which also ends a peek),
and peeking open briefly while hidden when a terminal starts waiting. Open, it narrows the panes
from its side. Dragging its inner edge (its left edge when docked right, its right edge when
docked left) resizes it, from 280 px (enough for the Repo section's row of buttons on
one line) up to 60% of the window, and the width is saved with the workspace (section 7); it is
the same width on either side. Its contents, top to bottom, are the clock's top slot, Repo, the
elements, and the footer. Repo, which follows the focused pane, sits at the top, below the clock
when the clock is in its top slot; the elements and the footer sit at the bottom, so a focus
change never shifts them.

**Elements.** The elements between Repo and the footer are Clock, Favorites, Layouts, Panes,
Containers, External sessions, and System, in that default order. Each has a
`dashboard.sections.*` toggle (section 8), on by default except System and Clock, set from the settings
dialog's Dashboard section or from the panel's own right-click menu, which opens anywhere on the
panel no row's menu claims and lists every element with a check on the shown ones; choosing one
flips its toggle. A disabled element is gone from the panel, not collapsed, and its
rows leave the keyboard rows below. Toggles and `dashboard.side` apply live, and switching
sides while a peek is showing ends the peek.

Clicking a section's header collapses or expands it, and which sections are collapsed is saved
with the workspace (section 7). A thin rule separates each element from the one above it.

**Order.** The elements reorder by drag: a section by its header, the clock by grabbing
anywhere on it, with the same movement threshold as favorite rows, so a click on a header still
collapses or expands it. While dragging, a line in the accent color shows where the element
will land; Repo and the footer offer no drop position. The clock alone can also be dropped
above Repo, into a top slot ruled off from Repo below it, which is where it sits by default.
Dragging is mouse only. The order is saved with the workspace as `dashboardSectionOrder`, and
whether the clock is in its top slot as `dashboardClockTop` (section 7). A disabled element
keeps its place in the order, and the clock its slot, so enabling it returns it where it was.

**Clock.** One line with no header, no collapse, and no keyboard row. On the left is a binary
grid of three columns of six dots: hours (24-hour), minutes, and seconds, most significant bit
at the top, lit dots in the accent color and unlit dots muted. On the right is the time as
`h:mm` in 12-hour time with no am/pm and no leading zero on the hour, in white with tabular
numerals. The line is at most 60 px tall and shrinks with the panel's width through a container
query unit on the clock element, so the grid and time stay on one line down to the 280 px
minimum. Its accessible name is the full time with AM or PM. It updates on each second
boundary only while the panel is on screen and the window is shown, catching up at once on
show, and no timer runs while it is disabled.

**Polling.** System, shown by `dashboard.sections.system`, polls the core on timers, and each
timer runs only while the section is enabled, expanded, and on screen (the panel open or peeking) and the window is shown.
Any of those ending stops the timer, and the next start samples at once, so the section is never
staler than one interval after it reappears. Collapsed or disabled, it costs nothing.
`PollTimer` (`pollTimer.ts`) holds the rule.

**System.** Machine load in four rows, each a label, a value, and a thin bar or sparkline:

| Row | Shows | Source | Interval |
| --- | --- | --- | --- |
| CPU | Total use as a percentage, with a 60 second sparkline | `sysinfo` CPU refresh | 2 s |
| Memory | Used of total, as "21.4 / 32 GB", with a bar | `sysinfo` memory refresh | 2 s |
| Network | Receive and send rates across all adapters, as "↓ 1.2 MB/s ↑ 40 KB/s", with 60 second sparklines for each side by side | `sysinfo` networks, loopback and virtual adapters excluded | 2 s |
| Disk | Free space on each fixed drive, as "C: 112 GB free", with a bar of used space | `sysinfo` disks, fixed drives only | 60 s |

Bars use the accent color, turning to the warning color at 80% and the error color at 90%; the
sparklines stay in the accent color. Each sparkline spans the row's full width (the network pair
splits it, download on the left), and its canvas tracks its box at device-pixel resolution. CPU
plots against 0 to 100%; each network line scales to the busiest reading on screen, never below
256 KB/s, so idle traffic stays near the baseline. Several fixed drives each take a line under Disk. Values use
tabular numerals so the rows do not shift as they change. The rows are not keyboard rows; the
section's header is. The first sample after a start shows memory and disk at once and fills in
CPU and network on the second, since both are deltas between two refreshes; they read `-` until
then, and every row reads `-` when the core cannot be reached. GPU utilization and Wi-Fi name and
signal are not shown: Windows offers GPU load only through costly counters or vendor libraries,
and the Wi-Fi values need the WLAN API for little benefit. `system_sample(includeDisks)` returns
the rows; the front end passes `includeDisks` on its 60 second beat.

**Keyboard.** F6 moves focus into the panel, onto the row focused there last, else the focused
pane's card, else the first row; F6 again, or Escape, returns focus to the focused pane. While the
panel is hidden, F6 shows it as a peek that lasts until focus leaves it, instead of timing out.
The rows are every section header, the Repo section's buttons, every favorite, recent folder,
layout, pin, container, tab group header, pane card, and external session, and the footer's
buttons, top to bottom, skipping collapsed and disabled sections:

- Up and Down move one row, stopping at the ends; Home and End go to the first and last.
- Enter or Space acts as a click on the row, and Ctrl+Enter as a Ctrl+click.
- Left on a row goes to its section's header, and on an expanded header collapses the section.
  Right on a collapsed header expands it, and on an expanded one goes to its first row.
- Tab reaches the buttons inside rows (folder, Open menu, close, remove), which show while their
  row has focus as they do on hover.
- On a worktree row, Enter or Space expands or collapses it, and Tab reaches the buttons of its
  expanded detail.
- Any other key runs its workspace action (4.5), as it would in a pane.

Only the keyboard focuses rows: the panel keeps mouse presses from taking focus off the pane, so
a focus ring in the panel always means keyboard focus. When the panel rebuilds its rows (a status
change, the 15 second age refresh), focus moves to the rebuilt row, or to the row now in its place
when it is gone.

Folder paths under row labels show the home folder as `~`, and an overlong path is cut from the
left so its last folders stay visible; hovering shows the full path.

Every favorite, recent folder, pane card, and external session row shows a folder button on
hover that opens its folder in File Explorer (`open_folder`, which accepts only an existing
absolute directory). Beside it, an Open menu lists Terminal, Files, Git, Search, and Editor,
each opening for that row's repo (4.11); Git is listed only for a git repo.

**Row menus.** Right-clicking a row opens a menu of the actions its buttons offer (4.4 describes
the shared module). "The Open entries" below are the Open menu's, listed first, with Git only for
a git repo; "Explorer" is Open in File Explorer.

| Row | Items |
| --- | --- |
| Pane card | Focus, Collapse or Expand; for a pane with a folder, the Open entries, Explorer, and Copy path; Close (asking as its button does) |
| External session | The Open entries, Explorer, and Copy path (when the session has a cwd); Copy cwd and Copy session id, offered whether or not the row is expanded |
| Favorite | The Open entries, Explorer, Copy path, Remove favorite |
| Recent | The Open entries, Explorer, Copy path, Add to favorites |
| Layout | Open, Rename, Remove (asking inline, as its button does) |
| Repo pin | Open, Explorer (a file pin's folder), Copy path, Rename, Remove pin |
| Worktree | The Open entries, Explorer, Copy path, Delete (absent for the main worktree, disabled while locked) |
| Containers | Start when any container in the group is stopped, Stop when any runs, Open Containers |
| Claude | Focus, Copy path |

A row whose path is missing (a dimmed pin, a prunable worktree) disables everything but its
Remove pin or Delete item. A Containers row that only reports an engine not running has no menu.
Section headers, tab group headers, the clock, the System section, the footer, gaps between
panes, and the backdrop have no menu.

The Open menu button on those rows, and the Files row's menu button (4.12), open the same shared
menu below the button, toggling on a second press. The Git entry waits for the git probe, and the
menu is dropped if another menu opened or closed meanwhile.

**Repo.** The repo (3.8) of the focused pane's folder, or of the last focused pane that had
one. A Files pane counts as the repo it was opened for, not the folder it is showing, so opening
a pinned subfolder keeps the section on its repo. The header shows the repo folder's name and, for a git repo, its branch; while the panel is open
the repo is re-read every 3 seconds, so a checkout in any shell shows up without a folder change.
Under it, a row of buttons opens a Terminal, Files, Git, or Search pane for the repo, or opens it
in the editor (3.12). Then come the repo's pins (4.12), each showing a file or
folder icon and its label or path; clicking one opens it, and pins reorder by drag and can be
renamed and removed. The section is hidden until some pane has a folder.

**Worktrees.** Under the pins, when the focused repo is a git repo with two or more worktrees,
the section lists every worktree of the repo (3.9), the main worktree first, then the rest by
folder name, and the worktree of the focused pane is highlighted. Each row shows the folder name
(the path on hover), the branch or the short hash when detached, ahead and behind counts
against the primary branch such as "3 ahead, 12 behind" (omitted when both are zero), a badge,
and the folder button and Open menu every dashboard row has. The badge is **Merged**,
**Probably merged**, **Locked**, or **Prunable** (folder missing), in that priority; the main
worktree never shows Merged. A prunable row has no folder button or Open menu.

The list loads when the section shows a repo and reloads on `git://changed` events whose
`metadata` flag is true for any of the repo's worktree roots, and after an app-run fetch. While
the panel is open and shows the list, the section holds its own `git_watch` on the main
worktree (3.9), released when the section switches repo or the panel closes, so a fetch, a
branch move, or a worktree added or removed in a terminal reaches the list. Ordinary file edits
never reload it, and it does not follow the 3 second re-read, since its counts cost a `rev-list`
per worktree. A checkout in the focused worktree also reloads it, ahead of the watcher.

Clicking a row expands it in place (clicking it again, or another row, collapses it) and loads
`git_worktree_detail`:

- **Head.** The newest commit's subject, short hash, and relative time.
- **Against primary.** The ahead and behind counts with the comparison ref, and the merged
  state in words: "Merged: every commit is in `origin/main`", "Probably merged:
  `origin/feature-x` was deleted on the remote", or "Not merged".
- **Upstream.** Its name with ahead and behind, "No upstream", or "Upstream deleted on the
  remote".
- **Working tree.** "Clean", or the counts of staged, changed, and untracked files.
- **Actions.** Terminal, Files, Git, and Editor, Open in File Explorer, and Delete (not on the
  main worktree, and disabled on a locked one).

A "Compare worktrees with..." button in the section header, shown while the list is, opens a
menu of "Automatic" (with the branch it resolves to) and the repo's local branches, checking the
current choice. Picking one writes `primaryBranch` for the repo in `repos.json` (section 7);
Automatic clears it.

Delete first checks that no pane in the app (a terminal's working directory, or another kind's
folder) and no external Claude session is inside the worktree, since a shell's working
directory holds the folder open on Windows; if one is, it shows the panes' names inline instead
of a dialog. Otherwise it asks in a confirm dialog naming the folder and branch, with a checkbox
"Also delete branch `<name>`". The checkbox is checked and enabled only when the state is
Merged; for Probably merged it is disabled with the note "Squash-merged branches need
`git branch -D` in a terminal", since the app never runs `-D`. For a prunable worktree the
dialog adds that the folder is missing and that Delete runs `git worktree prune`. Refusals from
`git_worktree_remove` and git's own output show inline in the detail.

**Favorites.** One row per favorite folder (3.7), showing its label and path:

- Clicking opens a new terminal there (a `cd`, no command) as a split of the focused pane;
  Ctrl+click opens it collapsed; dragging the row docks it (4.2). When the focused pane has no
  room for another split, a toast says so and the terminal opens collapsed instead.
- A "+" button adds the focused terminal's working directory, and records the focused
  terminal's shell profile when it differs from `shell.defaultProfile`. A favorite with a
  profile opens in that shell; one without opens in the default. Rows show a profile badge
  when the profile is not Git Bash. Rows can be renamed, removed, and reordered by drag.
- Below the favorites, up to five recent folders taken from the roster's session cwds that are
  not already favorites, each with a star to promote it.

**Layouts.** Named arrangements of panes (3.7), under Favorites. A layout holds one tab.
One row per layout, showing its name and pane count:

- The "+" button asks for a name and saves the active tab's panes (their kinds, folders,
  shells, collapsed state, and split layout, 4.11) under it. Saving over an existing name, compared without
  regard to case, asks inline before replacing it. Saved terminals never carry a Claude
  session.
- Clicking a row opens the layout as a new tab, named after the layout and made active. Every
  other tab is left as it was. A layout with no panes opens as a tab with one default
  terminal. Opening a layout does not resume Claude (4.9).
- Rows can be renamed and removed; removing asks inline first. Ctrl+Shift+R opens a picker over
  the layouts that opens the selection the same way. The command palette (Ctrl+Shift+P, 4.5) also
  lists favorites, layouts, pane cards, tabs, pins, and worktrees.

**Panes.** One card per pane in this app, of any kind (4.11), expanded or collapsed, grouped by
tab. Groups follow the tab strip's order, and within a group cards are in the order their panes
were opened or moved into the tab. The order stays fixed as statuses change so a card never
moves out from under the pointer.

A group's combined status follows the tab urgency order (4.10). With two or more tabs, each group has a header showing the tab's name and its pane count, with
the group's cards indented beneath it along a vertical guide line. The header has no status dot,
so only cards carry one. The active tab's header is brighter and its guide line takes the
accent color, and clicking a header switches to that tab. With one tab there
are no headers and the section reads as a plain list.

Dragging a card or a title strip onto another tab's group (its header or cards) highlights the
group, and dropping there moves the pane into that tab without switching to it. A collapsed pane
stays collapsed. An expanded one splits that tab's focused pane in the auto direction, as
expanding does (4.3), or fills its empty layout; when there is no room, a toast says so and it
lands collapsed. A tab the move empties closes, and if that was the active tab, the target tab
becomes active. A group takes precedence over any dock target beneath it, and dropping on the pane's own group does nothing.

Each card shows:

- For a terminal, the status dot (4.8): `idle`, `working` (animated), `waiting` (pulsing,
  accent color), `done` (a still check mark), or `failed` (a still cross in the error color),
  plus the attention pulse (4.7). Other kinds show their kind's icon.
- The bound Claude session's name, or the working directory's last folder, with the full path
  beneath. While the terminal is `waiting`, the line beneath is the waiting reason (3.3) in the
  accent color in place of the folder, one line with an ellipsis, full text on hover. A
  `waiting` with no message reads "Waiting for you". Other kinds show the pane's title (4.11)
  and its folder, if any.
- For a terminal bound to a Claude session (3.4), a dimmed line below that with the session's
  model and the tokens in its context, as "Opus 5.5 · 112k tokens", read from its transcript.
  Either half shows alone while the other is unknown, and the line is absent until the
  transcript has an assistant message. The count has no bar or percentage: neither the
  transcript nor any hook payload names the context window, so a fraction of it would be a guess.
- For a terminal, time since the last status change.
- A profile badge when the terminal's shell is not Git Bash.
- Whether it is expanded or collapsed. Clicking an expanded card switches to its tab if needed
  and focuses its pane; clicking a collapsed one expands it (4.3).
- A close button, which asks first if a command or Claude session is running, or if a scratch
  pad is not empty.

**Containers.** One row per container group (4.16) with its state dot, and an Open Containers
button in the header. Shown while a container engine is available (3.10) and
`dashboard.sections.containers` is on. The same setting decides whether the kind menu (4.11)
offers a Containers pane.

**External sessions.** Claude Code sessions running outside this app (Windows Terminal, VS
Code), sorted waiting, then busy, then idle, then by most recent change. Clicking a row shows
its cwd and session id with copy buttons. A `waiting` row shows the reason under the folder,
the same as a card. The section is hidden while there are none.

**Footer.** Three buttons sit at the bottom of the panel. Install Claude Code hooks is shown only
while Claude Code is detected and the hooks are not installed (3.3). Keyboard shortcuts opens the
help dialog, also bound to F1. Settings opens the settings dialog, also bound to Ctrl+,.

The settings dialog edits every user-facing setting, in the sections Appearance, Backdrop, Terminal,
Editor, Dashboard, Restore, and Keyboard. Dashboard holds the side choice, Left or Right, and a
checkbox per element under "Show on the dashboard". Keyboard holds one button, Edit keyboard
shortcuts, which closes the dialog and opens the F1 guide (4.5). Terminal includes a Default shell
select listing the available profiles. Editor selects the preferred editor from those found (3.12),
plus a custom command field. Appearance's Font family field suggests installed fonts as you type
(3.17), monospace first, with the bundled JetBrainsMono Nerd Font Mono (3.16) leading. It stays a
text field, so a name that is not installed or a comma-separated fallback list saves as typed;
picking an entry replaces the whole value and saves it at once. The list loads after the dialog
opens. A Run setup button reopens the setup wizard (4.17). Each change is written to settings.json
through the app, so the file's comments survive. Toggles save immediately; number and text fields
save on blur or Enter; the shell arguments list (one argument per line) saves on blur or Ctrl+Enter;
sliders save shortly after the drag stops and show the live value. Invalid input (out of range,
empty, or not a number) shows an inline error and is not saved, and a failed save shows an inline
error too. When settings.json changes on disk while the dialog is open, every control except the
focused one refreshes. Fields that do not apply live say so beside the control:
dashboard.visibleOnStart and restore.* apply at the next launch, and shell.* applies to panes opened
afterward. Warnings about the current settings appear at the top of the dialog. The Open
settings.json button in the footer opens the file in the default editor, with the note "Keyboard
shortcuts are changed in the shortcut guide (F1); keys that type text are added to the "keybindings"
list in settings.json." Escape or a click outside the dialog closes it.

A peek overlays the panes from the panel's side without narrowing them. It ends after a few seconds, but stays
while the pointer is over the panel and ends when the pointer leaves; opening the panel ends
it too.

Every row tied to a Claude session has a hue swatch matching that session's lineage color in
the backdrop (6.3), which is how the backdrop and the dashboard stay readable as one system.

### 4.7 Attention

When a terminal enters `waiting`, or rings the bell (`term.onBell`, which also catches the
existing `printf '\a'` hook):

- An expanded terminal's pane border pulses until it is focused; a collapsed terminal's card
  pulses until it is expanded. A terminal in a background tab also pulses that tab in the tab
  strip and its group header in the dashboard, until none of the tab's terminals is marked.
- A terminal being **looked at** (the focused, expanded pane of the active tab in a focused
  window) is not marked. Attention clears when the pane becomes the one looked at,
  including when switching to its tab or when the window regains focus with it focused.
- If the window is unfocused, the taskbar button flashes. A toast is not sent, because the
  existing `Notification` hook already raises one.

`done` and `failed` (4.8) are quieter: they change the status dot on the title strip, card,
tab, and group header, and nothing else. They raise no attention, so no pulse, taskbar flash, or
panel peek.

**Next terminal that needs you.** `nextAttention` (Ctrl+Shift+L) focuses the next such
terminal across all tabs. The order is every `waiting` terminal, oldest `statusChangedAt` first,
then every `done` or `failed` terminal, oldest mark first. Terminals that rang the bell without a
status are not included; their pulse stays the cue. When the focused pane is in the list, the
jump goes to the entry after it, wrapping; otherwise to the first entry. `waiting` does not clear
on focus, so repeated presses walk the whole list; `done` and `failed` clear on focus, so they
drop out as they are visited. The jump switches to the pane's tab if needed and focuses it; a
collapsed terminal expands as clicking its card does (4.3), and a zoomed pane (4.2) in the
target tab unzooms first. An empty list shows a toast, "Nothing needs you".

### 4.8 Terminal status

Every terminal is `idle`, `working`, `waiting`, `done`, or `failed`, resolved in order:

1. **Bound Claude session.** Its session status (section 7): `busy` shows as `working`, `idle`
   as `idle` (or `done`, below), `waiting` as `waiting`, and `unknown` falls through to the
   shell.
2. **Shell activity.** `working` while a foreground command runs, otherwise `idle`. OSC 133
   markers give exact transitions: `C` (command started) to `working`, `D` (command finished)
   to `idle`. A shell without the `~/.bashrc` lines (4.2) falls back to the core's activity
   sweep (3.1), which reports `working` while the shell has a running job (background jobs
   included), up to 2 seconds late.

Plain shells have no `waiting` state; a program that needs the user rings the bell, which
raises attention (4.7) without changing status.

**Done.** When a bound session's `Stop` hook arrives while its terminal is not being looked
at (4.7), the terminal shows `done` instead of `idle` until it is. Any later status (a new
prompt, `waiting`, the session ending) replaces it. A roster change to `idle` does not set it.

**Long commands.** A shell command that runs at least `terminal.doneAfterSeconds` (section 8;
default 30, 0 turns it off) and finishes while its terminal is not being looked at (4.7) marks
the terminal `done`, or
`failed` when it exited nonzero. The duration is measured from OSC 133 `C` to `D`, so only Git
Bash with the `~/.bashrc` lines (4.2) qualifies; PowerShell and Command Prompt terminals never
get a command mark, and the activity sweep is not used, since it counts background jobs and
reports up to 2 seconds late. `D` with a nonzero exit code marks `failed`, except 130
(interrupted with Ctrl+C), which marks nothing; `D` with no exit code marks `done`. While a
Claude session is bound, its status resolves first and command marks are not set; when `claude`
itself exits after a long run, its `D` is an ordinary long command. A mark clears when the
terminal becomes the pane being looked at, and a command mark also clears on the next `C`; a
newer mark replaces the old. `failed` is a still cross in the error color, where `done` is a
still check mark.

`done` and `failed` are display state only; the session stays `idle`, and the backdrop never sees
them (6.3). They are not saved, so restored terminals start without them.

### 4.9 Restore

The front end saves the workspace (3.7, shape in section 7) one second after any change to the
tabs, layouts, collapsed terminals, working directories, or session bindings, and again when
the window closes. On launch:

- Each saved terminal gets a new shell of its saved profile (the default profile when none is
  saved or the profile is unavailable) in its saved directory, or in `startingDirectory` if that
  folder is missing. Each tab's layout and collapsed terminals are rebuilt around the new
  pane ids, the tabs keep their order and names, the same tab is active, and each tab's focus
  returns to the same terminal.
- A terminal that had a live Claude session bound when last saved gets
  `claude --resume <sessionId>` typed into it once its shell is ready (the first OSC 133 `A`,
  or the first output when the markers are absent), so the command shows in the terminal and
  in history like any other.
- Scrollback is not restored.
- A missing or empty workspace opens one tab with one terminal in `startingDirectory`. Closing
  the last tab saves an empty workspace, so the next launch starts fresh.

`restore.enabled` and `restore.resumeClaude` (section 8) turn either part off.

Opening a named layout (4.6) rebuilds one tab the same way, appended as a new tab with the
layout's terminals in their saved directories and profiles. Session ids are always null in a
layout, so no Claude session is resumed.

### 4.10 Tabs

A tab is a named group of panes (4.11) with its own split tree (4.2), focused pane, and
collapsed panes (4.3). Every pane belongs to exactly one tab. The window always has at least one
tab; the one on screen is the active tab.

**Tab strip.** With two or more tabs, a 28 px strip runs along the top of the window above the
panes, which reflow to make room; with one tab there is no strip, so a single-tab window looks
the same as a window without tabs. Each tab shows a status dot for the most urgent of its
terminals (`waiting`, then `failed`, then `done`, then `working`, then `idle`), its name, and a
close button on hover. The tab's tooltip lists each waiting terminal's title and reason (3.3). A
"+" at the end of the strip opens a new tab.

- Clicking a tab switches to it. Double-clicking its name renames it inline; Enter or blur
  saves, Esc cancels. Tabs reorder by drag, and the dashboard's groups follow.
- Holding a dragged pane, card, or path (4.4) over a tab for half a second switches to that tab,
  so the drag can continue into a dock target there (4.2) and move the terminal across tabs, or
  into a terminal there to drop the path.
- The strip is chrome on z3 and draws over the backdrop with the same scrim as the title strips.
- **Menus.** A right-click on a tab offers Rename, New tab, and Close tab, each as the tab's own
  gesture does; a tab being renamed offers its input's text field menu instead. A right-click on
  the strip outside any tab offers New tab.

**New tab** (Ctrl+Shift+T or the "+"): appends a tab with one terminal of the default profile in
the focused pane's working directory (4.2), and makes it active.

**Switching** (click, Ctrl+Tab, Ctrl+Shift+Tab, Ctrl+Alt+digit, or the dashboard): the
outgoing tab's terminals leave the DOM the way collapsed terminals do (4.3), keeping their ptys
and scrollback and releasing their WebGL contexts. The incoming tab's layout is rendered and its
terminals are refit, take WebGL contexts as the budget allows (4.4), and focus returns to the
tab's focused pane. The backdrop keeps running throughout; switching tabs does not touch it.

**Closing a tab** (Ctrl+Shift+W, or its close button) kills all of its terminals. When any of
them has a running command or a live Claude session, a confirm dialog lists them first and
nothing changes if it is declined. Closing a tab activates its right neighbor, or its left one
when it was last. Closing the last tab closes the window.

**Names.** A new tab takes its name from its focused pane's title (the bound session's name or
the working directory's last folder, 4.4) and follows it as focus and folders change. Renaming
the tab fixes its name; renaming it to an empty string returns it to following the focused
pane. A tab opened from a layout starts with the layout's name, fixed.

### 4.11 Pane kinds

Every leaf of a tab's split tree is a pane of one kind:

| Kind | Content | Section |
| --- | --- | --- |
| `terminal` | A shell | 4.4 |
| `files` | A folder's files beside a preview of the selected one | 4.12 |
| `git` | A repo's changes, staging, commits, and diffs | 4.13 |
| `search` | Code search over a repo | 4.14 |
| `scratch` | A plain text scratch pad | 4.15 |
| `containers` | Docker and Podman containers grouped by Compose project | 4.16 |

Every kind but `scratch` and `containers` has a folder: a terminal's working directory, or the
folder another pane was opened for. A pane's repo is the repo (3.8) of its folder.

- **Ids.** Pane ids come from a front-end counter: `p<n>` for terminals and `v<n>` for other
  kinds. A terminal's pty id (3.1) is separate.
- **Kind menu.** The first control in the title strip shows the pane's kind as an icon.
  Clicking it lists the kinds, and choosing one replaces the pane in place: same spot in the
  tree, same folder. A pane with no folder passes on the Repo section's repo (4.6). Replacing a
  terminal with a running command or a live Claude session asks first, as closing it does, and
  so does replacing a scratch pad that is not empty. A terminal chosen from the menu runs the
  default profile. The menu lists Containers only while a container engine is available (3.10)
  and `dashboard.sections.containers` is on. It is drawn by the shared context menu module (4.4)
  below the button, with the current kind checked; choosing the current kind does nothing. The
  title strip's right-click menu offers the same entries as its Change kind submenu.
- **Opening.** Ctrl+Shift+N, E, G, and H (4.5), the Repo section, and the Open menu on dashboard
  rows (4.6) open a pane as a split of the focused pane, the way a favorite does: when there is
  no room, a toast says so and the pane opens collapsed. A Git pane for a repo that already has
  one in the active tab focuses that one instead.
- **Common behavior.** Every kind has the title strip, scrim, focus border, docking, collapsing,
  and closing that terminals have. Status, attention, and the WebGL budget apply to terminals
  only. A tab's status dot comes from its terminals; its name follows the focused pane's title,
  which for other kinds is the folder's name, a scratch pad's first line, or "Containers".
- **Restore.** Each kind saves its state with the workspace (section 7): a Files pane's folder,
  selected file, and whether its preview is expanded (4.12), a Git pane's repo, a Search pane's
  repo, query, and options (rerun on restore), and a scratch pad's text. A pane whose folder no
  longer exists opens on a notice naming the path, with the kind menu still available. A Files
  pane restored expanded over a file that is missing or cannot be previewed as text shows its list.
- **Layouts** save every kind. Scratch pads are saved empty, so a layout opens fresh pads.

### 4.12 Files and pins

A Files pane shows one folder: on the left, a list with folders first and then files newest
modified first, under a breadcrumb that leads up to the repo root; on the right, a preview of
the selected file. The divider between them drags. The list follows the folder on disk
(`fs_watch`, 3.8).

The preview depends on the file:

- **Markdown** (`.md`) renders through `markdown-it` with raw HTML off, then `DOMPurify`. Links
  to `http` and `https` open in the browser; a relative link to another file opens it in the
  same pane. Images are not loaded. An Edit toggle switches to the text editor below.
- **Plain text** (`.txt`, or no extension) opens in the text editor, with long lines wrapped.
- **Other text files** (code, JSON, YAML, HTML, and so on) open in the text editor with a
  line-number gutter; lines do not wrap and scroll sideways instead.
- **Binary files, and files over 2 MiB,** show their name, size, and an Open in editor button.

**Find** (`previewFind.ts`): every text preview has a Find button on its toolbar, beside Edit
for markdown; Ctrl+Shift+F anywhere in the Files pane does the same. It opens a bar in the
toolbar that works like the terminal's (4.4): case-insensitive, literal, as you type, Enter for
the next match and Shift+Enter for the previous, "n of m" or "No results". Matches are painted
with the CSS Custom Highlight API, so the rendered markdown's DOM is never rewritten; past 5000
matches it stops and the count reads "5000+ matches". In the text editor, a hidden copy of the
text laid out under the transparent textarea carries the highlights. The search follows the
text as it changes: an edit, a reload, or the Edit toggle re-runs it. Esc closes the bar and
selects the current match (in the editor, as the caret's selection).

**Zoom.** The preview toolbar ends in − and + buttons that step the preview's text size through
browser-style levels from 50% to 300%; the breadcrumb has the same pair for the list, between
Open in File Explorer and Open terminal here. Each scales from its base size (the terminal font
size for code and the text editor) and holds while browsing the pane. Every step is saved to
`textZoom.filePreview` or `textZoom.filesList` in workspace.json (section 7), the level a new
Files pane starts at; other open panes keep their own.

**Expand.** The Expand preview button after the − and + buttons fills the pane with the
preview on every text preview (markdown, plain text, and code); a binary or
too-large file has no button. Its icon is a side panel with a left-pointing arrow, kept
distinct from the title strip's zoom icon (4.2) since both show at once, and the two combine
into a full-window reader. Expanded, the list, breadcrumb, and divider hide, and the toolbar
shows the file's name, since the breadcrumb that located it is hidden. The button then reads
Show file list and its icon points right. Find, zoom, Edit, editing and saving, and relative
markdown links work as before, and a followed link keeps the pane expanded.

Either the button or Esc anywhere in the preview brings the list back, at the divider position
it had, with the previewed file selected and the list focused, so Up and Down browse on from
there. An open find bar takes the first Esc, so with the bar open it takes two presses.
Showing a folder in the pane (a pin, `bb open` on a folder, 3.13) also brings the list back;
selecting a file the same way (a pinned file, `bb open` on a file, a markdown link) keeps the
preview expanded. A file that cannot be previewed as text shows the list.

**Text editor.** A monospaced text area. It saves one second after typing stops, on blur, and
on Ctrl+S, through `fs_write_text` with the modified time it last read. When the file changes on
disk and there are no unsaved edits, it reloads in place, so a to-do list Claude edits updates
in front of you. With unsaved edits, a bar offers Reload (discarding them) or Keep mine
(overwriting the file). A file that is not valid UTF-8 (a `lossy` read) opens read-only under a
note saying why, since saving the decoded text would replace its invalid bytes; a reload
re-checks, so the editor unlocks once the file on disk is valid UTF-8.

**Rows.** Clicking a row selects it; double-clicking a folder opens it, and double-clicking a
file opens it in the editor (3.12). Selection follows File Explorer (`fileSelection.ts`):
Ctrl+click toggles a row, Shift+click selects from the anchor (the last plain or Ctrl click) to
the row, Ctrl+Shift+click adds that range, Shift+Up and Shift+Down extend it, and Ctrl+A selects
every visible row. The preview follows the cursor, the row last clicked or moved to, which an
outline marks when it is not selected. A refresh or a filter drops selected rows that are gone.

Each row's menu, from its menu button or a right-click (through the keyboard, the cursor's row),
has the items below. A right-click or menu button on a row outside the selection selects just
that row first; on a row inside a selection of several, the menu acts on all of them and offers
only Copy paths (one per line), Insert paths, and Move <n> files to (its files).

- Open terminal here (folders only): a new terminal of the default profile in that folder, as a
  split of the Files pane.
- Open in editor.
- Copy path.
- Insert path: pastes the path, relative to the Files pane's root and quoted for the shell of
  the tab's most recently focused terminal (`pathInsertText`, 4.4), as a bracketed paste without
  Enter, then focuses that terminal.
- Move to (files only, and only when there are targets): the repo's pinned folders and the
  current folder's subfolders (`fs_move`), as a submenu.
- Pin.

The breadcrumb also has an Open terminal here button for the current folder, and the list's zoom
buttons. A right-click on the breadcrumb, or on the list outside any row (or the Menu key with no
row selected), opens a menu for the current folder: Open terminal here, Open in File Explorer,
Copy path, and Pin, which reads Unpin while the folder is pinned and toggles it as the pin button
does.

A right-click in the preview outside the text editor offers Copy (with text selected), Find
(disabled when the preview has no find bar), Open in editor, and Copy path, for the previewed
file; with no file previewed there is no menu. The text editor has the text field menu (4.4).

Rows, files and folders alike, drag their paths onto a terminal or scratch pad (4.4). Dragging
a selected row drags the whole selection; dragging another row drags just it, selecting it.

**Moving by drag.** A drag of files only (no folders) also targets folders: a folder row in any
Files pane, a breadcrumb segment, or elsewhere in a Files pane's list for the folder it shows. The
target highlights, and the ghost reads `Move to <folder>: <name> +N`. The folder the files are in
is not a target, nor is anything while a pane's preview is expanded. The drop moves the files
through the pane they came from (`fs_move` per file, after saving the preview's pending text);
each failure, such as a name already taken, is toasted and the rest still move.

**Keyboard and filter.** While the list has focus:

- Up and Down move the selection, previewing as a click does; Enter acts as a double click.
- Typing a printable character filters the list to names containing the typed text, ignoring
  case, and shows the filter above the list with a clear button. Backspace edits it, and Esc
  clears it. Moving to another folder clears it too.
- Backspace with no filter goes up one folder, stopping at the repo root.

**History.** Back and forward buttons beside the breadcrumb step through the folders this pane
has shown, as a browser does; the mouse's back and forward buttons do the same over the pane.
History is not saved.

**Pins** are files and folders kept per repo in `repos.json` (section 7). A pin inside the repo
is stored relative to its root; one outside it, such as a meeting notes folder, is stored as an
absolute path. The breadcrumb's pin button pins the current folder. In the Repo section
(4.6), clicking a pinned folder shows it in the active tab's Files pane for that repo, or opens
one; clicking a pinned file does the same with its folder and selects it. A pin whose path no
longer exists is shown dimmed and opens nothing.

### 4.13 Git pane

For one git repo, top to bottom:

- **Branch** with its upstream and the ahead and behind counts, the last fetch label, and the
  Fetch, Pull, and Push buttons.
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
  offers Show diff, Copy hash, Copy subject, and, on the commit the diff bar's Undo commit button
  targets, Undo commit (which asks first, as the button does).

Diffs show in a panel beside the lists, unified, with added and removed lines colored and hunk
headers kept. A diff over the cap says so. The bar above the diff ends in − and + zoom buttons
that work as the Files pane's do (4.12), saving to `textZoom.gitDiff` in workspace.json.

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

The pane refreshes on `git://changed`, when it comes on screen, and when the window regains
focus. A folder that is not a git repo shows a notice instead.

### 4.14 Search pane

A query field with toggles for Match case, Whole word, and Regex, and a Files to include field
taking a glob. The search runs 250 ms after typing stops (3.11). Opening the pane while the
focused terminal has a selection starts with that text as the query.

Results list matching file names first, then matches grouped by file, each group collapsible,
with line numbers and the match highlighted. A footer gives the count, or says the results stop
at the first 5,000. Up and Down move through matches. Selecting one previews its file beside the
list, read-only, scrolled to the line with it highlighted; Enter, a double click, or the Open
button shown on a hovered or selected row opens the file in the editor at that line (3.12). A
file's group header has the same Open button on hover, opening the file with no line. Match rows,
file group headers, and file name rows drag the file's path, with no line number, onto a terminal
or scratch pad (4.4).

A right-click on a match row offers Open at line, Copy path, and Insert path. On a file group
header it offers Open, Copy path, Insert path, and, after a separator, Collapse or Expand; a file
name row has the same menu without the collapse item. Copy path and Insert path use the file's
path with no line number.

### 4.15 Scratch pads

A scratch pad is an untitled text area, like a new tab in Notepad++, in the terminal font. Its
title is its first non-empty line, shortened, or "Scratch". It saves to `scratch/<id>.txt` (3.7)
half a second after typing stops and comes back on restore.

- **Send** (Ctrl+Enter) pastes the whole text into the tab's most recently focused terminal as a
  bracketed paste without Enter, so a prompt can be drafted here and reviewed before sending,
  then focuses that terminal. It is disabled while the tab has no terminal.
- **Copy** copies the whole text. **Clear** empties it.
- **Save as** writes it to a file chosen in the native save dialog, opened from the core.

The text area's right-click menu is the text field menu (4.4) with Send (disabled while the tab
has no terminal), Copy all, Clear, and Save as after a separator, each as its button does.

A scratch pad is a drop target for dragged paths (4.4): they are inserted at its caret.

Closing a pad that is not empty asks first, and closing it deletes its file. Closing a tab with
pads that are not empty lists them in the tab's confirm dialog (4.10).

### 4.16 Containers

Docker and Podman containers (3.10) are grouped by engine and Compose project; a container with
no project is its own group, named after the container. A group is running when all its
containers run, partial when some do, and stopped when none do, and its state dot shows which.

**Dashboard section** (4.6). One row per group, with no mention of the engine: groups with the
same name on both engines share a row. Each row shows the dot, the name, and a running count
such as "1 of 2". Hover buttons start the group when any container is stopped and stop it when
any is running. Clicking a row opens the Containers tab with that group expanded. An engine that
is not running adds a single row saying so, such as "Podman is not running".

**Containers tab.** Open Containers switches to the tab holding a Containers pane, focusing it,
or appends a tab named "Containers" with one. A Containers pane is an ordinary pane and can be
docked anywhere.

**Containers pane.** One heading per available engine, Docker and then Podman, each showing
whether that engine is running; only one engine available means no headings. Under each,
groups expand to their containers. Each container row shows its state dot,
service or container name, image, status text ("Up 3 hours"), published ports as links to
`http://localhost:<port>` (through `open_url`), and CPU and memory, refreshed every 5 seconds
while the pane is on screen. Groups and containers have Start, Stop, and Restart; containers also
have:

- **Logs**, which follow the container's output in a panel beside the list. Scrolling up stops
  following; scrolling to the end resumes it.
- **Shell**, which opens a terminal running a shell in the container (3.10) as a split beside
  the pane, titled with the container's name. Container shells are not saved by restore or in
  layouts.

A right-click on a group heading offers Start, Stop, and Restart, enabled as the heading's
buttons are. A right-click on a container row offers Start, Stop, Restart, Logs, and Shell
(enabled only while running); then one Open `localhost:<port>` per distinct published TCP port;
then Copy name. A dashboard Containers row has its own menu (4.6).

### 4.17 Setup wizard

Shown at launch when `settings.json` did not exist before that launch (the settings payload's
`firstRun`), and from the settings dialog's Run setup button. Each step saves through
`settings_set` as soon as a choice is made, so leaving partway keeps what was chosen. Every step
has Back, Next, and Skip setup.

1. **Git.** Shown only while Git Bash is missing (3.15). With winget available, an Install Git
   button runs the install and shows its progress and result; the step stays in the list once
   Git is installed, reading "Git installed". Without winget, a button opens git-scm.com.
2. **Shell.** The available profiles (3.1); sets `shell.defaultProfile`.
3. **Shell integration.** Shown when Git Bash is found and `~/.bashrc` does not already hold the
   current block (3.14), and hidden when its state could not be read. It lists the lines and
   the file they go in, notes the backup and any `.bash_profile` it will create, and runs the
   install with Add to .bashrc. A `custom` status shows the lines and an error instead of the
   button.
4. **Editor.** The editors found (3.12) and the file's default app; sets `editor.preferred`.
5. **Favorites.** A folder field, starting at `%USERPROFILE%\source\repos` when it exists,
   listing its subfolders that are git repos with checkboxes. The subfolders come from
   `setup_repo_candidates(dir?)` (`src-tauri/src/setup.rs`), which lists the direct subfolders
   holding `.git`, as a folder or as a worktree's file. Add appends the checked ones to
   favorites, skipping any already there.
6. **Claude Code.** Shown while Claude Code is detected and the hooks are not installed;
   explains the hooks and runs the install with its confirmation (3.3).
7. **Look.** The scrim presets (section 5) and the background animation on or off, applied live.

## 5. Readability

Bloom behind text is the main readability risk. Each pane draws a scrim layer between the backdrop and
its terminal: a dark fill at configurable opacity (default 0.5) with an optional
`backdrop-filter: blur()` (default 0, since blur over a constantly moving WebGL canvas is the
most expensive effect here). Ctrl+Shift+B cycles none, light, and medium presets and saves the
choice. An opacity of 0 means no scrim, so blur is off there too. The backdrop itself is never dimmed;
the scrim does the work.

## 6. Backdrop

### 6.1 Modules

The colony simulation and renderer live in `src/backdrop/`.

- `src/backdrop/sim/` is the simulation, with its Vitest suite, and `src/backdrop/render/` is the
  Three.js renderer. Neither touches the DOM.
- The backdrop has no HUD, controls, or pointer handling; it never shows an interface or takes
  input.

### 6.2 Backdrop API

`src/backdrop/backdrop.ts` is the one entry point the rest of the app uses. It holds the frame loop
(simulation ticks, motion, auto-orbit, following the colony, the opening
dolly) with no HUD updates or pointer handling:

```ts
export interface BackdropHandle {
  colony: SessionColony;
  /** Pause rendering entirely, e.g. while the window is minimized. */
  setVisible(visible: boolean): void;
  /** False freezes the backdrop on a still frame (`backdrop.animate`). */
  setAnimated(animated: boolean): void;
  /** `backdrop.maxFps`; 0 is uncapped. */
  setMaxFps(maxFps: number): void;
  /** `backdrop.capacity`, `mutationRate`, `zoom`, and `waitingPulse`. */
  setOptions(options: BackdropOptions): void;
  dispose(): void;
}

export interface SessionColony {
  /** Founds a lineage for a session, or returns the existing one. */
  ensure(sessionId: string, hue: number): void;
  setMood(sessionId: string, mood: 'busy' | 'idle' | 'waiting'): void;
  /** Lets the lineage die out naturally instead of vanishing. */
  release(sessionId: string): void;
}

export function mountBackdrop(canvas: HTMLCanvasElement): BackdropHandle;
```

The simulation runs at a fixed 12 generations per second, and the camera orbits slowly,
holding still while the OS asks for reduced motion. The simulation and camera controls are
settings (section 8), all hot-reloaded: population capacity (300 to 5000, default 1000; "Density"
in the dialog) and mutation rate (0 to 4, default 0.2; "Color drift"). Two more: zoom
(0.5 to 3, default 2) divides the camera's home distance, so the colony fills more of the window,
and the camera glides to a changed value; `waitingPulse` (default off) turns on the waiting
pulse below. The settings dialog groups them with
`backdrop.animate`, `backdrop.maxFps`, and the scrim under "Background Animation"; the UI calls
the backdrop the background animation, and labels the scrim's controls "Brightness" (shown as
1 minus `scrim.opacity`, so the far left is fully dimmed) and "Blur". While `backdrop.animate` is off, the dialog hides the
fields a still frame can't show (the frame rate cap, the simulation controls, and
`waitingPulse`), leaving zoom and the scrim, which still change the frozen view.

### 6.3 Sessions as organisms

The background colony keeps living as it does today. Each live session additionally owns a
lineage:

| Session state | In the simulation |
| --- | --- |
| Appears | A founder spore drifts in near the colony's center |
| `busy` | Lineage fertility raised; it blooms and spreads |
| `idle` | Fertility lowered; it thins toward a few drifting adults |
| `waiting` | Render-level brightness pulse on all its organisms while `backdrop.waitingPulse` is on (no sim change) |
| Ends | Lineage released; its organisms age out normally |

A terminal's `done` status (4.8) is not a session state; its lineage behaves as `idle`.

- **Hue** is a stable FNV-1a hash of the session name, or of its lowercased cwd when unnamed, so
  a session keeps its color across restarts. The lineage keeps its founder's hue, and children
  inherit it unmutated, so every organism in the lineage matches the session's swatch in the
  dashboard panel.
- **Persistence.** A session lineage is protected from blights and is re-founded if its last
  organism dies while the session lives.
- **Changes to the copied code:** per-lineage fertility multipliers and blight immunity in
  `src/backdrop/sim/simulation.ts`, a per-lineage pulse attribute in the organism shader, and the
  `SessionColony` bookkeeping. All of it stays render-free in `src/backdrop/sim` except the pulse.

### 6.4 Performance

- The backdrop renders at up to `backdrop.maxFps` (section 8), 20 by default, or at the display's full
  frame rate when it is 0.
  The frame loop still runs on `requestAnimationFrame` and skips any frame that arrives sooner
  than `1 / maxFps` after the last rendered one. The simulation advances by elapsed time, so a
  cap lowers smoothness, not speed. The setting hot-reloads.
- `maxFps` is 0 (uncapped) or 20 to 240. The loop clamps each frame's delta to 1/20 s, so a cap
  below 20 would slow the simulation itself.
- `backdrop.animate: false` stops the frame loop and leaves the backdrop on a still frame, redrawn only
  when the window resizes. If it is off from launch, the opening dolly plays out first so the
  still shows a grown colony, not the lone founding spore. It hot-reloads; turning it back on
  resumes from the still.
- `setVisible(false)` on minimize, and when the window is fully covered (Tauri window events
  plus the page's `visibilitychange`), so it costs nothing while out of sight. The dashboard
  clock and System section (4.6) pause on the same signal.
- The backdrop's renderer is created with `preserveDrawingBuffer: false` and alpha disabled; the
  terminals composite over it through normal CSS stacking, with no readback.

## 7. Data model

The TypeScript types are the shapes; this section holds the rules they do not show.

| Shape | Defined in | Notes |
| --- | --- | --- |
| `Session`, `SessionStatus` | `src/sessions.ts` | The roster payload (3.2); `paneId` is null for sessions outside this app |
| `TerminalStatus` | `src/terminalStatus.ts` | Resolved as in 4.8 |
| `SavedWorkspace`, `SavedTab`, `SavedPane` | `src/savedWorkspace.ts` | `workspace.json` (3.7) |
| `DashboardSection`, `DashboardElement` | `src/dashboardSections.ts` | Collapse state and element order (4.6) |
| `Favorite` | `src/favorites.ts` | `favorites.json` (3.7), in display order |
| `NamedLayout` | `src/layouts.ts` | `layouts.json` (3.7), in display order |
| `RepoPins` | `src/repos.ts` | `repos.json` (3.7, 4.12) |
| `SearchOptions` | `src/searchOptions.ts` | An empty `include` glob searches every file |
| `Container`, `EngineState`, `ContainersSnapshot`, `ContainerStats` | `src/containers.ts` | `containers_list` and `containers://changed` (3.10) |
| `SystemSample`, `DiskRow` | `src/systemModel.ts` | `system_sample` (4.6); `disks` is null unless the call passed `includeDisks` |
| `ClaudeContext` | `src/claudeModel.ts` | `claude_context` and `claude://context` (3.4) |
| `ShellProfile` | `src/profiles.ts` | `shell_profiles` (3.1) |

**Session status.** A hook event newer than the roster's `statusUpdatedAt` wins; otherwise the
roster's value. `waiting` exists only from hooks, and clears on the next `UserPromptSubmit`,
`Stop`, or roster change to `busy`. The roster payload carries `waitingReason: string | null`
beside each session's status; it is the `Notification` message (3.3) and is present only while
the merged status is `waiting`. A terminal's `done` is `idle` after a `Stop`, or a long command
that finished, that the user has not looked at yet; `failed` is the same for a nonzero exit (4.8).

**workspace.json.** Version 3, tabs in strip order. Pane ids do not survive a restart, so panes
are saved under keys, and layout leaves hold those keys. A tab's `name` is null while it follows
its focused pane's title. A version 2 file's tabs hold `terminals`, which load as terminal panes;
a version 1 file, which holds one tab's `terminals`, `layout`, and `focused` at the top level,
loads as a single unnamed tab. Absent optional fields take these defaults:

- `dashboardWidth`: 300 px.
- `dashboardSectionOrder`: the default order. Reading keeps known names once each, drops unknown
  names and `repo`, and inserts a missing element at its default position relative to its
  neighbors.
- `dashboardClockTop`: true.
- `textZoom` (`filesList`, `filePreview`, `gitDiff`, the zoom new Files and Git panes start at,
  4.12, 4.13): 1 for an absent field or one outside 0.5 to 3.
- A terminal pane's `profile`: the default profile. A Files pane's `root`: resolved from its
  `folder`. Its `expanded`: false.

**layouts.json.** Names are unique without regard to case. A layout holds one tab whose
terminals carry no session ids and whose scratch pads have a null `scratchId`, so they open
fresh; the tab's own `name` is ignored, since it takes the layout's. An entry whose `workspace`
holds a version 1 workspace loads as that one tab.

**repos.json.** Roots compare without regard to case. A pin's path is relative to the root, with
forward slashes, when inside the repo, else absolute. `primaryBranch`, the branch the Repo
section compares worktrees with (4.6), is keyed by the main worktree's path; an entry may hold
it with no pins, and Automatic omits it.

## 8. Settings

```jsonc
{
  "shell": {
    "path": "C:\\Program Files\\Git\\bin\\bash.exe",
    "args": ["--login", "-i"],
    "startingDirectory": "%USERPROFILE%",
    // gitBash, pwsh, powershell, or cmd. path and args configure Git Bash only. An unknown or
    // unavailable value falls back as described in 3.1.
    "defaultProfile": "gitBash"
  },
  "font": { "family": "JetBrainsMono Nerd Font Mono, Cascadia Mono", "size": 14 },
  "scrim": { "opacity": 0.5, "blurPx": 0 },
  // maxFps 0 renders the backdrop at the display's refresh rate; animate false freezes it (6.4).
  // The rest are the simulation and camera controls (6.2).
  "backdrop": {
    "animate": false,
    "maxFps": 20,
    "capacity": 1000,
    "mutationRate": 0.2,
    "zoom": 2,
    "waitingPulse": false
  },
  "scrollback": 10000,
  // A shell command that runs this many seconds and finishes unseen marks its terminal done or
  // failed; 0 turns it off (4.8).
  "terminal": { "doneAfterSeconds": 30 },
  // side is right or left; an unknown value falls back to right. sections shows or hides each
  // dashboard element (4.6); sections.containers also decides whether the kind menu offers a
  // Containers pane. An older file's containers.enabled is still read when sections.containers
  // is absent.
  "dashboard": {
    "visibleOnStart": true,
    "peekOnWaiting": true,
    "side": "right",
    "sections": {
      "favorites": true,
      "layouts": true,
      "panes": true,
      "containers": true,
      "external": true,
      "system": false,
      "clock": false
    }
  },
  "restore": { "enabled": true, "resumeClaude": true },
  // zed, vscode, cursor, visualStudio, notepadpp, sublime, rider, intellij, webstorm,
  // pycharm, rustrover, goland, clion, phpstorm, windsurf, vscodeInsiders, vscodium, or default
  // (the file's default app). A non-empty command replaces it, with {path} and {line} filled in
  // (3.12).
  "editor": { "preferred": "default", "command": "" },
  // Minutes between background fetches of repos with an open Git pane; 0 turns it off (3.9).
  "git": { "autoFetchMinutes": 5 },
  // Added to or overriding the defaults in 4.5. Actions that take an argument take it as
  // a field: switchToTab takes "index" from 1 to 8. The shortcut guide (F1) edits this list,
  // rewriting it with one entry per line; comments inside the list are not kept, comments
  // elsewhere in the file are.
  "keybindings": [
    { "keys": "ctrl+alt+d", "action": "splitAuto" },
    { "keys": "ctrl+w", "action": "unbound" }
  ]
}
```

The file written on first run has an empty `keybindings` array, so changes to the built-in
defaults reach existing settings files.

Unknown keys are ignored and invalid values fall back to defaults with a one-time toast
naming the bad field. A file that is not valid JSON (or not a JSON object) loads as all
defaults at launch; a save that breaks it mid-session keeps the running settings, with a
toast, until the file is fixed.

## 9. Security

- The hook endpoint listens on loopback only and requires the per-launch token; the token
  lives only in pane environments and in memory. Its `/cli` path (3.13) carries out only
  actions the UI already offers, with the same path checks.
- Tauri capabilities stay minimal: the app's own commands plus `core:default` and
  `core:window:allow-destroy` (closing the window after the workspace is saved) and
  `core:window:allow-request-user-attention` (the taskbar flash). No shell, fs,
  or http plugins are exposed to the page.
- A strict CSP in release builds (`default-src 'self'`; scripts, fonts, and styles
  self-hosted, with inline `<style>` elements allowed because xterm.js injects them), so a
  malicious escape sequence that somehow injected markup could not load remote code.
  xterm.js renders terminal output as text, never HTML.
- Hyperlinks in terminal output, both detected URLs (the xterm web-links addon) and OSC 8
  hyperlinks, open only `http` and `https` URLs, through the system browser, on Ctrl+click.
- Markdown is the only file content rendered as HTML: `markdown-it` with raw HTML off, then
  `DOMPurify`, with no remote images and links opened only through `open_url` (4.12).
- The file commands (3.8) normalize every path, write only to existing files, and create or
  delete only the app's own scratch files.
- `git`, `docker`, and `podman` run with argument lists, never through a shell, and paths come
  after `--` where the CLI accepts it. `open_in_editor` runs only a detected editor or the
  user's own `editor.command`.

## 10. Testing

Pure modules (no DOM) carry the logic worth testing and are covered by Vitest beside each
module (`src/**/*.test.ts`); the Rust core's tests sit in each module and run against temp
folders, temp repos, captured CLI output, and a spawned pty. Keys are the exception: what
reaches the shell through WebView2 and xterm.js can only be checked by hand, with the keyboard
checklist in [development.md](development.md#releasing) before each release.

CI: a GitHub Actions workflow (`.github/workflows/ci.yml`) on `windows-latest` runs the type
check, Vitest, `cargo test`, and `pnpm tauri build`, then uploads the NSIS installer as the
`bashboard-installer` artifact.

## 11. Risks

- **Undocumented session files.** If Claude Code changes `~/.claude/sessions`, the roster
  degrades to showing only hook-reported sessions in this app's panes. Parsing is lenient and
  failures are logged, never fatal.
- **WebGL contexts.** Many panes plus the backdrop approach Chromium's limit; the budget and DOM
  fallback in 4.4 cover it, at some cost in rendering speed for the extra panes.
- **GPU cost.** The backdrop plus bloom behind several WebGL terminals is the heaviest part of the
  app. The visibility pausing in 6.4 means it costs nothing while hidden, and `backdrop.maxFps`
  trims it on weaker GPUs.
- **Resume.** Restore types `claude --resume <sessionId>`; if that session's transcript is
  gone, the command fails visibly in its terminal rather than silently.
- **Off-screen output.** Collapsed terminals and those in background tabs keep parsing output
  into off-DOM xterm instances; a very chatty one costs parse time, though no rendering.
- **Container CLI output.** The JSON from `docker ps` and `podman ps` is not a stable
  contract, and the two differ. Each engine's parser treats every field as optional, so a
  format change degrades a row rather than the list.
- **Edits racing Claude.** A file can change between a Files pane's read and its save. The
  modified-time check in `fs_write_text` turns that into the Reload or Keep mine choice (4.12)
  instead of a silent overwrite.
- **Ctrl+W.** Bound to close pane (as in the current Windows Terminal setup), so bash's
  delete-previous-word is unavailable unless the settings file unbinds it.
