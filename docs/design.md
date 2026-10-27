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
  PowerShell reports nothing by default; the README's profile snippet adds OSC 9;9 only. The
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
  | `Notification` | `waiting` (permission prompt or idle prompt); carries `message` |
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
  success. The receiver keeps only `session_id`, `hook_event_name`, `cwd`, and `message`, and
  emits `sessions://hook` with those fields plus the pane id from the header and the receive
  time.

### 3.4 Pane to session binding

A session is bound to a pane by, in order:

1. The `X-Bashboard-Pane` header on its hook events.
2. Process ancestry: walking parents from the session's `pid` (via `sysinfo`) until reaching a
   pane's shell pid, for sessions started before hooks were installed.

Sessions that bind to no pane are external (Windows Terminal, VS Code) and appear in the
roster without a pane link.

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
| `workspace.json` | `workspace_load`, `workspace_save` | Open tabs, their panes, and layouts (section 7), for restore (4.9) |
| `favorites.json` | `favorites_load`, `favorites_save` | Favorite folders (4.6) |
| `layouts.json` | `layouts_load`, `layouts_save` | Named layouts (4.6) |
| `repos.json` | `repos_load`, `repos_save` | Pinned files and folders per repo (4.12) |

The core treats all four as opaque JSON; the front end owns their shape and validation.
`favorites.json`, `layouts.json`, and `repos.json` are hand-editable, so they are watched and
hot-reloaded like `settings.json`, emitting `favorites://changed`, `layouts://changed`, and
`repos://changed`. They are kept out of `settings.json` because the app rewrites them from the
dashboard, and rewriting a hand-edited JSONC file would drop its comments.

Scratch pads (4.15) live beside them as `scratch/<id>.txt`, written by `scratch_save(id, text)`
and removed by `scratch_delete(id)`; `scratch_load(id)` reads one back on restore.

### 3.8 Repo files (`src-tauri/src/files.rs`)

A path's repo is the nearest folder at or above it holding `.git` (a directory, or the file a
worktree has); a folder in no repo is its own repo, without git.

| Command | Purpose |
| --- | --- |
| `repo_root(path) -> { root, isGit, branch? }` | The repo a folder belongs to |
| `fs_list(dir) -> Entry[]` | Folders, then files, each with name, size, and modified time |
| `fs_read_text(path) -> { text, modified }` | Up to 2 MiB; a file with a NUL byte in its first 8 KiB is refused as binary |
| `fs_write_text(path, text, expectedModified)` | Writes through a temp file and a rename; refused when the file's modified time differs from `expectedModified`, so a save never overwrites a change made on disk since the read |
| `fs_move(path, toDir)` | Moves a file into another folder; refused when the target name exists |
| `fs_watch(dir, onChange) -> id`, `fs_unwatch(id)` | One folder, not recursive, debounced 200 ms |

Paths must be absolute and are normalized before use, so `..` segments cannot step outside the
folder they name. `fs_write_text` and `fs_move` work on any existing file, and nothing creates or
deletes files except the scratch commands above.

### 3.9 Git (`src-tauri/src/git.rs`)

Runs `git` (from `PATH`, else beside Git Bash's `bash.exe`) as `git -C <root> ...` with an
argument list, never through a shell, and with paths after `--`. Reads set
`GIT_OPTIONAL_LOCKS=0`, so a status refresh never takes the index lock while Claude runs its
own git commands.

| Command | Runs |
| --- | --- |
| `git_status(root)` | `status --porcelain=v2 --branch -z`: branch, upstream, ahead and behind, staged, unstaged, and untracked entries |
| `git_stage(root, paths)` | `add --` |
| `git_unstage(root, paths)` | `restore --staged --`, or `rm --cached --` in a repo with no commits |
| `git_diff(root, path, staged)` | One file's diff, capped at 1 MiB; an untracked file diffs against nothing |
| `git_log(root, count)` | The last commits: hash, subject, author, time, and whether any remote-tracking branch contains each |
| `git_show(root, hash)` | One commit's diff, capped at 1 MiB |
| `git_commit(root, message)` | `commit -F -` with the message on stdin; the repo's hooks run as usual |
| `git_undo_commit(root, expectedHead) -> message` | `reset --soft HEAD~1`, returning the undone commit's message |
| `git_watch(root)` | Starts (or shares) the metadata watcher below |
| `git_unwatch(root)` | Releases one reference to that watcher |

`git_undo_commit` is refused when HEAD is not `expectedHead`, has no parent, or when a merge,
rebase, cherry-pick, or revert is in progress. A pushed commit can be undone; republishing the
branch then takes a force push, which the pane leaves to the user. A soft
reset moves only the branch; the working tree and index are untouched, so the commit's changes
stay staged.

`git_watch(root)` and `git_unwatch(root)` run a watcher on the repo's git metadata and its
worktree. Metadata is `HEAD` and `index` in the git dir and `packed-refs` and `refs` in the
common dir, never `objects/`. The worktree is watched recursively; a change there counts unless
its path is inside a `.git` or ignored by the repo's `.gitignore` files, `info/exclude`, or the
global excludes file, so a build writing to an ignored folder does not refresh the pane. Watchers
are reference-counted per normalized root, so Git panes on one repo share one. A change emits
`git://changed` with the root, debounced 300 ms for metadata and 1 second for the worktree, and
at most 3 seconds after the first change while changes keep arriving.

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
| `default` | The file's default app | Opened through the shell (no line) |

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
`shell_integration_preview` and `shell_integration_install`. The lines are the snippet in the
README's "New panes in the current folder" section; a test requires the two to match byte for
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
workspace is up, quietly, and again from the settings dialog's Check for updates button, which
also reports "up to date" and failures. It does nothing in a dev build, which has no installed
bundle to replace. An available update shows as a banner (`updateNotice.ts`) with Install and
restart and Later. Installing first asks for confirmation through the shared confirm dialog,
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
installer, its `.sig`, and `latest.json`. A step then checks that `bb.exe` was built and is
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
- The tree is pure data with its own module (`layout.ts`) and unit tests, including the
  remove, insert-at-edge, insert-at-root-edge, and swap operations docking uses; DOM rendering
  is a separate module that rebuilds from the tree on change.

**Duplicating the working directory.** A new pane or tab starts in the focused pane's current
directory, read from OSC 9;9 (what Windows Terminal uses) or OSC 7 sequences that xterm.js
handlers capture. Git Bash emits neither by default, so the README documents a `~/.bashrc`
addition that also emits the OSC 133 command markers terminal status uses (4.8):

```sh
PS0='\e]133;C\e\\'
PROMPT_COMMAND='printf "\e]133;D;%s\e\\" "$?"; printf "\e]9;9;%s\e\\" "$(cygpath -w "$PWD")"'"${PROMPT_COMMAND:+;$PROMPT_COMMAND}"
```

Without it, new panes start in the home directory. The `133;D` printf comes first so `$?` is
still the finished command's exit code.

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
the strip is the drag handle for docking. Every pane kind
has the same strip, with its own title and no status dot. With two or more panes in the tab the strip
sits in the layout above each terminal. A lone pane's strip is an overlay, so it never reflows
the terminal; it is invisible until the pointer enters its own top band, so the pointer resting
elsewhere in the terminal never covers the first row.

**Find bar** (`findBar.ts`): Ctrl+Shift+F opens one bar over the top-right corner of the
focused pane, or refocuses its input if it is already open. Matching is case-insensitive and
runs as you type, with Enter for the next match and Shift+Enter for the previous. The count
reads "n of m" or "No results". Esc closes the bar, clears the highlights, and returns focus
to the terminal. Closing the pane, collapsing it, moving focus to another pane, or switching
tabs also closes the bar.

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
| Ctrl+Shift+P | Open a named layout (picker; opens it as a new tab, 4.6) |
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
| Ctrl+Shift+F | Find in scrollback |
| Ctrl+C | Copy if there's a selection, otherwise pass ^C |
| Ctrl+Shift+C | Copy |
| Ctrl+V, Ctrl+Shift+V | Paste text (bracketed when the app enabled it); with no text on the clipboard, pass ^V so Claude Code can paste an image |
| Shift+Enter | Send ESC+CR (Claude Code's newline) |
| Ctrl+Shift+S | Toggle dashboard panel |
| Ctrl+Shift+B | Cycle backdrop scrim strength (saved to `scrim.opacity`) |
| Ctrl+Shift+L | Pause or resume the background animation (saved to `backdrop.animate`) |
| Ctrl+= or Ctrl+Numpad+ | Increase the terminal font size by 1 px (saved to `font.size`; applies to every terminal; 6 to 48 px) |
| Ctrl+- | Decrease the terminal font size by 1 px (saved to `font.size`; applies to every terminal; 6 to 48 px) |
| Ctrl+0 | Reset the terminal font size to the default, 14 px (saved to `font.size`; applies to every terminal) |
| F1 | Show the keyboard shortcut guide (built from the live keymap, so overrides show) |
| Ctrl+, | Open the settings dialog |
| F11 | Toggle full screen |

These are built-in defaults. Entries in the settings file (section 8) layer on top, as in
Windows Terminal: an entry for a chord that has a default replaces it, a new chord adds a
binding, and `"action": "unbound"` removes a default so the key reaches the shell.

In panes other than terminals, copy, paste, Shift+Enter, Ctrl+Shift+F, and typing act on the
pane's own text fields as a browser would; every other action applies as it does in a
terminal.

### 4.6 Dashboard panel

A collapsible panel on the right edge, open on start by default, toggled with Ctrl+Shift+S, hidden
by a × button at its top right (which also ends a peek), and peeking open briefly while hidden when a terminal starts waiting.
Dragging its left edge resizes it, from 280 px (enough for the Repo section's row of buttons on
one line) up to 60% of the window, and the width is saved with the workspace (section 7). Its sections, top to bottom,
are Repo, Favorites, Layouts, Panes, Containers, and External sessions. Repo, which follows the
focused pane, sits at the top; the rest of the sections and the footer sit at the bottom, so a
focus change never shifts them. Clicking a section's header
collapses or expands it, and which sections are collapsed is saved with the workspace
(section 7). A thin rule separates each section from the one above it.

Folder paths under row labels show the home folder as `~`, and an overlong path is cut from the
left so its last folders stay visible; hovering shows the full path.

Every favorite, recent folder, pane card, and external session row shows a folder button on
hover that opens its folder in File Explorer (`open_folder`, which accepts only an existing
absolute directory). Beside it, an Open menu lists Terminal, Files, Git, Search, and Editor,
each opening for that row's repo (4.11); Git is listed only for a git repo.

**Repo.** The repo (3.8) of the focused pane's folder, or of the last focused pane that had
one. A Files pane counts as the repo it was opened for, not the folder it is showing, so opening
a pinned subfolder keeps the section on its repo. The header shows the repo folder's name and, for a git repo, its branch; while the panel is open
the repo is re-read every 3 seconds, so a checkout in any shell shows up without a folder change.
Under it, a row of buttons opens a Terminal, Files, Git, or Search pane for the repo, or opens it
in the editor (3.12). Then come the repo's pins (4.12), each showing a file or
folder icon and its label or path; clicking one opens it, and pins reorder by drag and can be
renamed and removed. The section is hidden until some pane has a folder.

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
- Rows can be renamed and removed; removing asks inline first. Ctrl+Shift+P opens a picker over
  the layouts that opens the selection the same way.

**Panes.** One card per pane in this app, of any kind (4.11), expanded or collapsed, grouped by
tab. Groups follow the tab strip's order, and within a group cards are in the order their panes
were opened or moved into the tab. The order stays fixed as statuses change so a card never
moves out from under the pointer.

With two or more tabs, each group has a header showing the tab's name and its pane count, with
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
  accent color), or `done` (a still check mark), plus the attention pulse (4.7). Other kinds
  show their kind's icon.
- The bound Claude session's name, or the working directory's last folder, with the full path
  beneath. Other kinds show the pane's title (4.11) and its folder, if any.
- For a terminal, time since the last status change.
- A profile badge when the terminal's shell is not Git Bash.
- Whether it is expanded or collapsed. Clicking an expanded card switches to its tab if needed
  and focuses its pane; clicking a collapsed one expands it (4.3).
- A close button, which asks first if a command or Claude session is running, or if a scratch
  pad is not empty.

**Containers.** One row per container group (4.16) with its state dot, and an Open Containers
button in the header. Shown while a container engine is available (3.10) and
`containers.enabled` is on.

**External sessions.** Claude Code sessions running outside this app (Windows Terminal, VS
Code), sorted waiting, then busy, then idle, then by most recent change. Clicking a row shows
its cwd and session id with copy buttons. The section is hidden while there are none.

**Footer.** Three buttons sit at the bottom of the panel. Install Claude Code hooks is shown only
while Claude Code is detected and the hooks are not installed (3.3). Keyboard shortcuts opens the help dialog, also bound to
F1. Settings opens the settings dialog, also bound to Ctrl+,.

The settings dialog edits every user-facing setting except keybindings, in the sections
Appearance, Backdrop, Terminal, Editor, Dashboard, and Restore. Terminal includes a Default shell select listing the available profiles. Editor
selects the preferred editor from those found (3.12), plus a custom command field. A Run setup
button reopens the setup wizard (4.17). Each change is written to settings.json
through the app, so the file's comments survive. Toggles save immediately; number and text fields
save on blur or Enter; the shell arguments list (one argument per line) saves on blur or
Ctrl+Enter; sliders save shortly after the drag stops and show the live value. Invalid input (out
of range, empty, or not a number) shows an inline error and is not saved, and a failed save shows
an inline error too. When settings.json changes on disk while the dialog is open, every control
except the focused one refreshes. Fields that do not apply live say so beside the control:
dashboard.visibleOnStart and restore.* apply at the next launch, and shell.* applies to panes
opened afterward. Warnings about the current settings appear at the top of the dialog. The
Open settings.json button in the footer opens the file in the default editor, with a note that
keybindings are edited there. Escape or a click outside the dialog closes it.

A peek overlays the panes without narrowing them. It ends after a few seconds, but stays
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
- A terminal the user is already looking at (the focused, expanded pane of the active tab in a
  focused window) is not marked. Attention clears when the pane becomes that focused pane,
  including when switching to its tab or when the window regains focus with it focused.
- If the window is unfocused, the taskbar button flashes. A toast is not sent, because the
  existing `Notification` hook already raises one.

`done` (4.8) is quieter: it changes the status dot on the title strip, card, tab, and group
header, and nothing else. It raises no attention, so no pulse, taskbar flash, or panel peek.

### 4.8 Terminal status

Every terminal is `idle`, `working`, `waiting`, or `done`, resolved in order:

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

**Done.** When a bound session's `Stop` hook arrives while its terminal is not the one being
looked at (the focused, expanded pane of the active tab in a focused window, as in 4.7), the
terminal shows `done` instead of `idle` until it becomes that pane. Any later status (a new
prompt, `waiting`, the session ending) replaces it. Only `Stop` sets it: a plain shell's command
finishing does not, and neither does a roster change to `idle`. `done` is display state only;
the session stays `idle`, and the backdrop never sees it (6.3). It is not saved, so restored terminals
start without it.

### 4.9 Restore

The front end saves the workspace (3.7, shape in section 7) one second after any change to the
tabs, layouts, collapsed terminals, working directories, or session bindings, and again when
the window closes. On launch:

- Each saved terminal gets a new shell of its saved profile (the default profile when none is
  saved or the profile is unavailable) in its saved directory, or in `startingDirectory` if that
  folder no longer exists. Each tab's layout and collapsed terminals are rebuilt around the new
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
terminals (`waiting`, then `done`, then `working`, then `idle`), its name, and a close button on hover. A
"+" at the end of the strip opens a new tab.

- Clicking a tab switches to it. Double-clicking its name renames it inline; Enter or blur
  saves, Esc cancels. Tabs reorder by drag, and the dashboard's groups follow.
- Holding a dragged pane or card over a tab for half a second switches to that tab, so the
  drag can continue into a dock target there (4.2) and move the terminal across tabs.
- The strip is chrome on z3 and draws over the backdrop with the same scrim as the title strips.

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
  default profile.
- **Opening.** Ctrl+Shift+N, E, G, and H (4.5), the Repo section, and the Open menu on dashboard
  rows (4.6) open a pane as a split of the focused pane, the way a favorite does: when there is
  no room, a toast says so and the pane opens collapsed. A Git pane for a repo that already has
  one in the active tab focuses that one instead.
- **Common behavior.** Every kind has the title strip, scrim, focus border, docking, collapsing,
  and closing that terminals have. Status, attention, and the WebGL budget apply to terminals
  only. A tab's status dot comes from its terminals; its name follows the focused pane's title,
  which for other kinds is the folder's name, a scratch pad's first line, or "Containers".
- **Restore.** Each kind saves its state with the workspace (section 7): a Files pane's folder
  and selected file, a Git pane's repo, a Search pane's repo, query, and options (rerun on
  restore), and a scratch pad's text. A pane whose folder no longer exists opens on a notice
  naming the path, with the kind menu still available.
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
- **Plain text** (`.txt`, or no extension) opens in the text editor.
- **Other text files** show read-only, monospaced, with line numbers.
- **Binary files, and files over 2 MiB,** show their name, size, and an Open in editor button.

**Text editor.** A monospaced text area. It saves one second after typing stops, on blur, and
on Ctrl+S, through `fs_write_text` with the modified time it last read. When the file changes on
disk and there are no unsaved edits, it reloads in place, so a to-do list Claude edits updates
in front of you. With unsaved edits, a bar offers Reload (discarding them) or Keep mine
(overwriting the file).

**Rows.** Clicking a row selects it; double-clicking a folder opens it, and double-clicking a
file opens it in the editor (3.12). Each row's hover menu has:

- Open terminal here (folders only): a new terminal of the default profile in that folder, as a
  split of the Files pane.
- Open in editor.
- Copy path.
- Insert path: pastes the repo-relative path into the tab's most recently focused terminal,
  as a bracketed paste without Enter, then focuses that terminal.
- Move to: the repo's pinned folders and the current folder's subfolders (`fs_move`).
- Pin.

The breadcrumb also has an Open terminal here button for the current folder.

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

- **Branch** with its upstream and the ahead and behind counts.
- **Commit box.** A message field and a Commit button (Ctrl+Enter in the field), enabled while
  something is staged and the message is not empty. A failed commit (a hook rejecting it, for
  example) shows git's output under the box and keeps the message.
- **Staged** and **Changes** lists. Changes holds unstaged and untracked files. Each row shows
  its status letter and path, with stage or unstage and Open in editor on hover; each list's
  header has Stage all or Unstage all. Clicking a row shows its diff.
- **Recent commits:** the last 20, each with subject, short hash, relative time, and a mark when
  no remote-tracking branch contains it. Clicking one shows its diff.

Diffs show in a panel beside the lists, unified, with added and removed lines colored and hunk
headers kept. A diff over the cap says so.

**Undo commit** sits in a bar above the diff while the selected commit is the newest one and
HEAD. It asks
first, naming the commit, noting that its changes stay staged, and warning when the commit is
already pushed that a force push will follow; then it runs `git_undo_commit`
(3.9) with the hash the pane showed, and puts the undone message into the commit box, above any
draft already there. The refusal cases in 3.9 show as an inline error beside the button.

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
file's group header has the same Open button on hover, opening the file with no line.

### 4.15 Scratch pads

A scratch pad is an untitled text area, like a new tab in Notepad++, in the terminal font. Its
title is its first non-empty line, shortened, or "Scratch". It saves to `scratch/<id>.txt` (3.7)
half a second after typing stops and comes back on restore.

- **Send** (Ctrl+Enter) pastes the whole text into the tab's most recently focused terminal as a
  bracketed paste without Enter, so a prompt can be drafted here and reviewed before sending,
  then focuses that terminal. It is disabled while the tab has no terminal.
- **Copy** copies the whole text. **Clear** empties it.
- **Save as** writes it to a file chosen in the native save dialog, opened from the core.

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
  /** `backdrop.speed`, `capacity`, `mutationRate`, `lineageThreads`, `orbit`, `zoom`, and `waitingPulse`. */
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

The simulation and camera controls are settings (section 8), all hot-reloaded: speed
in generations per second (0.25 to 12, default 2), population capacity (300 to 5000, default
5000), mutation rate (0 to 4, default 4), lineage threads (default off), and auto-orbit (default
on, and held still while the OS asks for reduced motion). Two more: zoom
(0.5 to 3, default 1) divides the camera's home distance, so the colony fills more of the window,
and the camera glides to a changed value; `waitingPulse` (default off) turns on the waiting
pulse below. The settings dialog groups them with
`backdrop.animate`, `backdrop.maxFps`, and the scrim under "Background Animation"; the UI calls
the backdrop the background animation. While `backdrop.animate` is off, the dialog hides the
fields a still frame can't show (the frame rate cap, the simulation controls, auto-orbit, and
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
  plus the page's `visibilitychange`), so it costs nothing while out of sight.
- The backdrop's renderer is created with `preserveDrawingBuffer: false` and alpha disabled; the
  terminals composite over it through normal CSS stacking, with no readback.

## 7. Data model

```ts
type SessionStatus = 'busy' | 'idle' | 'waiting' | 'unknown';

interface Session {
  sessionId: string;
  pid: number;
  name: string | null;
  cwd: string;
  status: SessionStatus;
  /** Raw status string when status is 'unknown'. */
  rawStatus?: string;
  statusChangedAt: number; // epoch ms
  startedAt: number;
  version: string | null;
  /** Bound pane, or null for sessions running outside this app. */
  paneId: number | null;
}
```

Status resolution: a hook event newer than the roster's `statusUpdatedAt` wins; otherwise the
roster's value. `waiting` exists only from hooks, and clears on the next `UserPromptSubmit`,
`Stop`, or roster change to `busy`.

```ts
/** 'done' is 'idle' after a Stop the user has not looked at yet (4.8). */
type TerminalStatus = 'idle' | 'working' | 'waiting' | 'done';

interface Terminal {
  paneId: number;
  /** The tab it belongs to (4.10). */
  tabId: string;
  /** From OSC 9;9 or OSC 7, else the directory it was opened in. */
  cwd: string;
  collapsed: boolean;
  status: TerminalStatus; // resolved as in 4.8
  statusChangedAt: number;
  /** Set by waiting or the bell; cleared when the terminal is focused. */
  attention: boolean;
  sessionId: string | null;
}

interface SearchOptions {
  caseSensitive: boolean;
  wholeWord: boolean;
  regex: boolean;
  /** Glob; empty searches every file. */
  include: string;
}

/** One pane (4.11). Pane ids do not survive a restart, so entries use saved keys. */
type SavedPane = { key: string; collapsed: boolean } & (
  | {
      kind: 'terminal';
      cwd: string;
      sessionId: string | null;
      /** Shell profile id; absent means the default profile. */
      profile?: string;
    }
  /** `root`: the repo the pane was opened for; absent, it resolves from `folder`. */
  | { kind: 'files'; folder: string; selected: string | null; root?: string }
  | { kind: 'git'; root: string }
  | { kind: 'search'; root: string; query: string; options: SearchOptions }
  /** null in layouts, which open fresh pads. */
  | { kind: 'scratch'; scratchId: string | null }
  | { kind: 'containers' }
);

/** One tab (4.10). */
interface SavedTab {
  /** A name the user or a layout fixed; null follows the focused pane's title. */
  name: string | null;
  panes: SavedPane[];
  /** Leaves' paneId fields hold pane keys. */
  layout: Layout | null;
  focused: string | null;
}

type DashboardSection = 'repo' | 'favorites' | 'layouts' | 'panes' | 'containers' | 'external';

/**
 * workspace.json (3.7), tabs in strip order. A version 2 file's tabs hold `terminals`, which
 * load as terminal panes. A version 1 file, which holds one tab's `terminals`, `layout`, and
 * `focused` at the top level, loads as a single unnamed tab.
 */
interface SavedWorkspace {
  version: 3;
  tabs: SavedTab[];
  /** Index into tabs. */
  activeTab: number;
  /** Dashboard sections collapsed by the user (4.6). */
  collapsedSections: DashboardSection[];
  /** Dashboard width in px as last dragged (4.6); absent means the 300 px default. */
  dashboardWidth?: number;
}

/** favorites.json (3.7), in display order. */
interface Favorite {
  label: string;
  path: string;
  /** Shell profile id; absent means the default profile. */
  profile?: string;
}

/**
 * layouts.json (3.7), in display order. Names are unique without regard to case. An entry
 * whose `workspace` holds a version 1 SavedWorkspace loads as that one tab.
 */
interface NamedLayout {
  name: string;
  /** Every terminal's sessionId is null; name is ignored, since the tab takes the layout's. */
  tab: SavedTab;
}

/**
 * repos.json (3.7): pins per repo (4.12). Roots compare without regard to case. A pin's path
 * is relative to the root, with forward slashes, when inside the repo, else absolute.
 */
interface RepoPins {
  root: string;
  pins: { path: string; label?: string }[];
}
type ReposFile = RepoPins[];

/** A container from either engine (3.10). */
interface Container {
  engine: 'docker' | 'podman';
  id: string;
  name: string;
  image: string;
  state: 'running' | 'paused' | 'exited' | 'created' | 'restarting' | 'dead' | 'unknown';
  /** The engine's own text, e.g. "Up 3 hours". */
  statusText: string;
  ports: { host: number; container: number; protocol: string }[];
  project: string | null;
  service: string | null;
}

/** An engine whose CLI was found on `PATH` (3.10); `running` is whether its daemon or machine answers. */
interface EngineState {
  engine: 'docker' | 'podman';
  running: boolean;
}

/** The result of `containers_list` and the payload of `containers://changed` (3.10). */
interface ContainersSnapshot {
  engines: EngineState[];
  containers: Container[];
}

/** One `stats --no-stream` sample (3.10); a null field is one the output did not give. */
interface ContainerStats {
  engine: 'docker' | 'podman';
  id: string;
  cpuPercent: number | null;
  /** The engine's own usage text, e.g. "12.5MiB / 7.6GiB". */
  memUsage: string | null;
  memPercent: number | null;
}

/** A shell a terminal can run (3.1), from `shell_profiles`. */
interface ShellProfile {
  id: 'gitBash' | 'pwsh' | 'powershell' | 'cmd';
  name: string;
  path: string;
  args: string[];
}
```

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
  // speed is generations per second; the rest are the simulation and camera controls (6.2).
  "backdrop": {
    "animate": false,
    "maxFps": 20,
    "speed": 10,
    "capacity": 1000,
    "mutationRate": 0.2,
    "lineageThreads": false,
    "orbit": true,
    "zoom": 2,
    "waitingPulse": false
  },
  "scrollback": 10000,
  "dashboard": { "visibleOnStart": true, "peekOnWaiting": true },
  "restore": { "enabled": true, "resumeClaude": true },
  // zed, vscode, cursor, visualStudio, notepadpp, sublime, or default (the file's default
  // app). A non-empty command replaces it, with {path} and {line} filled in (3.12).
  "editor": { "preferred": "default", "command": "" },
  // false hides the Containers section; the Containers pane still opens on request (4.16).
  "containers": { "enabled": true },
  // Added to or overriding the defaults in 4.5. Actions that take an argument take it as
  // a field: switchToTab takes "index" from 1 to 8.
  "keybindings": [
    { "keys": "ctrl+shift+d", "action": "splitAuto" },
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

| Area | How |
| --- | --- |
| Layout tree | Vitest: split, close, resize clamping, focus movement, docking (remove, insert at edge, insert at a window edge with its share and minimum, swap) |
| Terminal status | Vitest: resolution order in 4.8, OSC 133 transitions, activity sweep fallback, `done` set only by an unseen `Stop` and cleared on looking or a later status |
| Zoom | Vitest: zoom state per tab, ending on tree changes and focus moves, no zoom with one pane |
| Pane CLI | Rust: argument parsing, relative path resolution, the `/cli` answer codes; Vitest: each command dispatching to the same action as its UI counterpart |
| Saved workspace | Vitest: save and restore round trip, pane id remapping, missing folder fallback, version 1 files and layouts loading as one tab |
| Tabs | Vitest over the pure tab model: add, close (neighbor activation, last tab), reorder, move a terminal between tabs (closing an emptied tab), name following and fixing, combined status |
| Key mapping | Vitest: event to action table, including the keypress swallowing |
| Roster parsing | Rust unit tests over captured session files, including malformed and unknown status |
| Hook receiver | Rust tests: token rejection, size limit, field filtering |
| Pty | Rust integration test: spawn `bash -c 'echo hi'`, read output, observe exit |
| Backdrop | The copied sim's Vitest suite plus tests for `SessionColony` |
| Pane kinds | Vitest: workspace version 3 round trip with every kind, version 2 files loading as terminals, layouts saving scratch pads empty, replacing a pane's kind in place |
| Repo files | Rust over temp folders: repo root detection (a `.git` folder and a worktree's `.git` file), binary refusal, write refused after a change on disk, move refused over an existing name |
| Git | Rust against temp repos: porcelain v2 parsing, staging in a repo with no commits, undo allowed when pushed (to a local bare remote), refused mid-merge or after HEAD moved |
| Code search | Rust over a temp tree: `.gitignore` honored, options, the match cap, cancellation |
| Containers | Rust: parsing captured `docker ps` and `podman ps` JSON, Compose labels from both; Vitest: grouping, group state, merging same-named groups for the dashboard |
| Editors | Rust: the argument form for each editor, filling `editor.command` |
| Setup wizard | Vitest: step visibility, favorites added without duplicates, scrim preset matching, editor choices; Rust: repo candidates over a temp folder, firstRun only when the file was created |
| End to end | Manual keyboard checklist (Ctrl+F/R/P, Alt+B/F, Shift+Enter, Esc, copy and paste, resize) run before each release |

CI: a GitHub Actions workflow (`.github/workflows/ci.yml`) on `windows-latest` runs the type
check, Vitest, `cargo test`, and `pnpm tauri build`, then uploads the NSIS installer as the
`bashboard-installer` artifact.

## 11. Milestones

Each milestone ends with a usable app.

1. **Panes.** Layout tree, splits, close, focus, resize, keybindings from settings, OSC 9;9
   working directory, WebGL budget fallback. Placeholder gradient backdrop.
2. **Backdrop.** The colony sim and renderer in `src/backdrop/`, `backdrop.ts` and
   `mountBackdrop`, scrims and the scrim cycle key, visibility pausing, the `backdrop.maxFps`
   frame cap.
3. **Session roster.** Watcher, liveness, ancestry binding to panes, and the dashboard panel's
   Terminals and External sessions sections.
4. **Dashboard.** Collapse and expand, docking by drag, favorites and recent folders, shell
   status from OSC 133 and the activity sweep, workspace save and restore with Claude resume.
5. **Hooks.** Receiver, hook script, the install command, `waiting` status, attention
   (border and card pulse, taskbar flash).
6. **Sessions as organisms.** `SessionColony` in the copied sim, hue matching, moods and pulses.
7. **Polish and release.** Settings hot reload, find addon, hyperlinks, CSP, installer via
   `tauri build`, CI.
8. **Tabs.** The tab model and strip, per-tab layouts, focus, and WebGL budget, the tab
   keybindings (with the shell picker on Alt+Shift+T), grouped Terminals cards, attention on
   tabs, moving terminals between tabs, workspace version 2, and layouts that open as tabs.
9. **Pane kinds.** Panes of more than one kind (4.11) with the kind menu, scratch pads (4.15),
   the Panes section's cards for every kind, collapsible dashboard sections, workspace version
   3, and layouts holding any kind.
10. **Repo files.** Repo detection (3.8), the Repo section, pins and `repos.json`, the Files
    pane with markdown preview, the text editor, keyboard navigation, the filter, history, and
    Open terminal here (4.12), and the preferred editor (3.12) with its settings and the Open
    menu on dashboard rows.
11. **Git.** The Git pane (4.13) and the git commands and watcher (3.9).
12. **Containers.** Docker and Podman (3.10), the Containers section, tab, and pane (4.16).
13. **Code search.** The Search pane (4.14) and the search command (3.11).
14. **Setup wizard.** The first-run wizard and Run setup (4.17).
15. **Pane polish.** The `done` status (4.8) on dots everywhere, pane zoom with its key and
    button (4.2), and window-edge docking (4.2).
16. **Pane CLI.** `bb` (3.13): the binary and its bundling, `PATH` in pane environments, the
    `/cli` endpoint, and the front end's handling of each command.
17. **Install and update.** The bundled terminal font, the Git install (3.15) and shell
    integration install (3.14) with their wizard steps (4.17), the updater and release workflow
    (3.16), and the installer's license page, images, and desktop shortcut.

## 12. Risks

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
