# Bashboard: design spec

A Windows desktop terminal dashboard, built with Tauri, that opens, collapses, and arranges Git
Bash terminals over a live colony-simulation backdrop, launches them from favorite folders, and shows
every local coding agent session (Claude Code, and as a preview Codex and Copilot) at a glance. The repo and binary are `bashboard`; the window
title is "Bashboard".

## 1. Goals

- **A daily-driver terminal for Claude Code.** Every key Claude Code and bash rely on reaches
  the shell; copy, paste, resizing, colors, and box drawing behave as they do in Windows Terminal.
- **A live simulation as the backdrop.** The real simulation, not a video or shader approximation, renders
  behind transparent terminals at full frame rate. One instance fills the window behind every
  terminal. Swirling Lights is the default backdrop style; Matrix and None are
  alternatives (section 6).
- **A terminal dashboard.** Open, collapse, and arrange terminals in tabs. Within a tab,
  expanded terminals tile the window as Windows Terminal style panes, with the same keybindings
  as the current Windows Terminal setup; collapsed terminals keep running as cards in a side
  panel, grouped by tab, each showing whether it is idle, working, waiting on you, or done
  since you last looked.
- **Favorite folders.** One click opens a terminal in a favorite folder.
- **Picks up where it left off.** On restart the app reopens the same terminals in the same
  folders and layout, and resumes the agent sessions that were running in them.
- **Session awareness.** A roster of all local agent sessions (Claude Code, Codex, and Copilot, in
  this app and elsewhere), their status, and which ones need attention, also expressed as organisms
  in the simulation. Claude Code is the tested path; Codex, Copilot, and the Local AI models section
  are a preview.
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
  diffs, undoing the last commit, and creating, switching, renaming, and deleting local branches,
  with no merge or rebase; the Containers pane covers existing containers and
  starting or stopping the engines that run them.

## 2. Architecture

```
┌────────────────────────────── WebView2 (one window) ──────────────────────────────┐
│  z0  Backdrop canvas (per style, full window, dimmed, optional blur)              │
│  z1  Pane grid: xterm.js terminals, transparent background                        │
│  z2  Chrome: tab strip, dashboard panel, pane borders/titles, toasts              │
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
hook endpoint, process inspection, repo files, git, containers, code search, and code host APIs. The front end owns layout, rendering, and input
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
| Backdrop | Colony simulation and renderer (three.js), a Canvas 2D digital-rain style, or nothing, chosen by `backdrop.style`, in `src/backdrop/` (section 6) |
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
  per-session markers a coding agent sets in its own environment are removed: Claude Code's
  (`CLAUDECODE`, `CLAUDE_CODE_CHILD_SESSION`, `CLAUDE_CODE_SESSION_ID`, and the rest of that
  list), Codex's (`CODEX_CI`, `CODEX_SESSION_ID`, `CODEX_THREAD_ID`, `CODEX_TOOL_CALL_ID`), and
  Copilot's (`COPILOT_CLI`, `COPILOT_AGENT_SESSION_ID`). An agent started in a pane never
  mistakes itself for a child session when the app started from one.
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

**Agents.** Each supported coding agent has a descriptor in `src-tauri/src/agents.rs`: an
`AgentId` (`claude`, `codex`, or `copilot`, serialized in lowercase and parsed by
`AgentId::parse`), a home folder
(`~/.claude`; `~/.codex`, or `CODEX_HOME` when set; `~/.copilot`, or `COPILOT_HOME` when set; the
user profile comes from `USERPROFILE`), the executable names that identify its process
(`claude.exe`, `codex.exe`, `copilot.exe`; Copilot also runs as a `node.exe` whose command line
holds `@github/copilot`), and `matches_process`. An agent counts as detected when its home folder
exists (for Copilot, with a `session-state` folder inside, since VS Code's Copilot extension
creates `~/.copilot` on its own), which is what `agents_detected()` reports; detection never consults `PATH`, since VS
Code installs a `copilot-shim\copilot.exe` launcher there that is not the Copilot CLI. Every
`Session` carries its `agent`. The display names ("Claude Code", "Codex", "Copilot") live in
`src/agentNames.ts`.

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
- **Hook-born sessions.** Codex and Copilot write no session files, so their sessions are built
  from the hook overlay (3.3): one per overlay entry that carries a pane id, with the overlay's
  newest `cwd`, its first event's time as `startedAt`, and its status and waiting reason. Codex
  names come from its `session_index.jsonl` (`thread_name`, the last line for an id winning). The
  10 second sweep binds each session to the newest process of its agent under its pane's shell
  (`pid` is 0 until one is found); for Copilot's `node.exe` host it reads the command lines of
  the `node.exe` processes under the pane only when needed. The session ends when that process
  exits, its pane closes, or, with no process ever found, after 30 minutes without events; a
  later event for the same id revives it, since resuming a thread reuses its id. Sessions of
  these agents outside a pane have no hooks and so never appear.

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
  # bashboard-hook-version: 1
  # Forwards an agent hook event to Bashboard. Silent no-op outside a Bashboard pane.
  # Usage: bashboard-hook.sh [agent]   (agent defaults to claude)
  [ -n "$BASHBOARD_HOOK_URL" ] || exit 0
  agent="${1:-claude}"
  payload=$(cat)
  if [ -n "$BASHBOARD_HOOK_LOG" ]; then
    printf -- '--- %s agent=%s\n%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$agent" "$payload" \
      >>"$BASHBOARD_HOOK_LOG" 2>/dev/null || true
  fi
  printf '%s' "$payload" | curl -s -m 1 -X POST \
    -H "X-Bashboard-Token: $BASHBOARD_HOOK_TOKEN" \
    -H "X-Bashboard-Pane: $BASHBOARD_PANE_ID" \
    -H "X-Bashboard-Agent: $agent" \
    --data-binary @- "$BASHBOARD_HOOK_URL/hook" >/dev/null 2>&1 || true
  exit 0
  ```

  The script never writes to stdout, because Codex and Copilot read a permission hook's stdout
  as an allow or deny decision, and empty output leaves the normal prompt. When
  `BASHBOARD_HOOK_LOG` names a file, each payload is appended to it with its time and agent, for
  bug reports about an agent's payload shape. The same script serves every agent, installed
  once per agent home (`~/.claude/hooks/`, `~/.codex/hooks/`, `~/.copilot/hooks/`) and told
  which agent it forwards for by its argument.

  The `# bashboard-hook-version: N` line near the top versions the script, and
  `HOOK_VERSION` in `hook_install.rs` must match it (a test checks); any change to the script
  bumps both. The installed copy is compared by version, not by bytes, as the preview's
  `scriptState`: `missing`; `outdated` when its version is lower or it has no readable marker
  (scripts written before versioning); `current` at the same version, even when its bytes differ,
  so hand edits survive; and `newer` when a newer Bashboard wrote it. `current` and `newer`
  count as installed, and the install writes the script only when it is missing or outdated, so
  an older build never downgrades a newer build's script and two installed builds never swap it
  back and forth.

  Because the variables exist only inside this app's panes, the same global hook config does
  nothing for sessions in Windows Terminal or VS Code.
- Claude Code hook registration in `~/.claude/settings.json`, merged next to the existing
  `Notification` hooks (the toast and bell stay):

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
  confirmation; it never edits `settings.json` silently. When every group is already registered
  and only the script is outdated, the button, the dialog title, and its confirm button say
  "Update" instead of "Install", and the dialog says the hooks in settings are already in place
  and only the hook script will be updated, with no JSON. The install writes the script to
  `~/.claude/hooks/bashboard-hook.sh` (home is `USERPROFILE`, else `HOME`) when it is missing or
  outdated, then re-reads
  `settings.json` and merges the groups, through a temporary file and a rename. A missing
  `settings.json` is created. A `settings.json` that is not plain JSON (comments, trailing
  commas) is refused with an error naming the file, and nothing is written.
- **Codex hooks** go in `hooks.json` under the Codex home, merged the same way (an event that
  already holds Bashboard's hook is skipped, existing groups are never altered, a file that is not
  plain JSON is refused) and registered as `bash ~/.codex/hooks/bashboard-hook.sh codex` (the full path of the script when `CODEX_HOME` relocates the home).
  The Windows command (`commandWindows` for Codex, `powershell` for Copilot) names Git Bash by its
  full path when one is found, since a bare `bash` there can resolve to WSL's
  `System32\bash.exe`:

  | Event | Meaning in the app |
  | --- | --- |
  | `SessionStart` | Session bound to its pane |
  | `UserPromptSubmit` | `busy` |
  | `PermissionRequest` | `waiting`, with the tool's `description`, else its `tool_name`, as the reason |
  | `PostToolUse` | `busy`; Codex sends nothing when an approval is answered, so the approved tool finishing is what clears `waiting` |
  | `Stop` | `idle`, shown as `done` until the pane is looked at (4.8) |
  | `Interrupt` | `idle` |
  | `SessionEnd` | Session unbound from its pane |

  Codex runs a hook only once the user has trusted it. The install preview reports the trust
  state, read from the `[hooks.state]` tables of the Codex home's `config.toml` (`trusted`,
  `untrusted`, or `unknown` when the tables are in a form the reader does not parse), and an
  installed but untrusted hook says Codex will ask to trust it on its next start. Bashboard never
  edits `config.toml`.
- **Copilot hooks** are written whole to `hooks/bashboard.json` under the Copilot home, a file
  Bashboard owns (`{ "version": 1, "hooks": { ... } }`, each event holding one command entry with
  `bash` and `powershell` commands and `timeoutSec` 5). The events use PascalCase names, which
  select Copilot's VS Code compatible payload (snake_case fields and `hook_event_name`):

  | Event | Meaning in the app |
  | --- | --- |
  | `SessionStart` | Session bound to its pane |
  | `UserPromptSubmit` | `busy` |
  | `Notification` | `waiting` for `permission_prompt` and `elicitation_dialog` only; other types, and a missing type, change nothing; carries `message` |
  | `PostToolUse` | `busy`, which clears `waiting` as for Codex |
  | `Stop` | `idle`, shown as `done` until the pane is looked at |
  | `SessionEnd` | Session unbound from its pane |

- The install is per agent: `hooks_install_preview(agent)` returns the file it will change, the
  JSON it will add, whether the hooks are already in, whether the agent is detected, whether
  whether `bash.exe` exists, and for Codex the trust state; `hooks_install(agent)` writes it. An absent
  agent means Claude Code.
- The receiver accepts `POST /hook` and `POST /cli` (3.13). For `/hook` it answers with these
  codes, checked in this order:
  404 for any other path or method, 403 for a missing or wrong `X-Bashboard-Token`, 413 for a
  body over 64 KiB, 400 for a body that is not JSON or has no string `session_id`, and 204 on
  success. The `X-Bashboard-Agent` header names the sending agent; an absent header means Claude
  Code (a script from before agents were tagged), and an unknown value is a 400. The receiver
  keeps only `session_id`, `hook_event_name`, `cwd`, `message`, `transcript_path`,
  `permission_mode`, and for Codex's waiting reason the tool's name and description, and emits
  `sessions://hook` with the first four plus the pane id from the header, the agent, and the
  receive time. Each event is mapped to a status by its agent's table above; an event that table
  does not list leaves the status unchanged. `transcript_path` is not forwarded; the
  overlay entry keeps the latest one an event carried, for the transcript reads behind the Panes
  cards' agent line (3.4). The entry also keeps its agent, its newest `cwd`, and the time of its
  first event, which hook-born sessions are built from (3.2). It keeps the latest `permission_mode` the same way, and the roster
  payload carries it as `permissionMode` so restore can resume in that mode (3.7).
- The hook overlay keeps the reason for the event that set `waiting` (Claude Code's and
  Copilot's `Notification` `message`, Codex's tool description), trimmed and cut at 200
  characters, and clears it whenever the overlay's status leaves `waiting`. Held in the
  core, it survives a page reload and covers external sessions. The roster payload carries it as
  `waitingReason` (section 7).

### 3.4 Pane to session binding

A session is bound to a pane by, in order:

1. The `X-Bashboard-Pane` header on its hook events.
2. Process ancestry: walking parents from the session's `pid` (via `sysinfo`) until reaching a
   pane's shell pid, for Claude Code sessions started before hooks were installed. Codex and
   Copilot sessions are bound by hooks alone (3.2).

Sessions that bind to no pane are external (Windows Terminal, VS Code) and appear in the
roster without a pane link.

**Transcripts.** Each pane-bound session's Panes card (4.6) shows its model and context, which
`transcript.rs` reads from the session's transcript. The formats are internal to each tool and
undocumented, so every field is optional and an unreadable line is skipped. A reading is the
newest model, the context tokens, and the context window when the transcript reports one.

- **Claude Code.** The JSONL file Claude Code appends to under `~/.claude/projects/`: the hook
  overlay's `transcript_path` when there is one; for a session bound by ancestry, which sends no
  hooks, the first `~/.claude/projects/*/<sessionId>.jsonl`, searched again at most every 5
  seconds until found. The reading is the newest line of `type` `assistant` that is not
  `isSidechain` and carries `message.usage` (a `<synthetic>` model is skipped): context is
  `input_tokens + cache_creation_input_tokens + cache_read_input_tokens`, and the model is
  `message.model`. The transcript does not name the context window.
- **Codex** (`transcript/codex.rs`). The newest `sessions/YYYY/MM/DD/rollout-*-<id>.jsonl` under
  the Codex home. The model is the newest `turn_context` line's `model`; context tokens are the
  newest `token_count` event's `last_token_usage.total_tokens`, with its `model_context_window`
  as the window.
- **Copilot** (`transcript/copilot.rs`). `session-state/<id>/events.jsonl` under the Copilot
  home. The model is the newest `session.model_change` event's `newModel`, else `session.start`'s
  `selectedModel`. Copilot never writes token counts to disk, so there is no context reading.

The core reads only a Claude file's last 64 KiB, widening to the whole file, streamed line by
line, when the tail holds no qualifying line; the other formats are read whole in batches. A
`notify` change marks the session dirty, and a dirty session is re-read at most once per second.
A changed reading emits `agent://context` (section 7), and `agent_context()` returns every known
entry so a page reload shows them at once. Nothing is tracked until the dashboard first calls
`agent_context()`, which it does while the Panes section is enabled, and `agent_context_stop()`
when it is turned off; entries are pruned with the hook overlay.

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
| `repos.json` | `repos_load`, `repos_save` | Pinned files and folders per repo (4.12), and the branch worktrees are compared with (4.13) |

The core treats all four as opaque JSON, except that the worktree commands (3.9) read each repo's
`primaryBranch` from `repos.json`; the front end owns their shape and validation.
`favorites.json`, `layouts.json`, and `repos.json` are hand-editable, so they are watched and
hot-reloaded like `settings.json`, emitting `favorites://changed`, `layouts://changed`, and
`repos://changed`. They are kept out of `settings.json` because the app rewrites them from the
dashboard, and rewriting a hand-edited JSONC file would drop its comments.

Scratch pads (4.15) live beside them as `scratch/<id>.txt`, written by `scratch_save(id, text)`
and removed by `scratch_delete(id)`; `scratch_load(id)` reads one back on restore.

Terminal scrollback (4.9) lives in `scrollback/<id>.txt`. `scrollback_save_all(entries)` writes
each `{ id, text }` and deletes every other file in the folder, so it holds exactly the terminals
of the last saved workspace; `scrollback_load(id)` reads one back, as an empty string when it is
missing. Ids use the scratch pads' alphabet.

### 3.8 Repo files (`src-tauri/src/files.rs`)

A path's repo is the nearest folder at or above it holding `.git` (a directory, or the file a
worktree has); a folder in no repo is its own repo, without git. A linked worktree is its
own repo root here, so each worktree of one repository has its own `repo_root`; the Git pane's
Branches tab lists them together through the worktree commands in 3.9.

| Command | Purpose |
| --- | --- |
| `repo_root(path) -> { root, isGit, branch? }` | The repo a folder belongs to |
| `fs_list(dir) -> Entry[]` | Folders, then files, each with name, size, and modified time |
| `fs_read_text(path) -> { text, modified, lossy }` | Up to 2 MiB; a file with a NUL byte in its first 8 KiB is refused as binary. Invalid UTF-8 decodes with U+FFFD in place of the bad bytes and sets `lossy` |
| `fs_write_text(path, text, expectedModified)` | Writes through a temp file and a rename; refused when the file's modified time differs from `expectedModified`, so a save never overwrites a change made on disk since the read, and refused when the file on disk is not valid UTF-8 |
| `fs_move(path, toDir)` | Moves a file into another folder; refused when the target name exists |
| `fs_rename(path, newName) -> path` | Renames a file or folder within its folder; refused (`invalid:`) for a name Windows forbids and (`exists:`) when another entry has the name, though a change of case alone goes through |
| `fs_watch(dir, onChange) -> id`, `fs_unwatch(id)` | One folder, not recursive, debounced 200 ms |

Paths must be absolute and are normalized before use, so `..` segments cannot step outside the
folder they name. `fs_write_text`, `fs_move`, and `fs_rename` work on any existing entry, and nothing creates or
deletes files except the scratch commands above.

### 3.9 Git (`src-tauri/src/git.rs`, `src-tauri/src/git_fetch.rs`, `src-tauri/src/git_worktrees.rs`, `src-tauri/src/git_branches.rs`)

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
| `containers_list() -> ContainersSnapshot` | `ps -a --format json` on every running engine: the engines with their running state, any start or stop in flight (`pending`), and whether each can be started and stopped (`canStart`, `canStop`), plus each container's engine, id, name, image, state, status text, published ports, and the Compose project and service labels. An engine whose `ps` fails is reported as not running |
| `containers_action(engine, ids, action)` | `start`, `stop`, or `restart`; ids follow `--` |
| `containers_logs(engine, id, onData) -> streamId`, `containers_logs_stop(streamId)` | `logs -f --tail 500`, stdout and stderr streamed over a `Channel` as raw bytes |
| `containers_stats(engine, ids) -> ContainerStats[]` | `stats --no-stream --format json`: CPU and memory |
| `containers_engine_start(engine)`, `containers_engine_stop(engine)` | The engine's own start or stop (below), then a probe every 2 seconds until the engine agrees, for up to 4 minutes. One at a time per engine |

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

**Starting and stopping an engine.** At startup, and on each 10-second probe of an engine that
is not running, the core works out how that engine can be controlled:

- **Docker:** `docker desktop start` and `docker desktop stop` when the `docker desktop` command
  exists (Docker Desktop 4.37 and later). Otherwise, when `Docker Desktop.exe` is in the install
  that holds `docker.exe` (`<install>\resources\bin`), start only, by launching it, since an
  older Docker Desktop has no clean stop short of its own Quit. Docker Engine inside WSL,
  Rancher Desktop, and other setups get neither, so no button appears that cannot work.
- **Podman:** `podman machine start` and `podman machine stop` on the machine that `podman
  machine list` marks as default, else the first one listed. With no machine there is nothing to
  start; the app does not run `podman machine init`.

While a start or stop runs, every snapshot carries it as `pending`, so each Containers pane and
the dashboard show it from the same message. A start that succeeds wakes the engine's watcher, so
it follows events at once instead of at its next probe; a stop ends the events child, which the
watcher notices as usual.

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
| `bb auth bitbucket [--clear]` | Stores a Bitbucket API token for the Ship pane (3.20), or removes it with `--clear` |
| `bb auth azure-devops <org> [--clear]` | Stores an Azure DevOps personal access token for one organization, or removes it with `--clear` |
| `bb help` | Lists the commands |

`src-tauri/cli-commands.json` holds each command's usage, summary, details, and examples. `bb help`
prints the usage and summary lines from it (embedded at build time), and the app dialog's CLI tab
(4.18) shows all of it, so the two cannot drift.

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

### 3.14 Shell integration install (`src-tauri/src/shell_integration.rs`)

Working-directory reporting (OSC 9;9) and the command-start and command-end markers (OSC 133)
come from a few lines in Git Bash's `~/.bashrc`; PowerShell 7 and Windows PowerShell report the
working directory from a prompt wrapper in their profile (no OSC 133, for the reason in setup.md).
The setup wizard (4.17) installs either with `shell_integration_preview(shell)` and
`shell_integration_install(shell)`, where `shell` is the profile id `gitBash`, `pwsh`, or
`powershell` (cmd needs no lines, 3.1). The lines are the snippets in setup.md's "New panes in
the current folder" and PowerShell sections; tests require each to match byte for byte, ignoring
line endings. The PowerShell snippet uses `$([char]27)` rather than the `` `e `` escape, which
Windows PowerShell 5.1 lacks.

The install writes the snippet between two marker lines at the end of the file:
`# >>> bashboard shell integration >>>` and `# <<< bashboard shell integration <<<`. For Git
Bash the file is `~/.bashrc`, with home as `HOME`, then `USERPROFILE`, as Git Bash resolves it.
For PowerShell it is `$PROFILE.CurrentUserCurrentHost`, which differs between the two shells and
follows a Documents folder moved to OneDrive, so the core asks the shell itself: it runs the
shell with `-NoProfile -NonInteractive` (no console window) and reads back the profile path and
`Get-ExecutionPolicy`. The PowerShell code is `src-tauri/src/shell_integration/powershell.rs`.
`shell_integration_preview` returns the shell, the file's path, the status, the block to add,
whether the file or `.bash_profile` would be created, and a warning.

| Status | Meaning | Install does |
| --- | --- | --- |
| `missing` | No file, or no Bashboard lines in it | Appends the block, after a blank line |
| `installed` | A marked block equal to the current snippet | Nothing |
| `outdated` | A marked block that differs from the current snippet | Replaces the block in place |
| `handAdded` | The snippet, or an earlier published one, appears verbatim without markers | Replaces those lines with the marked block, in place |
| `custom` | A begin marker with no end marker, or lines of the user's own (a `__bashboard_prompt` function, or a `__BashboardOriginalPrompt` line) that are not the snippet | Refuses; the user updates the lines by hand |

- **Backup.** An existing file is copied to `<file>.bashboard-backup` beside it before it is
  rewritten. The write is atomic (the helper the hook install uses, 3.3) and creates a missing
  folder, which a PowerShell profile's often is.
- **Encoding and line endings.** The file's own line endings are kept, and lines outside the
  block are rewritten byte for byte. `.bashrc` must be UTF-8. A PowerShell profile may also be
  UTF-8 with a BOM or UTF-16 LE (what Windows PowerShell's `>` writes), and is written back the
  same way; a new profile is plain UTF-8, which is safe since the block is ASCII. Anything else
  is left alone with an error.
- **Login shells.** Git Bash's login shell reads `~/.bash_profile`, not `~/.bashrc`. When that
  file is missing, the install creates it with the two standard lines that source `~/.profile`
  and `~/.bashrc`. When it exists and never mentions `.bashrc`, the preview carries a warning
  and the file is left untouched.
- **Execution policy.** A PowerShell whose effective policy is `Restricted` (Windows
  PowerShell's default on Windows clients) or `AllSigned` will not run the profile, so the
  preview warns and names `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`. The install
  never changes the policy.
- Panes already open do not pick the lines up until their shell reads the file again
  (`source ~/.bashrc`, or `. $PROFILE`, which the snippet's guard keeps from wrapping the prompt
  twice).

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

### 3.17 Fonts (`src-tauri/src/fonts.rs`)

`fonts() -> { family, monospace }[]` lists the installed font families for the Settings tab's
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

### 3.19 Local model servers (`src-tauri/src/model_servers.rs`)

The Local AI models section (4.6) and the launcher's local-model entries need to know which model
servers answer on this machine and what they have loaded. The core asks Ollama and LM Studio over
loopback HTTP with an 800 ms timeout per request; a server that does not answer is absent from the
result, never an error.

- **Addresses.** Ollama's is `localModels.ollamaUrl`, else the `OLLAMA_HOST` environment variable
  (a bare host or port, a scheme, and `0.0.0.0` or `[::]` read as loopback), else
  `http://127.0.0.1:11434`. LM Studio's is `localModels.lmStudioUrl`, else
  `http://127.0.0.1:1234`.
- **`model_servers_poll()`** returns a snapshot: `ollama` and `lmStudio`, each present only when
  the server answered, with its URL, version (Ollama's, from `/api/version`), and loaded models,
  plus `ollamaOnPath`, whether an `ollama` executable sits in a `PATH` folder. A loaded model
  carries its name, total size, bytes in GPU memory, context length, and the time Ollama will
  unload it. Ollama's come from `/api/ps`; LM Studio's from `/api/v1/models`, whose models with
  `loaded_instances` count as loaded, reporting each instance's configured context length and no
  GPU placement.
- **`model_servers_ollama_models()`** returns the installed Ollama models from `/api/tags`, for
  the launcher's submenus; empty when the server does not answer.

Both commands read the settings on every call, so a changed URL applies without a restart. Every
field of every reply is optional on parse, since these APIs are not versioned contracts.

### 3.20 Ship (`src-tauri/src/forge/`)

The Ship pane (4.20) shows a repo's CI runs and open pull requests, and an Overview of every
pinned repo. The core talks to the code host's REST API, and every host returns the same normalized shapes (section 7), so the front end
knows a host only through a few capability flags. The module is split by concern: `mod.rs` (the
commands, repo resolution, and the `ForgeProvider` trait), `types.rs` (the shapes), `remote.rs`
(remote URLs), `auth.rs` (token sources and accounts), `accounts.rs` (the Accounts tab's commands,
below), `http.rs` (the client), and one file per provider: `github.rs`, `bitbucket.rs`,
`gitlab.rs`, and `azure_devops.rs`. The Windows Credential Manager access sits in
`src-tauri/src/credential_store.rs`, outside the module, because `bb.exe` compiles it too.

- **Provider trait.** `ForgeProvider` has `kind`, `capabilities`, and the blocking methods `runs`,
  `jobs`, `log`, `rerun`, `cancel`, `pulls`, `pull_checks`, and `default_branch`, each taking a
  `Cx` (the shared `Http` and the resolved `Token`) and a `RepoRef`. The commands already run on
  `spawn_blocking`, so the methods are blocking, which keeps the trait object safe with no async
  trait crate. `provider(kind)` returns the provider for each of the four kinds. `RepoRef`
  carries the provider, host, a path (GitHub `[owner, repo]`, Bitbucket `[workspace, slug]`,
  GitLab the full group path, Azure DevOps `[org, project, repo]`), and the repo's web URL.
- **Commands.** All are async, run their work on a blocking thread, and return a `ForgeError` on
  failure: `forge_repo(root)`, `forge_runs(root, branch)` (newest first, at most 20; a null branch
  means every branch), `forge_jobs(root, runId)`, `forge_log(root, runId, jobId)`,
  `forge_rerun(root, runId, failedOnly)`, `forge_cancel(root, runId)`,
  `forge_pulls(root, openOnly, branch)` (at most 50, with the host's count of all that match),
  `forge_pull_checks(root, pulls)` (below), `forge_overview_repo(target)` (below), and
  `forge_set_account(root, user)`. `root` is the pane's folder; a folder that is not a
  directory or not inside a repo is `notARepo`.
- **Remote targets.** Every command takes a target key: a local folder, or `remote:<host>/<path>`
  for a repo with no clone, such as one pinned by typing its address. `parse_repo_input` reads the
  `<host>/<path>` form, an https, ssh, or scp remote URL, and a web URL into the repo (a pull
  request, a pipeline, a file), dropping the trailing page. A remote target has no current branch
  and no repo config, so its account is the one a fresh clone would get (the host's only or active
  GitHub CLI account; the other hosts have none), and `git credential fill` runs from the home
  folder, reading the helpers from global and system config. `forge_set_account` returns an error
  for it, since there is no repo config to store an account in. A target that does not parse is
  `unsupportedHost`, with a message that leaves the address out, as remote URLs are.
- **Overview.** `forge_overview_repo(target)` returns an `OverviewRepo` (section 7) in one call: the
  newest 20 runs on every branch, the open pull requests (at most 50), and the default branch,
  fetched in parallel after one token lookup. An error from the runs or the pull requests is the
  call's error; a failed default-branch lookup only leaves `defaultBranch` null.
- **Default branch.** `default_branch` is GitHub's `default_branch`, Bitbucket's
  `mainbranch.name`, GitLab's project `default_branch`, and Azure DevOps's repository
  `defaultBranch`; a provider that does not say returns null. The core caches it per provider,
  host, and path for an hour, and a failed lookup caches nothing.
- **Remote.** The remote is the current branch's upstream remote (`branch.<name>.remote`, ignoring
  `.`), else the one Publish uses (3.9): `origin`, else the only remote. A repo with no remote is
  `noRemote`. `parse_remote` reads `https://`, `ssh://`, and scp-form URLs, keeping an https
  remote's port (the web and API URLs use it too) and its `user@`, and dropping any password
  unread. Every Azure DevOps form (`dev.azure.com`, `ssh.dev.azure.com`, `vs-ssh.visualstudio.com`,
  and `<org>.visualstudio.com`) normalizes to host `dev.azure.com` and `[org, project, repo]`.
  A GitLab remote keeps its whole group path, nested groups included, and its port.
  `ssh.github.com` is `github.com`. Remote URLs never appear in messages, since an https remote
  can carry a password.
- **Host classification.** `classify` picks the provider from the `ship.hosts` setting (section
  8) first, then the well-known hosts (`github.com`, `bitbucket.org`, `gitlab.com`,
  `dev.azure.com`), then treats any host the GitHub CLI is signed in to (a top-level key in its
  `hosts.yml`) as GitHub Enterprise Server, then any host under `hosts:` in GitLab CLI's
  `config.yml` as self-managed GitLab (only the key names are read, never a token). Anything else
  is `unsupportedHost`. The Bitbucket
  provider speaks only Bitbucket Cloud (`api.bitbucket.org`): for another host it answers
  `unsupportedHost` with "Bitbucket Data Center isn't supported yet" before sending a request, so a
  self-hosted host's Git Credential Manager token never goes to Bitbucket Cloud. The Azure DevOps
  provider speaks only Azure DevOps Services (`dev.azure.com`). `ship.hosts` is therefore for
  GitHub Enterprise Server hosts the CLI is not signed in to, and for self-managed GitLab hosts
  that GitLab CLI's config does not list.
- **Tokens.** Bashboard never runs an OAuth flow, and the secrets it writes are a Bitbucket API
  token and Azure DevOps personal access tokens (PATs), one per organization, into Windows
  Credential Manager (below). Each provider
  lists sources in order, and the first that yields a token wins. GitHub: `gh auth token
  --hostname <host>` (with `--user <account>` when an account is chosen), found on `PATH` or in
  GitHub CLI's install folders, since a `gh` installed while Bashboard runs is not on the `PATH` it
  inherited; then `git credential fill`, which reaches Git Credential Manager. Bitbucket: the
  generic Windows credential `bashboard:bitbucket.org`, which the Accounts tab and `bb auth
  bitbucket` write (3.13); then Git Credential Manager as a fallback. GitLab: `glab auth status
  --hostname <host> --show-token` (glab has no `auth token` command), read from its labeled token
  line, with a masked value counting as none, found on `PATH` or in glab's install folders and
  kept for only 10 minutes, since glab refreshes its OAuth tokens itself; then Git Credential
  Manager for the host. Azure DevOps: the PAT stored for the repo's organization, the generic
  credential `bashboard:dev.azure.com/<org>` (the organization lowercased, since organization
  names are case-insensitive); then the `AZURE_DEVOPS_EXT_PAT` environment variable (trimmed, an
  empty value counting as unset), which the app reads from its own process environment, so a
  variable set only in another tool's configuration does not reach it; then an Entra token from
  `az account get-access-token --resource 499b84ac-1321-427f-aa17-267ca6975798` (Azure CLI found on
  `PATH` or in its install folders, the token cached until 5 minutes before it expires); then Git
  Credential Manager, asked with the organization as the credential's `path`, since it keeps one
  Azure DevOps credential per organization. A stored PAT is per organization because a PAT made
  for all accessible organizations (a global PAT) stops working on January 27, 2027. A stored PAT
  that Azure DevOps refuses is reported as rejected and is not passed over for the Azure CLI, so a
  stale PAT never hides behind another identity. `git credential fill` runs with `GCM_INTERACTIVE=never`
  and `GIT_TERMINAL_PROMPT=0`, so it never opens a sign-in window, passes the account as the
  `username` when one is chosen, and its reported expiry is honored. Bashboard never calls
  `approve` or `reject`, since the credential belongs to the user's helper. Tokens are cached in
  memory by provider, host, and account (for Azure DevOps, the organization takes the account's
  place in the key). A call that answers 401 drops its cached token, resolves
  one fresh, and retries once before the error stands.
- **Auth header.** GitHub, Bitbucket, and GitLab send the token as `Bearer`. Azure DevOps takes
  a PAT only as `Basic` (an empty user name, then the token) and an Entra token only as `Bearer`,
  so the header follows the source: a stored PAT and an environment PAT are `Basic`, an Azure CLI
  token is `Bearer`, and a Git Credential Manager password is `Bearer` when it has the shape of a
  JWT (three base64url parts, the first starting `eyJ`, which is what Git Credential Manager
  returns when `credential.azreposCredentialType` is `oauth`) and `Basic` otherwise.
- **Accounts.** GitHub is the only host with several signed-in accounts. They come from GitHub
  CLI's `hosts.yml` (the host's `users` names and its active `user`); only those keys are read,
  never an `oauth_token`. GitLab CLI and Azure CLI hold at most one: the user from glab's "Logged
  in to <host> as <user>" status line (the token line is never read) or from `az account show
  --query user.name`. The account a repo uses is, in order: `credential.username` from the
  repo's git config (local, or `credential.<url>.username` for `https://<host>/`), the `user@` of
  an https remote, the host's only account, or the CLI's active account when there are several.
  `ForgeRepo.accountSource` names which (`repoConfig`, `remoteUrl`, `only`, `cliActive`, or
  `none`). `forge_set_account` refuses a user not among the host's accounts, runs `git config
  --local credential.username <user>`, drops that root's repo and token caches, and returns the
  re-resolved repo. That setting is the one that also stops Git Credential Manager asking which
  account to use on every push.
- **Accounts commands** (`forge/accounts.rs`) serve the Accounts tab (4.20), and none returns a
  token. `forge_auth_status(known)` returns one `HostAuth` per card, each with a signal saying the
  host is used on this machine (`detected`, with `detectedBy` holding the reasons in words) or not.
  `github.com`, `gitlab.com`, `bitbucket.org`, and `dev.azure.com` are always listed. Any other host
  is listed once something detects it: a host in GitHub CLI's `hosts.yml`, a host in GitLab CLI's
  config, a `ship.hosts` entry mapped to `github` or `gitlab` (a CLI host that `ship.hosts` maps to
  another provider is left out, since the pane would not treat it as that CLI's), or a host in
  `known`. `known` is what the front end alone knows: `{ hosts, dirs }`, the provider and host of
  every pin and open Ship pane, and the folders of open terminal panes, whose repo host comes from
  the `origin` remote (else the first). A stored Bitbucket token, a stored Azure DevOps PAT, a
  non-empty `AZURE_DEVOPS_EXT_PAT`, and an installed Azure CLI detect the Bitbucket and Azure DevOps
  cards. Bitbucket Cloud and Azure DevOps Services are one card each, so every host of theirs (the
  `<org>.visualstudio.com` forms included) counts toward `bitbucket.org` and `dev.azure.com`. The
  order is GitHub (`github.com` first, the other GitHub hosts alphabetically), GitLab hosts
  alphabetically, `bitbucket.org`, then `dev.azure.com`; the front end splits detected cards from
  the rest without reordering them. A `HostAuth` carries `cliInstalled` (`gh`, `glab`, or `az`
  found on the `PATH` or in its install folders; false for Bitbucket), the CLI's `accounts` and
  `activeAccount`, the kind of source the Ship pane would take its token from (`TokenSourceKind`:
  `ghCli`, `glabCli`, `azCli`, `gitCredentialManager`, `bashboardCredential`, or `environment`;
  null when none yields one), and `storedTokens`, the tokens Bashboard stored for the host: at most
  one for Bitbucket, and one per organization for Azure DevOps, found by listing the credentials
  under `bashboard:dev.azure.com/`. An Azure DevOps card with a stored PAT reports
  `bashboardCredential`, since a stored PAT wins for its organization and the card has no one
  organization to resolve for. Hosts are inspected side by side, and only the source's kind leaves
  the lookup. `ghEnvToken` is the name of the environment variable that `gh` in a terminal would use
  for the host instead of its saved accounts, or null (always null off GitHub, and for a GitHub
  host with none set); only the name leaves the core, never the value. The app's own lookup passes
  `--user`, so it reads the saved account whatever the variable says. GitHub CLI's rules: for `github.com` and `*.ghe.com` hosts, `GH_TOKEN` then
  `GITHUB_TOKEN`; for other hosts, `GH_ENTERPRISE_TOKEN` then `GITHUB_ENTERPRISE_TOKEN`. An empty
  value counts as unset. `forge_auth_test(provider, host, account, org)` resolves that token and asks the host who
  it belongs to, bypassing the ETag cache: GitHub `GET /user`, reading the login and the
  `X-OAuth-Scopes` header (sent only for classic tokens and OAuth apps), Bitbucket `GET
  /2.0/user`, GitLab `GET /api/v4/user` (the username), and Azure DevOps `GET
  /<org>/_apis/connectionData` (the signed-in display name), using the sources of that
  organization, which `org` names; with no `org` it answers `ok: false`, asking for an Azure DevOps repo
  to be opened first, and a reply that names nobody fails the test. It returns an `AuthCheck` (`ok`, `login`, `scopes`, `message`), and an error comes
  back as `ok: false` with its message, so a Bitbucket 403 names the missing scope.
  `forge_set_token(provider, org, token)` stores a token in Windows Credential Manager and
  `forge_clear_token(provider, org)` deletes it (false when none was stored). Bitbucket's is the
  credential `bashboard:bitbucket.org` with the user name `x-bitbucket-api-token-auth`, and ignores
  `org`; an Azure DevOps organization's is `bashboard:dev.azure.com/<org>` with the user name
  `x-azure-devops-pat`, and `org` is required: it is trimmed and lowercased, and an empty name, or
  one holding a slash, whitespace, or a control character, is refused. Any other provider is
  refused. `forge_gh_switch(host, user)` and
  `forge_gh_logout(host, user)` run `gh auth switch` and `gh auth logout` with `--hostname` and
  `--user`; they refuse a user who is not among that host's `hosts.yml` accounts, run with a hidden
  console, `GH_PROMPT_DISABLED=1`, and no standard input, so `gh` never prompts, and report its
  standard error on failure. Both remove `GH_TOKEN`, `GITHUB_TOKEN`, `GH_ENTERPRISE_TOKEN`, and
  `GITHUB_ENTERPRISE_TOKEN` from `gh`'s environment, since `gh` refuses to switch or log out while
  one applies to the host. `forge_glab_logout(host)` runs `glab auth logout --hostname <host>` the
  same way; glab holds one account per host, so it names none. Every successful change drops the host's cached tokens and resolved
  repos and emits `forge://auth-changed` with `{ provider, host }`; Ship panes (`ShipStore`),
  the Overview store, and an open Accounts tab refresh on it. A sign-in finished in a terminal
  pane changes `hosts.yml` without passing through the core, so the tab also reloads when it is
  shown and when the window regains focus.
- **Token handling.** A Bitbucket token or an Azure DevOps PAT enters the core only from the
  Accounts tab's password field, as an argument of `forge_set_token`, or from `bb auth` in a
  separate process. It is never sent from the core to the page, never logged, never put in an
  error message, and never written anywhere but Windows Credential Manager. The core overwrites
  its copies after the write; that is best effort, since the buffers the IPC layer fills while
  deserializing the argument are outside the app's control, so the app does not claim the token is
  wiped from memory.
- **Errors.** Providers and the HTTP layer return `ForgeError { kind, message, url, signIn,
  retryAfterSecs }`. `message` is plain text and never holds a token or a header; the HTTP layer
  builds messages from status codes and host names only. A 401 is `signedOut`, and so is a 2xx
  reply to a JSON request that is an HTML page (Azure DevOps answers a refused or wrong-organization
  token with its sign-in page, often a 203; a log fetch decides on the content type alone, since a
  log may begin with `<`); a 403 with GitHub's
  `X-GitHub-SSO` header is `ssoRequired`, carrying the authorize URL; a 429, or a 403 with
  `Retry-After` or an exhausted `X-RateLimit-Remaining`, is `rateLimited` with the seconds to wait;
  any other 403 is `forbidden`, and a 404 is `notFound`. A Bitbucket 403 body names the scopes the
  token lacks (`error.detail.required`), and the message is "This token is missing the X
  scope." in place of the generic "The code host refused access to this repo." Only scope-shaped
  strings are echoed. A `forbidden` result drops the cached token for that provider, host, and
  account and resolves it again; the call repeats once only when the resolved token's value differs
  from the one that failed (compared in memory), so a token stored after a missing-scope 403 takes
  effect without a restart, while an ordinary 403 costs no extra request and a mutating call
  (re-run, cancel) never repeats with the same token. `signedOut` is finished in `mod.rs` into the next
  step. For GitHub with `gh` installed, `signIn` is `gh auth login --hostname <host> --web`; with
  `gh` missing, the kind becomes `notInstalled`, `url` is cli.github.com, and `signIn` is `winget
  install --id GitHub.cli -e`. For GitLab the same split applies with `glab`: `signIn` is `glab
  auth login --hostname <host>`, or, with `glab` missing, the kind becomes `notInstalled`, `url` is
  GitLab CLI's page, and `signIn` is `winget install --id GLab.GLab -e`. For Bitbucket the message says whether no token is stored or the
  stored token was rejected (it may have expired or lack a scope), `url` is the Atlassian token
  page, and `signIn` is `bb auth bitbucket`, and the message names the Accounts tab first. For
  Azure DevOps, `signedOut` and `forbidden` both carry the organization's token page
  (`https://dev.azure.com/<org>/_usersSettings/tokens`) as `url` and `bb auth azure-devops <org>`
  as `signIn`, and a `signedOut` message says which source failed: none was found (add a PAT in
  the Accounts tab, or run `bb auth azure-devops <org>`); the stored token was rejected (expired,
  revoked, or made for another organization); the `AZURE_DEVOPS_EXT_PAT` token was rejected; Azure
  CLI's sign-in was refused, with the hint to run `az login --tenant <tenant>`, since a wrong tenant
  answers like no access at all; or Git Credential Manager's sign-in was refused. A message that
  says "rejected" is what the notice keys on to lead with Replace token. A GitHub `notFound` on a host with several accounts
  points at the account menu. A Git Credential Manager token that Bitbucket refuses gets a message
  saying that its sign-in cannot read pipelines or pull requests.
- **HTTP.** One `ureq` agent with a 15 second timeout, the system proxy, and the Windows
  certificate store as its roots, so a corporate TLS inspection root is trusted. Redirects are
  followed by hand. A request follows one redirect to the same host with the same credentials
  (GitHub answers a renamed repo's API URL with a 301); a job log's redirect, which leads to
  another host's signed URL, is followed without the `Authorization` header or any header the
  caller set. GETs go through an ETag cache of 256 entries, least recently used out, keyed by
  method, URL, and a hash of the token, so a 304 reuses the cached body. A log is read to its end
  and only the last 1 MiB is kept, cut after a newline, with `truncated` set.
- **GitHub.** github.com uses `api.github.com`; an Enterprise Server host uses
  `https://<host>/api/v3` and `/api/graphql`. Runs, jobs, logs, re-run, re-run failed jobs, and
  cancel use the REST Actions API. Open pull requests come from one GraphQL query, since REST would
  need a request per pull request for reviews and checks, and its `totalCount` is the open count;
  a GraphQL failure arrives as HTTP 200
  with an `errors` array, which is mapped to the same error kinds. A run's status comes from its
  `status`, or its `conclusion` once completed: `action_required` is `waiting`; `queued`,
  `requested`, `pending`, and `waiting` are `queued`; `failure`, `timed_out`, and `startup_failure`
  are `failure`. A run's finish time is its last update, since it has no completion time of its
  own. A pull request's reviewers are its requested users (pending, even when they reviewed
  before) and the authors of the latest reviews. Team review requests are not listed. A pull
  request whose author was deleted shows as "ghost".
- **Bitbucket.** `api.bitbucket.org/2.0` with a Bearer token. A pipeline is a run, and its steps
  are its jobs, with no per-command step list, so `steps` is empty. A pipeline's `PAUSED` and
  `HALTED` states are `waiting`, and `STOPPED` is `cancelled`. Re-run starts a new pipeline on the
  same target (branch or pull request, selector, and commit); custom pipeline variables are not
  kept. There is no failed-only re-run (`rerunFailed` is false), and cancel is `stopPipeline`. A
  step that has not started has an empty log. Pull requests are listed with a `fields` selection of
  only what the row shows, including participants, and the page's `size` is the matching count; the viewer's uuid comes from `/user` once per token and marks the
  pull requests that are yours or await your review. `read:user:bitbucket` is a required scope: a
  token without it fails the list with a `forbidden` error naming the missing scope. A pull request's checks are the worst of its commit's build statuses, fetched once per
  pull request and kept until its `updated_on` changes, which keeps polling inside Bitbucket's
  limit of 1,000 requests an hour per user. Merged and declined pull requests show no checks. The
  list returns at once with the cached rollups and marks the open ones still missing `checksPending`; the front end then asks `forge_pull_checks` for those, which
  fetches them eight at a time, and merges the answers into the rows. The pipelines list carries a commit's hash but not its
  message, so a pipeline titled by neither a commit message nor a pull request takes its commit's
  first line from `/commit/{hash}`, fetched once per hash for the session.
- **GitLab.** `https://<host>/api/v4`, where the host keeps the port of an https remote, with a
  Bearer token. A project is addressed by its full path, nested groups included, percent-encoded
  as one segment (`group%2Fsub%2Frepo`). A pipeline is a run, and a job is a job with no step
  list, so `steps` is empty; the API lists jobs newest first and the pane shows them oldest first.
  A job's log is its `trace`, and one that has not started has an empty log. The pipeline list
  lacks the name, the user, and the times, so each pipeline's detail is fetched, eight at a
  time, and cached until the list's `updated_at` for it changes; the title is the commit's first
  line from `/repository/commits/{sha}`, fetched once per commit. A pipeline's `created`,
  `waiting_for_resource`, `preparing`, `pending`, and `scheduled` are `queued`; `running` and
  `canceling` are `running`; `manual` is `waiting`; `failed` is `failure`; `canceled` is
  `cancelled`. Re-run is `POST /pipelines/{id}/retry`, which retries the failed jobs only, so
  `rerun` and `rerunFailed` are both true and do the same; cancel is `POST /pipelines/{id}/cancel`.
  Merge requests come from `/merge_requests` (`state=opened`, or `all`; newest update first; 50;
  `source_branch` for the branch filter), and the total is the `X-Total` header, which GitLab
  leaves out past 10,000 (then null), so the call is not served from the ETag cache. A `merged`
  request is merged, `closed` and `locked` are closed, and `draft` is the draft flag. GitLab has
  no "changes requested": a reviewer who approved is approved, every other reviewer is pending,
  and anyone else who approved is added as approved. The list carries neither the head pipeline
  nor the approvals, so its open rows come back `checksPending`, and `forge_pull_checks` fetches
  each merge request and its approvals (eight at a time), cached until the merge request's
  `updated_at` changes and asked again while its pipeline is still queued or running. The
  approvals and the head pipeline therefore show one poll after the list. The viewer's user id
  comes from `/user` once per host and token, and marks the merge requests that are yours or
  await your review.
- **Azure DevOps.** `https://dev.azure.com/{org}`, the path `[org, project, repo]` percent-encoded
  per segment, with `api-version=7.1` on every call except `7.1-preview` for `connectionData` and
  policy evaluations, which answer a plain `7.1` with a 400. Every call sends `X-TFS-FedAuthRedirect:
  Suppress`, since a refused token otherwise gets a 302 to a sign-in page on another host rather
  than a 401. The repo's id, its project's id, and its default branch come from one repository
  request, cached on success. A run is a build (`_apis/build/builds` for the repo's id, the newest
  20, filtered by `refs/heads/<branch>`); a pull request build is attributed to the pull request's
  source branch, and its title is the commit message's first line, else the pull request's title,
  else the build number. A build's `notStarted` and `postponed` are `queued`; `inProgress` and
  `cancelling` are `running`; once `completed`, its result decides: `succeeded` is `success`,
  `failed` and `partiallySucceeded` are `failure`, and `canceled` is `cancelled`. A build held at a
  stage approval stays `inProgress`, so it reads as running. Jobs come from the build's timeline,
  which is flat and unordered: each Job record is a job, named `<stage> / <job>` when it is in a
  named stage, ordered by the `order` of its ancestors from the stage down, with its Task records
  as steps. A log is addressed by the record's log id, which exists only once the job has started
  (before that the log is empty). Re-run re-runs only the failed stages of the same build
  (`PATCH builds/{id}?retry=true`), so `rerun` is false and `rerunFailed` is true, and a full
  re-run is refused. Cancel is `PATCH` with `{"status": "cancelling"}`. A 403 on either says the
  token is missing the Build (Read & execute) scope. Pull requests come from `searchCriteria.status`
  `active`, or `all` (the newest 50, `searchCriteria.sourceRefName` for the branch filter); `isDraft`
  is the draft flag, `completed` is merged, and `abandoned` is closed. A reviewer's vote of 10 or 5
  is approved, -5 or -10 is changes requested, and 0 is pending; a reviewer who declined is not
  listed. The decision is changes requested when any reviewer asked, else approved when any
  approved. The list carries no checks, so its open rows come back `checksPending` unless a settled
  rollup is cached for the same source commit; `forge_pull_checks` fetches policy evaluations one
  pull request at a time, since Azure DevOps throttles by load per user, and the rollup is the
  worst of the enabled Build validation and external Status check evaluations, skipping
  `notApplicable` ones (`rejected` or `broken` is `failure`, then `running`, then `queued`, and
  all `approved` is `success`). A queued or running rollup is asked again on the next poll. The
  viewer's identity id comes from `connectionData` once per token and organization, and marks the
  pull requests that are yours or await your vote. The list has no updated time, so a pull request's
  `updatedAt` is its closing time or else its creation time, and its total is the page's size when
  the page is not full, else null.
- **Capabilities.** GitHub: re-run, re-run failed, cancel, logs, drafts, accounts; nouns "pull
  request" and "workflow run"; minimum poll 10 s. Bitbucket: re-run, cancel, logs, drafts, no
  failed-only re-run, no accounts; nouns "pull request" and "pipeline"; minimum poll 30 s. GitLab:
  re-run, re-run failed, cancel, logs, drafts, no accounts; nouns "merge request" and "pipeline";
  minimum poll 10 s. Azure DevOps: re-run failed (and no plain re-run), cancel, logs, drafts, no
  accounts; nouns "pull request" and "build"; minimum poll 20 s. Neither GitLab nor Azure DevOps
  has an Overview request budget; Bitbucket's alone is described in 4.20.
- **Caching.** The resolved repo (remote, branch, and account) is cached per root for 15 s. Tokens
  are cached as above, and the ETag, viewer, and checks caches live as long as the app, as do
  GitLab's pipeline details and commit titles and Azure DevOps's repo ids; a cache that grows
  past 2,000 entries starts over. A change
  made through an Accounts command drops that host's cached tokens and resolved repos at once.

## 4. Front end

### 4.1 Layers

`index.html` stacks three fixed layers (section 2). The backdrop owns z0 and receives no pointer events;
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
one while the Swirling Lights style is mounted (none under Matrix or None). Only expanded terminals in the active tab count: each uses the WebGL renderer until 8 are
on screen, and past that, newly shown ones use the DOM renderer. Collapsing a terminal, or
switching away from its tab, disposes the WebGL addon, freeing its context; expanding it or
switching back attaches one again if the budget allows. If the browser drops a WebGL context
(`onContextLoss`), that pane falls back to the DOM renderer instead of going blank.

**Title strip:** the kind menu (4.11), the status dot (4.8), the bound session's name or the
shell's working directory, any buttons of the pane's own kind (`PaneView.stripActions`; the
Files pane's, 4.12), then a collapse button, a zoom button (with two or more expanded
panes in the tab, 4.2), and a close button that acts as Ctrl+W (`requestClosePane`); the rest of
the strip is the drag handle for docking. The status dot's tooltip shows the waiting reason
(3.3) while the terminal is `waiting`; the strip's text is unchanged. Every pane kind
has the same strip, with its own title and no status dot. The strip always sits in the layout
above the pane's body, for every pane kind and even when the pane is alone in its tab; it is
never a hover overlay, which would sit over the buttons and first row at the top of the pane. The title is cut short with an ellipsis
before the pane's own buttons give up any room.

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
| Ctrl+Shift+Right | Split right (duplicate) |
| Ctrl+Shift+Down | Split down (duplicate) |
| Ctrl+Shift+Left | Split left (duplicate) |
| Ctrl+Shift+Up | Split up (duplicate) |
| Alt+Shift+D | Split auto (duplicate) |
| Ctrl+W | Close pane |
| Ctrl+Shift+M | Collapse pane |
| Ctrl+Shift+Z | Zoom or unzoom the focused pane (4.2) |
| Ctrl+Shift+O | Open a favorite (picker; Enter opens it as a split, Ctrl+Enter opens it collapsed) |
| Ctrl+Shift+R | Open a named layout (picker; opens it as a new tab, 4.6) |
| Ctrl+Shift+L | Open the Launch menu over the focused pane (4.6) |
| Ctrl+Shift+P | Open the command palette (below) |
| Alt+Shift+T | Split with a chosen shell (picker of the available profiles; Enter opens a split, Ctrl+Enter opens it collapsed) |
| Ctrl+Shift+T | New tab (4.10) |
| Ctrl+Shift+W | Close tab |
| Ctrl+Shift+S | New scratch pad (4.15) |
| Ctrl+Shift+E | Files pane for the focused pane's repo (4.12) |
| Ctrl+Shift+G | Git pane for the focused pane's repo (4.13) |
| Ctrl+Shift+H | Search pane for the focused pane's repo (4.14) |
| Ctrl+Shift+X | Open the focused pane's repo in the preferred editor, or its folder outside a repo (3.12) |
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
| Ctrl+Shift+D | Toggle dashboard panel |
| F6 | Move focus into the dashboard panel, or back to the focused pane (4.6) |
| Ctrl+Shift+B | Cycle backdrop scrim strength (saved to `scrim.opacity`) |
| Ctrl+Shift+A | Pause or resume the background animation of the active style (saved to `backdrop.animate`); does nothing under None |
| Ctrl+Shift+N | Focus the next terminal that needs you, across all tabs (4.7) |
| Ctrl+= or Ctrl+Numpad+ | Increase the terminal font size by 1 px (saved to `font.size`; applies to every terminal; 6 to 48 px) |
| Ctrl+- | Decrease the terminal font size by 1 px (saved to `font.size`; applies to every terminal; 6 to 48 px) |
| Ctrl+0 | Reset the terminal font size to the default, 14 px (saved to `font.size`; applies to every terminal) |
| F1 | Open the app dialog on its Help tab (4.18) |
| Ctrl+, | Open the app dialog on its Settings tab |
| F11 | Toggle full screen |

Four more actions have no default key: `showAccounts`, `showShortcuts`, `showCli`, and `showAbout`
open the app dialog on its Accounts, Shortcuts, CLI, and About tabs.

These are built-in defaults. Entries in the settings file (section 8) layer on top, as in
Windows Terminal: an entry for a chord that has a default replaces it, a new chord adds a
binding, and `"action": "unbound"` removes a default so the key reaches the shell.

**Keybinding editor.** Keys are changed in the app dialog's Shortcuts tab (`shortcutsTab.ts`, 4.18), which lists every
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
the tab says where the chord moved from, with Undo and, when that action has no key left,
Assign a key, which scrolls to its row and starts recording there. The notice stays until the
next edit or 10 seconds. Undo is a single write that restores both rows. Reset on a row whose
default chord another action holds opens the strip for those chords (all of them when there are
several) as "Move it back?", and Cancel resets nothing. Reset all, in the footer, confirms and
then empties the `keybindings` array, with the same notice and Undo.

The tab never writes the merged keymap. It sends ops to `settings_keybindings_edit` (in
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
and comments inside it are not kept. The tab does not update itself after a save: the watcher's
`settings://changed` rebuilds the keymap and re-renders the tab, as a hand edit does. A failed
save leaves the rows as they were and shows the error in the notice.

In panes other than terminals, copy, paste, Shift+Enter, Ctrl+Shift+F, and typing act on the
pane's own text fields as a browser would; every other action applies as it does in a
terminal. The Files pane is the exception for Ctrl+Shift+F, which opens its preview's find bar
(4.12).

**Command palette.** Ctrl+Shift+P (`openPalette`) opens one filterable list over every pane, tab,
favorite, layout, the focused repo's pins and worktrees, and every keymap action that makes sense
without a key context. Each row shows its category at the right edge. Enter behaves as the item's
own control does: a pane is focused (expanded first when collapsed), a tab is switched to, a
favorite opens as a split, a layout opens as a new tab, a pin opens as clicking it in the Pins
section does, a worktree opens a terminal there as a split, and an action runs as its key would.
Ctrl+Enter opens a favorite or worktree collapsed. Pins whose path is missing are left out.

Actions left out are `copy`, `paste`, `sendInput` (Claude Code's newline), `switchToTab` (tabs are
items instead), and `openPalette` itself. Labels come from `helpModel.ts`, so the palette and the
Shortcuts tab agree, and each action's hint lists its chords from the live keymap, so overrides show.
`moveFocus` and `resizePane` get one row per direction. Open the Containers tab (4.16), Open the
Ports tab (4.19), Open the Ship tab (4.20), and Check for updates (3.16) are action rows with no
keymap action behind them (`PALETTE_COMMANDS` in `paletteModel.ts`), so they never appear in the
Shortcuts tab or take a key. Open the Ship tab shows the first Ship pane in tab order, backed out
to its Overview (4.20) when it is drilled into a repo, and adds a Ship tab on the Overview when
there is none. It does not depend on the focused pane's repo.

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
Ctrl+Shift+D, hidden by the × button at the right end of its top bar (which also ends a peek),
and peeking open briefly while hidden when a terminal starts waiting. Hiding it with × shows a
toast naming the toggle's current keys and the edge handle. While the panel is neither open nor
peeking, the edge handle, a pill in the 8 px gutter on the panel's side at mid-height that widens
to a chevron on hover, opens it on click, so a user who never learned the shortcut is not stranded. Open, it narrows the panes
from its side. Dragging its inner edge (its left edge when docked right, its right edge when
docked left) resizes it, from 280 px (enough for the top bar and the Launch row each on
one line) up to 60% of the window, and the width is saved with the workspace (section 7); it is
the same width on either side. Its contents, top to bottom, are the top bar, the top slot, Pins,
the lower list, and the footer. Pins, which follow the focused pane and appear and vanish with
it, sit fixed below whatever elements are in the top slot; the lower list and the footer sit at
the bottom, so a focus change never shifts them.

**Columns.** Wide enough, the panel shows two columns side by side under the top bar, which alone
spans both. Each column has its own top slot and its own lower list, laid out as above, and scrolls
on its own; a thin rule separates them. The width alone decides: the panel switches to two columns
once it reaches 600 px and back to one below 568 px, so dragging slowly across the threshold
never flickers between the two. The columns are the same on either side, the left column always
on the left. Each element belongs to one column, in either slot. Pins belong to one column too,
always last in its top slot, and the footer sits at the bottom of the left column. In one column,
the panel shows the left column's top slot, then the right column's top slot, Pins, the left
column's lower list, and the right column's lower list, so the split between top slot and lower
list survives. Elements first go to two columns the first time the panel is that wide: Clock,
Wave, System, Local AI models, Containers, and Ports to the right column, and the rest, with
Pins, to the left; until then every element is in the left column. A column's scrollbar shows only
while the pointer or keyboard focus is in it. Keyboard rows run down the left column, then the
right.

**Top bar.** One line that stays at the panel's top edge while the panel scrolls. On the left,
a Favorites button shows while the Favorites element is disabled and a Layouts button while
Layouts is, each dropping the picker its shortcut opens (Ctrl+Shift+O and Ctrl+Shift+R, 4.5) as a
menu under the button: it filters as you type, Enter opens the selection and Ctrl+Enter opens a
favorite collapsed, and Escape closes it, handing focus back to the button when the keyboard
opened it. Beside the filter, the Favorites menu has a "+ Add" button that adds the focused
terminal's folder as the section's "+" does, disabled when there is none or it is already a
favorite, and the Layouts menu has a "+ Save" button that turns the filter into a name field: a
single row previews "Save as" or, for an existing name in any capitalization, "Replace", Enter
saves, and Escape returns to the filter. The pickers have these buttons however they open, from the
top bar or from their shortcuts. Renaming, removing, and reordering stay with the sections. After
them come icon buttons for Settings (⚙, also bound to Ctrl+,) and Help (?, also bound to F1),
which open the app dialog (4.18) on those tabs. The × that hides the
panel sits alone at the right end. Each button's tooltip ends with its action's current keys in
parentheses, read on hover so a rebinding shows, and leaves them out when the action is unbound.

**Elements.** The elements are Clock, Launch, Favorites, Layouts, Panes, Containers, Ports, Ship,
Local AI models, External sessions, System, and Wave, in that default order; Clock and Launch start in the top slot and the rest
in the lower list. Each has a `dashboard.sections.*` toggle (section 8), on by default except
Favorites, Layouts, System, Wave, and Clock (Favorites and Layouts start as top bar menus, and Launch becomes one when disabled), set from the settings
dialog's Dashboard section or from the panel's own right-click menu, which opens anywhere on the
panel no row's menu claims and lists every element with a check on the shown ones; choosing one
flips its toggle. A disabled element is gone from the panel, not collapsed, and its
rows leave the keyboard rows below. Toggles and `dashboard.side` apply live, and switching
sides while a peek is showing ends the peek.

Clicking a section's header collapses or expands it, and which sections are collapsed is saved
with the workspace (section 7). A thin rule separates each element from the one above it, and
the top slot from Pins below it.

**Order.** The elements reorder by drag: a section by its header, the clock and Wave by grabbing
anywhere on them, with the same movement threshold as favorite rows, so a click on a header still
collapses or expands it. While dragging, a line in the accent color shows where the element
will land, at whichever gap is nearest the pointer in the column under it; Pins and the footer
offer no drop position. Any element can be dropped in the top slot above Pins or the lower list
below it, in either column, and each slot keeps its own order. In one column, a dropped element
joins the column of the shown element just above where it lands in its slot, or just below it at
the slot's top edge, and keeps its own column in an otherwise empty slot or when dropped where it
already was. In two columns, Pins drag by their header to the end of either column's top slot;
in one column they do not drag. Dragging is mouse only. The order is saved with the workspace as
`dashboardSectionOrder`, which elements are in the top slot as `dashboardTopElements`, which are
in the right column as `dashboardRightElements`, and the column holding Pins as
`dashboardPinsColumn` (section 7). A disabled element keeps its place in the order, its slot,
and its column, so enabling it returns it where it was.

**Clock.** One line with no header, no collapse, and no keyboard row. On the left is a binary
grid of three rows of six rounded-square dots: hours (24-hour) on top, then minutes, then
seconds, most significant bit on the left, lit dots in the accent color and unlit dots muted.
The grid is as tall as the time's digits, so the digit height sets each dot's size. On the right is the time as
`h:mm` in 12-hour time with no am/pm and no leading zero on the hour, in white with tabular
numerals. `dashboard.clockStyle` (section 8) shows both, the time only (`time`), or the grid
only (`binary`), applying live. Right-clicking the clock opens its own menu: the three styles
as radio choices (Binary and time, Time only, Binary only), then Hide clock, each saving its
setting. The line is at most 60 px tall and shrinks with the panel's width through a container
query unit on the clock element, so the grid and time stay on one line down to the 280 px
minimum. Its accessible name is the full time with AM or PM. It updates on each second
boundary only while the panel is on screen and the window is shown, catching up at once on
show, and no timer runs while it is disabled.

**Wave.** A looping line (a Lissajous figure) 56 px tall across the panel's width, with no
header, no collapse, and no keyboard row. CPU load sets its horizontal frequency against a fixed
vertical one, from a calm loop when idle to a tighter weave when busy; combined network traffic,
on a log scale that tops out at 10 MB/s, speeds the slow turn of its phase and brightens the line.
A faint copy a little behind the main line gives it depth. Both inputs ease toward each new
reading over about 1.5 s, so the figure morphs rather than jumps. It samples `system_sample`
every 2 s and draws at most 20 frames a second on a small 2D canvas, only while it is enabled,
the panel is on screen, and the window is shown. With `backdrop.animate` off or reduced motion
requested, it holds a still figure redrawn on each sample. Its tooltip and accessible name give
the CPU and network readings.

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
The rows are the top bar's buttons, every section header, the Launch section's
buttons, every favorite, recent folder, layout, pin, container, tab group header, pane card, and
external session, and the footer's button, top to bottom, skipping collapsed and disabled
sections:

- Up and Down move one row, stopping at the ends; Home and End go to the first and last.
- Enter or Space acts as a click on the row, and Ctrl+Enter as a Ctrl+click.
- F2 on a favorite, layout, pin (one whose target exists), or tab group header opens the rename
  field its button, double-click, or menu opens. Enter saves and Escape cancels, both returning focus to the row;
  leaving the field saves, as it does for a mouse rename.
- Left on a row goes to its section's header, and on an expanded header collapses the section.
  Right on a collapsed header expands it, and on an expanded one goes to its first row.
- Tab reaches the buttons inside rows (folder, Open menu, close, remove), which show while their
  row has focus as they do on hover.
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
| Tab group header | Rename (an empty name follows the focused pane's title, as in the tab strip) |
| Containers | Start when any container in the group is stopped, Stop when any runs, Open Containers |
| Ports | Open localhost:&lt;port&gt;, Go to pane (when a pane started it), Show in Ports, Copy URL, Copy command line, Copy folder, Copy PID, Stop &lt;program&gt;... |
| Claude | Focus, Copy path |

A pin whose path is missing is dimmed, and its menu disables everything but Remove pin. A Containers row that only reports an engine not running has no menu.
Section headers, the clock, Wave, the System section, the footer, gaps between
panes, and the backdrop have no menu.

The Open menu button on those rows, and the Files row's menu button (4.12), open the same shared
menu below the button, toggling on a second press. The Git entry waits for the git probe, and the
menu is dropped if another menu opened or closed meanwhile.

**Launch.** Launch and Pins follow the repo (3.8) of the focused pane's folder, or of the last
focused pane that had one; a folder outside any repo counts as its own. A Files pane counts as the
repo it was opened for, not the folder it is showing, so opening a pinned subfolder keeps them on
its repo. Under a **Launch** heading, which does not collapse, one row of equal icon buttons opens
a Terminal, Git, Files, Ship, Search, or Scratch pane, in that order, with Git and Ship for git
repos only; the row fits on one line at the panel's minimum width. Each tooltip names the option,
and those for Git, Files, Search, and Scratch end with the keys of openGit, openFiles, openSearch,
and newScratch, which open the same thing, read on hover like the top bar's; Terminal names none,
since splitAuto opens at the focused pane's folder rather than the repo root, and Ship has no
action. Ship opens a pane drilled into the repo (4.20), not on the Overview. The section is hidden
until some pane has a folder.

While a button is hovered or focused, a preview over the panes shows where its pane will land: the
focused pane outlined and the new pane's share of it shaded and labeled, the existing pane that
Files or Git would bring forward, the whole pane area of an empty tab, or the focused pane with
"opens collapsed: no room".

The **Launch menu** lists the same options plus Containers and Ports, which open as they are
rather than at the repo root, in kind menu order (4.11), with their icons and a letter each (t, g,
f, o, s, c, r, p); Containers is left out while no container engine is installed, as in the kind
menu. A letter chooses its entry, and the highlighted entry shows the same preview. The menu has
an accent border and dims the window behind it, under the preview; a click on the dimmed area
only closes the menu. While the
Launch element is disabled, a **+** button in the top bar, left of **?**, drops it, its tooltip
ending with the keys of openLaunch. openLaunch (Ctrl+Shift+L, 4.5) opens it over the focused pane
whether or not the element is shown.

**Pins.** The same repo's pins (4.12), under a **Pins** heading that collapses and expands them
like any section; it is absent while the repo has no pins. The heading names the folder after the
title ("Pins · bashboard"), dropping the name rather than wrapping when it does not fit. Each pin
shows a file or folder icon and its label or path; clicking one opens it, and pins reorder by
drag and can be renamed and removed.

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
accent color, and clicking a header switches to that tab. Its menu or F2 renames the tab in place. With one tab there
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
  plus the attention pulse (4.7). While a terminal is `waiting`, its whole card also breathes a
  faint accent tint (2.4 s, phased off the wall clock so a rebuild of the card does not restart
  it; a steady tint under reduced motion). Other kinds show their kind's icon.
- The bound agent session's name, or the working directory's last folder, with the full path
  beneath while the header's paths toggle (a `↳` button) is on. With it off (the default) the path line is
  absent and the full path joins the title's tooltip. While the terminal is `waiting`, the line
  beneath is the waiting reason (3.3) in the accent color in place of the folder, whatever the
  toggle, one line with an ellipsis, full text on hover. A `waiting` with no message reads
  "Waiting for you". Other kinds show the pane's title (4.11) and, under the same toggle, its
  folder, if any.
- For a terminal bound to an agent session (3.4), a dimmed line below that with the session's
  model and the tokens in its context, read from its transcript. Claude Code's reads
  "Opus 5.5 · 112k tokens"; the other agents lead with their name, as "Codex · gpt-5.5 · 112k /
  272k tokens". Either half shows alone while the other is unknown (Copilot reports no tokens),
  and the line is absent until the transcript has a model or a count. The count is shown against a
  window only when one is known: Codex's transcript reports it, and for a model loaded in Ollama
  the window is the loaded context length from the Local AI models poll (3.19). Claude Code's
  transcript does not name the window, so its count stands alone rather than guess a fraction.
- For a terminal, time since the last status change.
- A profile badge when the terminal's shell is not Git Bash.
- Whether it is expanded or collapsed. Clicking an expanded card switches to its tab if needed
  and focuses its pane; clicking a collapsed one expands it (4.3).
- A close button, which asks first if a command or agent session is running, or if a scratch
  pad is not empty.

**Containers.** One row per container group (4.16) with its state dot, and a Manage
button (an arrow leaving a square) in the header. Shown while a container engine is available
(3.10) and `dashboard.sections.containers` is on. The setting affects only the dashboard; the kind menu
(4.11) offers a Containers pane whenever an engine is available.

**Ports.** One row per listening TCP port (4.19) that looks like a dev server: one started from
a pane, one with a shell or a coding agent (Claude Code, Codex, or Copilot) among its live
ancestors (`fromShell`), or one whose
program is a known dev runtime (node, python, dotnet, java, postgres, and the like). Ports
started from a pane come first, then the rest by port number. Other programs' ports (a music
app, a sync client) are counted in one muted "+ N other programs" row that opens the Ports tab,
and Windows services and Bashboard itself are left out. A row shows a dot (green for loopback only,
amber when reachable from other machines), the port, the program, and, for a port traced to a
pane, that pane's title in the accent color; its tooltip adds the command line, folder, pid, and
uptime. Clicking a row goes to its pane, or opens the Ports tab on it when no pane started it. A
port that opens while the section is shown flashes once in the accent color. The header's
Manage button (the same arrow leaving a square as Containers) opens the Ports tab. The section
polls only while enabled, expanded, and on screen with the window shown, and reads "Nothing
listening" when the list is empty.

**Ship.** What needs the viewer across the repos pinned to the Ship Overview (4.20), then
what is moving there. The item rows come first: a health branch whose newest run failed ("main failed"), a pull request awaiting the
viewer's review ("#12 needs your review"), and the viewer's own pull request with changes
requested or failing checks ("#12 changes requested", "#12 checks failing"), and the viewer's own
open, non-draft pull request that is approved and has no failing checks, so it waits only on a
merge ("#12 approved by Andrew Cartwright", naming up to two approvers, "and 2 others" past that).
Each row shows a status icon (a failure icon, the success icon for an approval, or the neutral icon
for a review request), the repo's `owner/name`, and that text, with the run's or pull request's
title in its tooltip. Every failure row comes first, in the Overview's attention order, then every
approved row, then at most 5 review request rows. Clicking a branch
row opens that repo's Pipelines in a Ship pane, and a pull request row its Pull requests (4.20
says which pane).

Two summary lines follow. The running line is always shown: with one run queued or running, it
shows that run's repo, branch, pipeline name, and start ("main · Build · 3m ago") and opens the
repo's Pipelines; otherwise it counts them ("0 pipelines running", "3 pipelines running in 2
repos"), naming and opening the repo when they share one, else opening the Overview. The pull
request line counts the open pull requests across the pinned repos, drafts left out ("12 open
PRs"), and adds the review request count when it passes the row cap ("12 open PRs, 7 need your
review"). It is shown when some open pull request has neither a review request row nor an
approved row, or when review requests pass the cap, and opens the Overview. Both count from what each poll already
fetches, a repo's newest 20 runs and 50 open pull requests.

When a pin's last poll failed for want of an account (signed out, or a code host's CLI missing), a
sign-in row leads the section, "Sign in to bitbucket.org for keysys/kweb" or "Sign in for 3
pinned repos", naming the host when every such pin shares one. It opens the Accounts tab (4.20)
on that host, straight to the token form for Bitbucket and Azure DevOps (with the organization
filled in when every such pin shares one). The header's button, the Overview icon,
opens the Overview. The section is never empty: before any pinned repo has loaded it shows the
sign-in row or else a dash, and with no repo pinned it shows a "Pin repos" row
that opens the Overview, since the section is a new user's way into Ship. It reads the Overview's shared store (4.20), which polls only while this
section is shown by `dashboard.sections.ship`, expanded, and on screen with the window shown.

**Local AI models.** Shown while `dashboard.sections.localModels` is on and at least one model
server answers (3.19), and a preview. One header row per answering server (Ollama first, then LM
Studio) shows its name and version, with the server's URL in the tooltip, and a row beneath it
per loaded model shows the model's name, where it runs (`GPU`, `CPU`, or a GPU share, for Ollama
only), its context length, and the time until Ollama unloads it (`never` for a model kept loaded).
A server with nothing loaded reads "No model loaded". A context length under
`localModels.minContext` tokens (default 64000; 0 turns the warning off) is shown in the warning
color, with a tooltip explaining that agents need that much context and that Ollama's is raised
with `OLLAMA_CONTEXT_LENGTH`. The section hides when no server answers. It polls
`model_servers_poll` every 5 seconds only while it is enabled, expanded, and on screen with the
window shown.

**Launch menu.** For each detected agent (3.2) the Launch menu holds an "<agent name> on a local
model" entry while Ollama answers and `ollama` is on `PATH`. The entry is a submenu of the
installed Ollama models (`model_servers_ollama_models`); picking one opens a new terminal at the
launch root and types `ollama launch <agent> --model <model>` into it. The session that starts
is an ordinary agent session, so its card, status, and resume behave as any other.

**External sessions.** Agent sessions running outside this app (Windows Terminal, VS
Code), sorted waiting, then busy, then idle, then by most recent change. Only Claude Code sessions
appear, since the others have no session files and bind to a pane by hooks alone (3.2). Clicking a row shows
its cwd and session id with copy buttons. A `waiting` row shows the reason under the folder,
the same as a card. The section is hidden while there are none.

**Footer.** One install button sits at the bottom of the panel for each detected agent whose
hooks are not installed (3.3): "Install Claude Code hooks", "Install Codex hooks (preview)", and
"Install Copilot hooks (preview)". A button reads "Update <agent> hooks" instead when the
agent's hook config is complete and only the hook script is out of date. With every detected
agent's hooks in, the footer takes no space.

The app dialog's Settings tab (`settingsTab.ts`, 4.18) edits every user-facing setting, in the
sections Terminal, Dashboard, Appearance, Background, Editor, Git, Ship, Local AI models, and Restore. A filter field above them
shows only the fields whose label, hint, group, or section holds every word typed, and hides
sections left empty. Dashboard holds the side choice, Left or Right, and a
checkbox per element under "Show on the dashboard", followed by the Clock style select while the
clock is on. Terminal includes a Default shell
select listing the available profiles. Editor selects the preferred editor from those found (3.12),
plus a custom command field. Ship holds the Overview refresh interval (4.20). Appearance's Font family field suggests installed fonts as you type
(3.17), monospace first, with the bundled JetBrainsMono Nerd Font Mono (3.16) leading. It stays a
text field, so a name that is not installed or a comma-separated fallback list saves as typed;
picking an entry replaces the whole value and saves it at once. The list loads after the tab
opens. Each change is written to settings.json
through the app, so the file's comments survive. Toggles save immediately; number and text fields
save on blur or Enter; the shell arguments list (one argument per line) saves on blur or Ctrl+Enter;
sliders save shortly after the drag stops and show the live value. Invalid input (out of range,
empty, or not a number) shows an inline error and is not saved, and a failed save shows an inline
error too. When settings.json changes on disk while the tab is open, every control except the
focused one refreshes. Fields that do not apply live say so beside the control:
dashboard.visibleOnStart and restore.* apply at the next launch, and shell.* applies to panes opened
afterward. Warnings about the current settings appear at the top of the tab. The Open
settings.json button in the footer opens the file in the default editor, with the note "Keyboard
shortcuts are changed in the Shortcuts tab; keys that type text are added to the "keybindings"
list in settings.json."

A peek overlays the panes from the panel's side without narrowing them. It ends after a few seconds, but stays
while the pointer is over the panel and ends when the pointer leaves; opening the panel ends
it too.

Under the Swirling Lights background, every row tied to an agent session has a hue swatch
matching that session's lineage color in the backdrop (6.3), which is how the backdrop and the
dashboard stay readable as one system. A pane card carries it on the model line, aligned under
the title. Matrix and None draw no lineages, so the swatches hide.

### 4.7 Attention

When a terminal enters `waiting`, or rings the bell (`term.onBell`, which also catches the
existing `printf '\a'` hook):

- An expanded terminal's pane border pulses until it is focused; a collapsed terminal's card
  pulses until it is expanded. A terminal in a background tab also pulses that tab in the tab
  strip and its group header in the dashboard, until none of the tab's terminals is marked.
- A terminal being **looked at** (the focused, expanded pane of the active tab in a focused
  window) is not marked. Attention clears when the pane becomes the one looked at,
  including when switching to its tab or when the window regains focus with it focused.
- If the window is unfocused, the taskbar button flashes. For `waiting` (not the bell), and while
  `terminal.notifyWhenWaiting` is on, a Windows notification (`toast.rs`) also shows the pane's
  title and its waiting reason; clicking it brings the window forward and focuses that pane. A
  debug build sends it under PowerShell's AppUserModelID, since Windows drops toasts from an id no
  Start menu shortcut registers.

`done` and `failed` (4.8) are quieter: they change the status dot on the title strip, card,
tab, and group header, and nothing else. They raise no attention, so no pulse, taskbar flash, or
panel peek.

**Next terminal that needs you.** `nextAttention` (Ctrl+Shift+N) focuses the next such
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

1. **Bound agent session.** Its session status (section 7): `busy` shows as `working`, `idle`
   as `idle` (or `done`, below), `waiting` as `waiting`, and `unknown` falls through to the
   shell.
2. **Shell activity.** `working` while a foreground command runs, otherwise `idle`. OSC 133
   markers give exact transitions: `C` (command started) to `working`, `D` (command finished)
   to `idle`. A shell without the `~/.bashrc` lines (4.2) falls back to the core's activity
   sweep (3.1), which reports `working` while the shell has a running job (background jobs
   included), up to 2 seconds late.

Plain shells have no `waiting` state; a program that needs the user rings the bell, which
raises attention (4.7) without changing status.

**Done.** When a bound session's `Stop` hook arrives (any agent's) while its terminal is not being looked
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
agent session is bound, its status resolves first and command marks are not set; when the agent
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
- A terminal that had a live agent session bound when last saved gets its agent's resume command
  typed into it once its shell is ready (the first OSC 133 `A`, or the first output when the
  markers are absent), so the command shows in the terminal and in history like any other. The
  saved pane records the session's `agent`, and `resumeCommand` in `savedWorkspace.ts` builds
  the command:

  | Agent | Command |
  | --- | --- |
  | Claude Code | `claude --resume <sessionId>`, plus `--permission-mode <mode>` when the saved mode is anything but `default` |
  | Codex | `codex resume <sessionId>` |
  | Copilot | `copilot --resume <sessionId> --model <model>`, the `--model` part when a model is saved |

  Claude's mode is the one the session's newest hook event reported, so a change made with
  Shift+Tab after that event is not saved. Copilot's id and model are space-separated because
  `--resume=<id>` exits at once on Windows, and the model is passed back because a resumed
  Copilot session otherwise falls back to the default model. The session id and model are held to
  a safe character set, since they are typed into a shell.
- Each terminal's scrollback is saved as the window closes: xterm.js's serialize addon writes
  the normal buffer as escape sequences, leaving out terminal modes (so a replay cannot turn on
  mouse reporting or bracketed paste) and the alternate buffer. On launch the saved text is
  written into the terminal before its shell spawns, followed by a gray "restored scrollback"
  rule, so the new prompt (and any resumed Claude session) appears below it. Container shells
  and terminals opened from a layout start empty. Only a normal close saves it, so after a crash
  the scrollback is the one from the last clean close.
- A missing or empty workspace opens one tab with one terminal in `startingDirectory`. Closing
  the last tab saves an empty workspace, so the next launch starts fresh.

`restore.enabled`, `restore.resumeSessions`, and `restore.scrollback` (section 8) turn each part
off. `restore.resumeSessions` covers every agent; a settings file that holds the older
`restore.resumeClaude` key and no `restore.resumeSessions` supplies the value from it. With `restore.scrollback` off, closing saves no scrollback and deletes what was saved.

Opening a named layout (4.6) rebuilds one tab the same way, appended as a new tab with the
layout's terminals in their saved directories and profiles. Session ids are always null in a
layout, so no agent session is resumed.

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
- The strip is chrome on z2 and draws over the backdrop with the same scrim as the title strips.
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
| `ship` | The Overview of pinned repos, and one repo's CI runs and open pull requests from its code host | 4.20 |
| `search` | Code search over a repo | 4.14 |
| `scratch` | A plain text scratch pad | 4.15 |
| `containers` | Docker and Podman containers grouped by Compose project | 4.16 |
| `ports` | Listening TCP ports, their processes, and the panes that started them | 4.19 |

Every kind but `scratch`, `containers`, and `ports` has a folder: a terminal's working directory, or the
folder another pane was opened for. A pane's repo is the repo (3.8) of its folder.

- **Ids.** Pane ids come from a front-end counter: `p<n>` for terminals and `v<n>` for other
  kinds. A terminal's pty id (3.1) is separate.
- **Kind menu.** The first control in the title strip shows the pane's kind as an icon.
  Clicking it lists the kinds, and choosing one replaces the pane in place: same spot in the
  tree, same folder. A pane with no folder passes on the Launch section's repo (4.6), except for
  Ship, which opens on the Overview (4.20) rather than on that repo. Replacing a
  terminal with a running command or a live Claude session asks first, as closing it does, and
  so does replacing a scratch pad that is not empty. A terminal chosen from the menu runs the
  default profile. The menu lists Containers only while a container engine is available (3.10),
  whatever `dashboard.sections.containers` says. It is drawn by the shared context menu module (4.4)
  below the button, with the current kind checked; choosing the current kind does nothing. The
  title strip's right-click menu offers the same entries as its Change kind submenu.
- **Opening.** Ctrl+Shift+S, E, G, and H (4.5), Launch, and the Open menu on dashboard
  rows (4.6) open a pane as a split of the focused pane, the way a favorite does: when there is
  no room, a toast says so and the pane opens collapsed. A Git pane for a repo that already has
  one in the active tab focuses that one instead.
- **Common behavior.** Every kind has the title strip, focus border, docking, collapsing,
  and closing that terminals have. Status, attention, and the WebGL budget apply to terminals
  only. A tab's status dot comes from its terminals; its name follows the focused pane's title,
  which for other kinds is the folder's name, a scratch pad's first line, "Containers", or "Ports".
- **Restore.** Each kind saves its state with the workspace (section 7): a Files pane's folder,
  selected file, sort, and whether its preview is expanded (4.12), a Git pane's repo and tab, a Ship pane's repo and tab (or the Overview), a Search pane's
  repo, query, and options (rerun on restore), and a scratch pad's text. A pane whose folder no
  longer exists opens on a notice naming the path, with the kind menu still available. A Files
  pane restored expanded over a file that is missing or cannot be previewed as text shows its list.
- **Layouts** save every kind. Scratch pads are saved empty, so a layout opens fresh pads.

### 4.12 Files and pins

A Files pane shows one folder: on the left, a list with folders first and then files, under a
breadcrumb that leads up to the repo root; on the right, a preview of the selected file. The
divider between them drags. With no file selected (nothing, or a folder), the preview and
divider hide and the list fills the pane. The list follows the folder on disk (`fs_watch`, 3.8).

**Sort.** A button in the breadcrumb, left of the list's zoom buttons, shows the order (such as
"Modified ↓") and opens a menu of Name, Type, and Modified, the current one checked
(`sortEntries`, `nextSort`). Picking the current key reverses it; picking another starts it A to
Z for Name and Type and newest first for Modified. Type compares extensions, ignoring case (a
dotfile such as `.gitignore` has none). Ties go by name, A to Z. Folders stay above the files and
sort by name, A to Z, under every key except Name descending, which reverses them too. A new pane
starts at Modified, newest first; each pane saves its own sort (4.11).

**Title strip buttons.** After the folder's name, the title strip (4.4) carries Open in File
Explorer, Search in this folder (described below), and Open terminal here, all for the current
folder.

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
the sort button and the pin button. Ctrl+wheel over the list or the preview steps that
one's level too: a mouse notch is one step, and a touchpad pinch adds up its small deltas so it
steps a level at a time rather than jumping to either end. Each scales from its base size (the
terminal font size for code and the text editor) and holds while browsing the pane. Every step is
saved to `textZoom.filePreview` or `textZoom.filesList` in workspace.json (section 7), the level
a new Files pane starts at; other open panes keep their own. The Git diff (4.13), the Search
preview (4.14), scratch pads (4.15), and the Containers logs panel (4.16) zoom the same way,
each under its own `textZoom` key.

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
- Search in this folder (folders only): as the title strip button below.
- Open in editor.
- Copy path.
- Insert path: pastes the path, relative to the Files pane's root and quoted for the shell of
  the tab's most recently focused terminal (`pathInsertText`, 4.4), as a bracketed paste without
  Enter, then focuses that terminal.
- Move to (files only, and only when there are targets): the repo's pinned folders and the
  current folder's subfolders (`fs_move`), as a submenu.
- Rename: as F2, below.
- Pin.

The title strip's Search in this folder button shows the Search pane's kind icon (⌕). It opens a new Search pane (4.14) as a split of the Files pane, on the
folder's own repo root (`repo_root`, since a Files pane opened outside any repo can browse into
one), with Files to include set to the folder as an anchored glob (`/src/ui/**`, glob characters
escaped and a comma standing in as `?`; `folderInclude`), or empty at the repo root, and focuses
its query field. A right-click on the breadcrumb, or on the list outside any row (or the
Menu key with no row selected), opens a menu for the current folder: Open terminal here, Open in
File Explorer, Search in this folder, Copy path, and Pin, which reads Unpin while the folder is pinned and toggles it as the pin button
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
- F2 renames the cursor's entry, selecting just it: its name becomes a field with a file's name
  selected up to its extension. The field marks a name Windows forbids or another entry has (a
  change of case alone is allowed). Enter renames through `fs_rename`, after saving the preview's
  pending text, and the renamed entry stays selected and previewed; a failure is toasted. Escape
  or leaving the field cancels, so a stray click never renames on disk. The list holds its
  refreshes while the field is open.
- Typing a printable character filters the list to names containing the typed text, ignoring
  case, and shows the filter above the list with a clear button. Backspace edits it, and Esc
  clears it. Moving to another folder clears it too.
- Backspace with no filter goes up one folder, stopping at the repo root.

**History.** Back and forward buttons beside the breadcrumb step through the folders this pane
has shown, as a browser does; the mouse's back and forward buttons do the same over the pane.
History is not saved.

**Pins** are files and folders kept per repo in `repos.json` (section 7). A pin inside the repo
is stored relative to its root; one outside it, such as a meeting notes folder, is stored as an
absolute path. The breadcrumb's pin button pins the current folder. In the Pins section
(4.6), clicking a pinned folder shows it in the active tab's Files pane for that repo, or opens
one; clicking a pinned file does the same with its folder and selects it. A pin whose path no
longer exists is shown dimmed and opens nothing.

### 4.13 Git pane

For one git repo. A head row spans the pane: the **branch line** and the **Changes** and
**Branches** tabs. The tab shows in workspace.json as the pane's `tab`, absent for Changes.

The **branch line** shows the branch with its upstream and the ahead and behind counts, the last
fetch label, and the Fetch, Pull, and Push buttons. Clicking the branch name opens the
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
headers kept. A diff over the cap says so. The bar above the diff ends in − and + zoom buttons,
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

### 4.14 Search pane

A query field with toggles for Match case, Whole word, and Regex, and a Files to include field
taking a glob. The search runs 250 ms after typing stops (3.11). Opening the pane while the
focused terminal has a selection starts with that text as the query.

Results list matching file names first, then matches grouped by file, each group collapsible,
with line numbers and the match highlighted. A footer gives the count, or says the results stop
at the first 5,000. Up and Down move through matches.

**Preview.** Selecting a result previews its file beside the list in the Files pane's preview
(`FilePreview`, 4.12) in source mode: every text file, markdown included, opens in the text editor
with line numbers, since results point at source lines. A match scrolls its line to the middle
and marks it with a band, with the caret at its start; the list keeps focus, so Up and Down go on
stepping. Stepping between matches in one file moves the band without re-reading the file; a new
search makes the next selection read it again. The editor saves as it does in the Files pane, and
Find, the preview menu, and the − and + zoom buttons work as there, the zoom saving to
`textZoom.searchPreview`. The Search pane has no folder watch, so a file changed on disk while
previewed is caught by the editor's save conflict check rather than a reload. Esc in the preview,
when no find bar takes it, focuses the results list.

When focus leaves the preview after a save there, the search runs again (debounced, so the click
that moved focus lands first), since the edit may have moved or removed matches. If the selected
row is gone from that run's results, the selection clears but the preview stays.

**Row buttons.** A hovered or selected row, and a hovered file group header, shows two buttons:
Show in Files (the Files pane's kind icon) and Open in editor (↗). Show in Files shows the file's
folder with the file selected in the tab's Files pane for the repo, or opens one (`showFiles`,
4.12). Open in editor, Enter, and a double click open the file in the editor at that line (3.12);
on a group header or file name row, with no line. Match rows, file group headers, and file name
rows drag the file's path, with no line number, onto a terminal or scratch pad (4.4).

A right-click on a match row offers Open in editor and Show in Files, then Copy path and Insert
path after a separator. A file group header has the same menu with Collapse or Expand after
another separator; a file name row has it without the collapse item. Copy path and Insert path
use the file's path with no line number.

### 4.15 Scratch pads

A scratch pad is an untitled text area, like a new tab in Notepad++, in the terminal font. Its
title is its first non-empty line, shortened, or "Scratch". It saves to `scratch/<id>.txt` (3.7)
half a second after typing stops and comes back on restore.

- **Send** (Ctrl+Enter) pastes the whole text into the tab's most recently focused terminal as a
  bracketed paste without Enter, so a prompt can be drafted here and reviewed before sending,
  then focuses that terminal. It is disabled while the tab has no terminal.
- **Copy** copies the whole text. **Clear** empties it.
- **Save as** writes it to a file chosen in the native save dialog, opened from the core, then
  turns the pad into a Files pane (4.12) on that file's folder with the file selected and its
  preview filling the pane, so further edits save to the file through the text editor. The pad's
  own `scratch/<id>.txt` is deleted, leaving the file as the only copy. Text typed while the
  dialog was open is not in the file, so the pad then stays a pad.
- **− and +** at the toolbar's right end, and Ctrl+wheel over the pad, zoom its text as the Files
  pane's buttons do (4.12), saving to `textZoom.scratch`. Layout checks measure the pad at its
  unzoomed size, so zooming does not change which splits fit.

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
such as "1 of 2", then one hover button. A single-container group's button is Start when it is
stopped and Stop when it runs; a group of two or more has a details button (›) that opens the
Containers tab with that group expanded, so a partly running group is never started or stopped
without seeing which containers it holds. Clicking a row also opens the Containers tab with that
group expanded. An engine that
is not running adds a single row saying so, such as "Podman is not running", with a Start button
at its right, always shown, when the app can start that engine (3.10). While it starts the row
reads "Podman is starting…" and has no button. The dashboard never stops an engine.

**Containers tab.** Open Containers switches to the tab holding a Containers pane, focusing it,
or appends a tab named "Containers" with one. A Containers pane is an ordinary pane and can be
docked anywhere.

**Containers pane.** One heading per available engine, Docker and then Podman, each showing
whether that engine is running, starting, or stopping, and at its right a Start button when the
engine is not running or a Stop button when it is, for each the app can do (3.10). A lone engine
gets a heading only when it has one of those buttons. Stop asks first, saying how many running
containers will stop and that the engine shuts down for every app that uses it. The buttons are
disabled while a start or stop runs. Under each,
groups expand to their containers. Each container row shows its state dot,
service or container name, image, status text ("Up 3 hours"), published ports as links to
`http://localhost:<port>` (through `open_url`), and CPU and memory, refreshed every 5 seconds
while the pane is on screen. Groups and containers have Start, Stop, and Restart; containers also
have Logs and Shell. The buttons are always shown at the row's right edge, disabled while the
state rules one out (Start on a running container, Shell on a stopped one, Start, Stop, and
Restart while an action on it runs), so they line up down the list; a group heading holds blank space where a
container row has Logs and Shell, so its three buttons sit over its containers' own.

- **Logs**, which follow the container's output in a panel beside the list. Scrolling up stops
  following; scrolling to the end resumes it. The panel's header has − and + zoom buttons before
  Close that, with Ctrl+wheel over the panel, work as the Files pane's do (4.12) and save to
  `textZoom.containerLogs`; a zoom keeps a following panel at the end.
- **Shell**, which opens a terminal running a shell in the container (3.10) as a split beside
  the pane, titled with the container's name. Container shells are not saved by restore or in
  layouts.

A right-click on a group heading offers Start, Stop, and Restart, enabled as the heading's
buttons are. A right-click on a container row offers Start, Stop, Restart, Logs, and Shell
(enabled only while running); then one Open `localhost:<port>` per distinct published TCP port;
then Copy name. A dashboard Containers row has its own menu (4.6).

### 4.17 Setup wizard

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
   shell is Git Bash, PowerShell 7, or Windows PowerShell and its file does not already hold the
   current block (3.14); hidden for cmd, which needs no lines, and when the file's state could
   not be read. Every installed shell's state is read in the background when the wizard opens,
   so changing the Shell step's choice adds or drops this step at once, updating the step count
   without re-rendering the Shell step. It lists the lines and the file they go in, notes the
   backup, any `.bash_profile` it will create, and any warning (a `.bash_profile` that skips
   `.bashrc`, or an execution policy that blocks the profile), and runs the install with Add to
   .bashrc or Add to profile. A `custom` status shows the lines and an error instead of the
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
   Lights, Matrix; `backdrop.style`). Animate the background (`backdrop.animate`) and Brightness
   (Low, Medium, High, the scrim presets of section 5 from darkest), both hidden under None. Accent
   color as swatches of its presets (`accentColor`), and Text color as an Accent tint swatch, drawn
   from the accent shown, and a White one (`contentTextColor`). Picking Matrix turns the accent
   to the Green preset while it is still at its default, to go with the green rain, and the
   accent tint follows; picking another background turns the accent back only when the wizard
   turned it green and it is still green, so a color the user chose is never overridden.

### 4.18 App dialog

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

### 4.19 Ports

Background dev servers are easy to lose track of, above all ones an agent started in a pane, so
Bashboard lists every listening TCP port with the process behind it and, where it can tell, the
pane that started it.

**Source.** `ports_list()` (`ports.rs`) reads Windows' IPv4 and IPv6 listener tables
(`GetExtendedTcpTable` with owning pids) and folds them into one row per port and process, its
addresses IPv4 first. Each row joins the process's name, start time, command line, and working
folder from `sysinfo`; command lines and folders are read once per process. A process in session
0 (a Windows service), one whose session Windows will not report (a protected service), or pid
4 and below (the kernel) is marked `system`, and Bashboard's own process `own`. `fromShell` is
set when a live ancestor, the process included, is a shell (bash, sh, zsh, fish, cmd, pwsh,
powershell, nu) or Claude Code, walked the same way as the owning pane below.

**Owning pane.** A row's `ptyId` is the pane terminal (3.1) it came from. The core walks the
process's parent chain up to a pane's shell, stopping at a parent that started after its child,
which is a reused pid rather than the real parent. MSYS exec can leave a process parented to a
fork stub that has already exited; such a process still shares its pane's ConPTY console host,
which is checked next, as the activity sweep does (4.8). An attribution sticks to the process (its
pid and start time) once found, so it survives the intermediate shells exiting, and lapses when
the pane closes.

**Polling.** `PortsStore` holds the latest list for the dashboard section and every Ports pane.
It polls every 3 s while any of them wants it (the section shown and expanded on screen, or an
expanded Ports pane), polls at once when the first one starts, and polls again right after a
stop.

**Stop.** A row's context menu offers Stop, and so does the Ports pane's Stop button; the
dashboard section has no button for it. It asks first, naming the program,
pid, port, command line, and where it came from, then runs `taskkill /PID <pid> /T /F`, ending the
process and everything it started. `ports_stop(pid, startedAt)` refuses when the pid now belongs
to a process with another start time, refuses pid 4 and below and Bashboard itself, and a toast
reports the result.

**Ports tab.** The dashboard's Manage button and Show in Ports switch to the first Ports pane in
tab order, expanding it if collapsed, or add a Ports tab holding one, then select the row asked
for. A Ports pane is also in the kind menu (4.11).

**Ports pane.** A bar holds a filter field (matching the port, program, command line, folder, or
owning pane's title; Escape clears it), a count of the rows shown and hidden, a Started from a
pane checkbox, checked when the pane opens, that keeps only rows whose owning pane is still open
(Show in Ports on a row no pane started, and the "+ N other programs" row, clear it so the rows
they point at show), a Windows services
checkbox that also lists `system` rows, dimmed, and a Command lines checkbox, unchecked when the
pane opens, that shows each row's command line. The count sits left of the checkboxes so its
changing width never moves them. The list is a grid under a sticky header, with the columns
dot, Port, Program, Pane (the owning pane's title, in the accent color), Address ("localhost",
"all interfaces", or the address itself), PID, Up, and the buttons Open, Go to pane (disabled
when no pane started it), and Stop (disabled for Bashboard and pid 4 and below). When no row shown has an owning pane, the
Pane column is dropped from the header, the rows, and the grid. The folder, in monospace and
the content color with home shown as `~` (cut from the left when long), gets a Folder column
after Program when the pane is at least 900px wide, and otherwise sits beneath the row. Beneath
that, when Command lines is checked, comes the command line, in monospace and muted. Rows have
no tooltip, since every detail is in a column; the dot's tooltip reads "Local only" or "Reachable
from other machines". Rows sort by port until a header is clicked; Port, Program, Pane, Address, PID, and Up are
buttons that sort on that column ascending (Up shortest first), a second click descending, with
an arrow on the active one. Ties fall back to port, then pid, and rows with no owning pane stay
last when sorting by Pane in either direction. The sort is not saved. A click selects a row, a double-click outside the buttons opens
`http://localhost:<port>`, and the context menu is the dashboard's, less Show in Ports. When nothing on screen changed but the uptimes, a poll updates them in place rather than
rebuilding the list. The pane saves no state.


### 4.20 Ship pane

A Ship pane has two views. The **Overview** is the default: one row per pinned repo, across GitHub,
Bitbucket, GitLab, and Azure DevOps, showing its deploy branches' health and its open pull requests, ordered by what needs
attention. A repo's own view, reached by drilling into a row, shows its CI runs and pull requests
from the repo's code host (3.20) as two tabs, **Pipelines** and **Pull requests** (the second reads
"Merge requests" on a host whose `prNoun` says so), with an **Overview** crumb at the start of the
tab strip that goes back. The drilled view resolves the repo's root as the Git pane does (4.13); a
folder outside a repo shows a notice. Its title is the repo's name while drilled in (the folder's
name, or the repo's name for one with no clone) and "Ship" on the Overview. The pane saves its
target (`root`, absent on the Overview), its tab, whether This branch is checked on Pipelines
(`thisBranch`) and on Pull requests (`thisBranchPulls`), and whether Open is cleared
(`allPulls`), each default omitted (section 7), and layouts keep it. The last four mean nothing
on the Overview.

**Opening.** An open with no repo context shows the Overview: the palette's Open the Ship tab
(4.5), the dashboard Ship section's header button (4.6), and a Ship pane chosen from the kind
menu (4.11) for a pane with no folder. When a Ship pane already exists, these back it out of any
repo it was drilled into. An open for a repo drills in: Launch's Ship button and menu entry (4.6),
a kind-menu choice that keeps the pane's folder, and a row of the Overview or the dashboard's
Ship section. A row shows the first Ship pane already drilled into that repo, else the first
Ship pane in tab order, drilled into it, else a new Ship tab. A saved pane reopens where it was
left.

**Pins.** The Overview shows the repos in `ship.pinnedRepos` (section 8). A pin's `repo` is
`<host>/<path segments>`, such as `bitbucket.org/keysys/kweb`, and is its identity; `root`, when
set, is a local clone, which gives the repo its local account and an Open terminal here entry;
`branches` adds health branches. Every ship command is addressed by the pin's target, which is its
`root` when set and `remote:<repo>` otherwise (3.20). The drilled view has a **Pin to Overview**
toggle in its bar, a quiet text button like the Git pane's Fetch that reads **Unpin** while pinned, which records the repo's local clone, if
any, as the pin's `root`. Pinning and unpinning rewrite the setting in place through the app, so
the file's comments survive, and an edit made in the file applies on save.

**Overview.** The pane's own bar (This branch, Open, the account chip) is hidden on the Overview,
which has its own line, "Updated 2m ago" (or "Not updated yet"), an **Accounts** button that opens
the Accounts tab (below), and a **Refresh** button that polls every pin at once. The Overview also refreshes when the pane takes focus while its newest
poll is more than 30 s old. With no pins, a note says to pin a repo from its Ship view or add one
there. Each row holds:

- A provider badge (GH for GitHub, BB for Bitbucket, GL for GitLab, AZ for Azure DevOps), the repo's `owner/name` (the full
  `<host>/<path>` in its tooltip), with the health branches under it, and beside them a pull
  request summary: "3 PRs open, 1 draft, 1 needs you, 1 approved", "1 PR open", or "No open pull
  requests" (with the host's noun, as initials when counted; the draft, needs-you, and approved
  parts appear only when nonzero, and approved counts only the viewer's own pull requests that wait
  only on a merge, as the dashboard's approved rows do, 4.6), highlighted in the warning color
  while a review is awaited, else in the success color while one of the viewer's is approved,
  with each approved one and its approvers in its tooltip ("#12 approved by Andrew Cartwright"). Under the summary,
  "2 pipelines running" counts the queued or running runs among the latest 20 on any branch, and
  is absent when none is.
- The **health branches**: the repo's default branch (3.20), then the distinct target branches of
  its open pull requests (a deploy branch is usually one), then the pin's own `branches`. Each shows
  the status icon of its newest run among the repo's latest 20 and the age of that run, with the
  status and the run's title in its tooltip; a branch with none among them reads "No recent run".
- A line with the error's title when the last poll failed, beside the last good data, and a button
  for each sign-in or install command, which runs in a terminal split (see Terminal splits below),
  and for each Accounts action (**Manage accounts**, **Add token**, **Replace token**), which opens
  the Accounts tab on that host.
  Before its first poll lands a row reads "Loading".

**Attention order.** Rows are ordered by the first of these that applies to a repo: a health branch
whose newest run failed; a pull request awaiting the viewer's review; the viewer's own pull request
with changes requested or failing checks, or approved and waiting only on a merge; a health branch with a queued or running run; then by
most recent activity (the newest run or pull request update). The first four ranks keep pin order
among themselves. A pin that has not loaded follows the loaded rows, in pin order. Ages redraw every
30 s while the Overview is on screen.

**Row actions.** Clicking a row drills into its Pipelines; its pull request summary drills into
its Pull requests, and its running count into its Pipelines. The row menu holds **Open Pipelines**, **Open Pull requests**, **Open in
browser** and **Copy link** (both disabled until the repo has resolved), **Open terminal here**
(only for a pin with a `root`), and **Unpin from Overview**. The rows share columns (a subgrid):
the repo and its health branches, then the pull request summary and running count, each as wide as its widest row
and both at the left, then at the right edge the buttons **Pipelines**, **Pull requests**,
**Open**, **Terminal**, and **Copy link**, matching the menu's entries without Unpin. Open and Copy
link are disabled until the repo resolves, and a pin without a `root` keeps an invisible Terminal
in its place, so the buttons line up down the list. Below 560 px of pane width the buttons are
hidden; the menu still holds every action. A drilled view with no clone has no
checked-out branch, so its This branch checkbox is disabled, and its account chip is hidden, since
the account is the host's default one.

**Add repo.** A box at the bottom of the Overview, with a **Pin to Overview** button and Enter,
has a **?** button whose tooltip, also shown under the box on click, explains the forms with
examples, and takes a repo as `owner/name`, `host/owner/name`, or a link: an https, ssh, or scp remote URL, or a
web URL into the repo. A bare `owner/name` is taken as github.com, or as bitbucket.org when every
pin is on Bitbucket. The box resolves the address through `forge_repo` (3.20) and pins the
resolved identity, never the typed text, which can carry credentials or a page suffix; a failure,
or a repo already pinned, shows in place under the box. Below it, suggestions list the folders in
`repos.json` and the favorites that resolve to a supported host's repo, four resolved at a time,
one per repo and not already pinned, filtered by the typed text; clicking one pins the repo with
that folder as its `root`.

**Overview polling.** One shared store (`ShipOverviewStore`, `src/shipOverviewStore.ts`) holds
every pin's data for the Overview and for the dashboard's Ship section (4.6). It polls only
while some consumer wants it, which is an Overview on screen or the dashboard's Ship section
shown and expanded, and while the window is visible. Each pin polls `forge_overview_repo` (3.20)
on its own clock: every `ship.overviewRefreshMinutes` (the heartbeat), or every 60 s while any
of its latest 20 runs is queued or running, so the running count clears promptly. A pin's first poll waits a stagger of up to 500 ms
per pin, within 3 s, so a round of pins does not hit a host at once. When the window or a consumer
returns, only the pins that fell due poll. A rate-limited answer delays that pin by the seconds the
host asked for, or 60 s when it did not say; any other failure waits out the usual interval. A
heartbeat of 0 stops the interval polling, leaving Refresh and the 60 s polling of a repo
with a run in progress. A refresh costs about 3 requests per repo (the runs, the open pull requests, and the checks
of pull requests that changed). Bitbucket allows 1,000 requests an hour per user, shared with
drilled Ship panes and any other tool on the same token, so Bitbucket pins share a budget of 600
Overview requests an hour: each one's interval, the heartbeat and the 60 s running poll alike, is
stretched to at least the pin count times 18 s, which leaves up to three pins at the usual pace and
holds ten to every 3 minutes. Other hosts are not budgeted. While the budget slows Bitbucket below
the 60 s running poll, the bar notes the gap beside the Updated line ("Bitbucket every 3 min").
Pinning or unpinning a Bitbucket repo retimes the others' next poll. Changing a pin's target or
branches takes effect without waiting for the next poll.

**Store.** `ShipStore` (`src/shipStore.ts`) holds one drilled repo's repo info, runs, and pull
requests, shared by every Ship pane on that root and reference counted, so two panes on a repo
make one set of requests. A pane wants its store only while expanded.

**Bar.** On a drilled repo, from the left: the **Overview** crumb and the two tabs; a **This branch** checkbox, clear by default and
shown on both tabs, labeled "This branch (<branch>)" once the branch is known and truncated with
an ellipsis when long; an **Open** checkbox, checked by default and shown on the Pull requests
tab only; the repo's `owner/name`, linking to its `webUrl`, once the repo has
resolved; the account chip; the pin toggle; **Accounts**, which opens the Accounts tab (below) on the repo's
host; and **Refresh**, which polls at once. Each tab keeps its own This branch choice: on
Pipelines it limits the list to runs on the branch, and on Pull requests to pull requests whose
source branch it is, filtered by the host (GitHub's `headRefName`, Bitbucket's
`q=source.branch.name="<branch>"`, GitLab's `source_branch`, Azure DevOps's
`searchCriteria.sourceRefName`) so the 50-item cap never hides one. Each choice is shared by
the panes on one repo: a pane that opens on a repo another pane already shows takes that pane's
choices, and the first pane to open a repo applies its own saved ones. Open is shared the same
way. This branch follows the repo's current local branch, resolved again on every run poll, so a
checkout empties a scoped list and loads the new branch's; a detached HEAD has no branch and
lists every branch. The chip reads
"as @name" and appears only when the host holds several accounts (`capabilities.accounts` and
more than one in `accounts`). It is styled as a warning when the account came from
`cliActive`, since the repo then follows whichever account `gh auth switch` last chose, and
its tooltip says so. Clicking it opens the account menu: one radio entry per signed-in account, a
disabled note that picking sets the repo's `credential.username`, which Git Credential Manager
also uses for push and pull, **Sign in another account**, which runs `gh auth login
--hostname <host> --web` in a terminal split, and a final **Manage accounts**, which opens the
Accounts tab on the repo's host. Picking an account calls `forge_set_account`,
replaces the store's repo, and reloads everything.

**Pipelines.** Each run is a row: a status icon, the run's title (the commit's first line, or the
host's display title), a line beneath it with the workflow or pipeline name when it differs from
the title, `#<number>`, the branch, and the actor, and on the right the age ("5m ago") and the
duration, which runs live for a running run. Ages and durations redraw every second while the
pane is expanded and the window is visible. The status label (tooltip) is Queued, Running,
Waiting for approval, Passed, Failed, Cancelled, Skipped, or Unknown. Clicking a row expands its
jobs. The list is the latest 20 runs, and an empty list says so.

- **Jobs.** Each job shows its status, name, and duration, then its steps when the host reports
  them (GitHub does, and an Azure DevOps job's steps are its tasks; a Bitbucket step carries no
  per-command list and a GitLab job has no steps), with a failed step marked. GitHub's jobs are
  its workflow jobs, Bitbucket's are the pipeline's steps, GitLab's are the pipeline's jobs, and
  Azure DevOps's are the build's timeline jobs, each named with its stage when it has one.
  **Show log** loads
  the job's log on demand: ANSI escapes, GitHub's per-line timestamps, a byte order mark, and
  carriage returns are removed, a log cut to its last 1 MiB says so, and the view starts scrolled
  to the end, where the failure is. An expanded run's jobs reload when a poll changes its status or
  while it is still moving, and a job's open log is kept across reloads.
- **Run buttons.** At each row's right edge: **Open** (in the browser), **Re-run**, **Re-run
  failed**, **Cancel**, and **Copy link**, enabled as the menu's entries of the same names are, with Cancel
  disabled rather than absent on a run that is not live. Every row carries the same buttons, and
  one the host cannot do is hidden on every row alike, so they line up down the list. Clicking one
  acts without expanding the row. Below 420 px of pane width the buttons are hidden, leaving the
  title its room; the menu still holds every action. `runActionStates` in `src/shipMenus.ts`
  decides both the buttons and the menu.
- **Run menu.** Right-click a row: **Open in browser**; **Re-run** (greyed while the run is
  active); **Re-run failed jobs**, only on a host that has it (GitHub, GitLab, and Azure DevOps, where it
  re-runs the build's failed stages and is the only re-run offered), enabled for a failed run;
  **Cancel**, only for a queued or running run on a host that can; and **Copy link**. Cancel opens
  a confirmation naming the run and its branch, whose button reads "Cancel <run noun>" ("Cancel
  workflow run", "Cancel pipeline", "Cancel build"); Re-run and Re-run failed jobs do not ask. A re-run or cancel
  polls again after 3 s, and a failure of either shows as a toast, since the list stays as it was.
  Entries a host cannot do are left out rather than greyed.

**Pull requests.** The 50 most recently updated pull requests: open ones while **Open** is
checked, else those in every state (open, merged, and closed, with Bitbucket's declined and
superseded, GitLab's locked, and Azure DevOps's abandoned counted as closed), under group headers with counts: **Review
requested** (the viewer is a requested reviewer who has not reviewed; a request wins over
ownership), **Yours**, and **Others**; empty groups are left out. Within a group, open ones come
first, then open drafts, then merged and closed ones, each most recently updated first. A row
shows `#<number>`, the title, a Draft badge on an open draft or a Merged or Closed badge, with the
title dimmed, on one that is not open, the
author and source and target branches, the review state (Approved, Changes requested, or Review
pending; Approved names its approvers in its tooltip, and is the one state still shown when the
pane is narrower than 320 px), the checks status icon (a faint pulsing dot while it loads), and the age of the last update. Clicking a row opens the pull
request in the browser. The menu holds **Open in browser**, **Copy link**, and **Copy branch
name**. When the host counts more matching
pull requests than the 50 listed, a note after the groups reads "Showing the latest 50 of 60 open
pull requests.", leaving out "open" while Open is cleared (with "merge requests" on a host that
uses that noun); `src/shipModel.ts` builds the text. Changing Open empties the list and asks
again, dropping any reply to the other question still in flight.

**Polling.** Runs poll while any expanded pane is on the store: every 15 s while a run is queued
or running, else every 60 s, never faster than the host's `minPollSecs`. Pull requests poll only
while some expanded pane on the store is on the Pull requests tab, every `max(4 * minPollSecs, 60)`
s, since they change slowly and cost more on some hosts. Polling pauses while the window is hidden
or minimized and polls at once on return, as the Git pane's fetch does (4.13). A rate-limited
answer delays the next poll by the seconds the host asked for, and any other failure retries after
60 s; the notice's **Retry** and **Refresh** poll at once. When the window regains focus and the
pane's tab shows an error other than rate limiting, the pane polls again, so a sign-in or a new
token made outside the app takes effect without waiting out the retry. A reply to a question the
pane has since changed (another scope, branch, or account) is dropped.

**Toasts.** When a run that was queued or running in one poll is done in the next, a toast says so,
for example "Workflow run passed: CI on main", with an **Open** action that opens the run. A first
load announces nothing, and a run that moved to waiting has not finished. Panes sharing a store
receive the same finished runs and only the first announces them, so each finished run toasts once.

**Notices.** An error that stops a tab from showing anything replaces that tab's list with a setup
notice: what happened, and buttons that do the next step. An error from resolving the repo shows on
both tabs; one from polling runs or pull requests, only on its own tab. `src/shipModel.ts` builds
the notices from the error and the repo, and `ShipNotice` draws them. The buttons run a command in
a terminal split of this pane, open a URL, copy text (with a "Copied" toast), open the account
menu, open the Accounts tab, or retry.

**Terminal splits.** A command from a notice or the account menu (sign in, install) runs in a
terminal split off the pane, in the repo folder (the default starting folder when run from the
Overview, which has none), after focusing the Ship pane when it is expanded.
The terminal runs the command in place of a shell, as a container shell does (4.16), so a clean exit
closes it and a nonzero exit leaves it readable. Restore brings back one still open at quit as a
plain shell in that folder, since the command is not saved.

| Error | Notice and its buttons |
| --- | --- |
| `notInstalled`, GitHub | "Bashboard reads GitHub through the GitHub CLI." **Install with winget**, **Open cli.github.com**, **Manage accounts**, **Retry** |
| `notInstalled`, GitLab | "Bashboard reads GitLab through the GitLab CLI." **Install with winget** (`winget install --id GLab.GLab -e`), **Open the GitLab CLI page**, **Manage accounts**, **Retry** |
| `signedOut`, GitHub | "Sign in to `<host>` with the GitHub CLI." **Sign in** (`gh auth login --hostname <host> --web`), **Manage accounts**, **Retry** |
| `signedOut`, GitLab | "Sign in to `<host>` with the GitLab CLI." **Sign in** (`glab auth login --hostname <host>`), **Manage accounts**, **Retry** |
| `signedOut`, Bitbucket, no token | "Bitbucket needs an API token." The reason, the numbered steps, and the scope list, whose last step says to choose Add token here (or run `bb auth bitbucket` in a terminal); **Add token**, **Open the API token page**, **Copy scopes**, **Retry** |
| `signedOut`, Bitbucket, token refused | "Bitbucket rejected the stored API token." Steps and scopes folded under "How to make a new one"; the same buttons, with **Replace token** in place of Add token |
| `forbidden`, Bitbucket | "Bitbucket denied the request", with the message naming the missing scope; the same steps, scopes, and buttons as a refused token, so **Replace token** leads |
| `signedOut`, Azure DevOps, no token | "Azure DevOps needs a personal access token." The core's message naming the organization, the numbered steps and the scope list, whose last step says to choose Add token here (or run `bb auth azure-devops <org>` in a terminal); **Add token**, **Open the token page** (the organization's `_usersSettings/tokens` page), **Copy scopes**, **Sign in with Azure CLI** (`az login`), **Retry** |
| `signedOut`, Azure DevOps, token refused | "Azure DevOps rejected the token." The message names the source that failed; steps and scopes folded under "How to make a new one"; the same buttons, with **Replace token** in place of Add token |
| `forbidden`, Azure DevOps | "Azure DevOps denied the request", with the message; the same steps, scopes, and buttons as a refused token, so **Replace token** leads |
| `notFound`, GitHub, several accounts | "`<owner>/<name>` wasn't found as @`<account>`." **Use another account** (opens the account menu), **Retry** |
| `ssoRequired` | "Single sign-on needs authorizing", **Authorize** (the host's URL), **Retry** |
| `rateLimited` | "Rate limit reached", with when polling resumes |
| `unsupportedHost` | "`<host>` isn't supported", the message, and how the `ship.hosts` setting names a self-managed host's provider, with an example to copy; **Copy setting**, **Retry**. A message ending "isn't supported yet" (Bitbucket Data Center) shows with **Retry** only |
| `notARepo` | "Not a git repository" |
| `noRemote`, `network`, `other`, other `forbidden` and `notFound` | A titled notice holding the error's message, with **Retry** |

The Bitbucket scope list comes from `BITBUCKET_SCOPE_INFO` and is shown as a table in
[setup.md](setup.md#bitbucket-cloud): `read:repository:bitbucket`, `read:pullrequest:bitbucket`,
`read:pipeline:bitbucket`, `write:pipeline:bitbucket` (optional, for re-run and stop), and
`read:user:bitbucket`. **Copy scopes** copies them space separated. The Azure DevOps scope list
comes from `AZURE_DEVOPS_SCOPE_INFO`, `Code (Read)` and `Build (Read & execute)`, shown in
[setup.md](setup.md#azure-devops); its **Copy scopes** copies them comma separated.

**Accounts tab.** The app dialog's Accounts tab (4.18; `accountsTab.ts`, with `forgeHostCard.ts`,
`forgeTokenForm.ts`, and the pure `forgeAccountsModel.ts`) has one card per code host, from
`forge_auth_status` (3.20), which the tab asks with what it knows: the hosts of pins and open Ship
panes, and the folders of open terminal panes. The cards the core marks detected come first, in its
order: GitHub hosts (`github.com` first), GitLab hosts, `bitbucket.org`, then `dev.azure.com`. Every
other card folds under a **More hosts (N)** toggle, absent at zero, that reveals them dimmed, each
marked "Not detected on this machine". `github.com`, `gitlab.com`, `bitbucket.org`, and
`dev.azure.com` always have a card, so a host can be set up before it is used. A detected card's
tooltip lists why: GitHub CLI is signed in, GitLab CLI's config names it, the `ship.hosts` setting, a
pinned repo or open Ship pane, a terminal pane's repo, a stored API token or personal access
token, `AZURE_DEVOPS_EXT_PAT` is set, or Azure CLI is installed. A card shows
status and never a token. The tab loads when it is shown, when the window regains focus, and on
`forge://auth-changed`, so a sign-in finished in a terminal pane appears without a restart.

- **GitHub card.** Whether `gh` is installed; the signed-in accounts, the active one badged; and
  the status line for the active account's token source (GitHub CLI, Git Credential Manager, or
  none). A card whose only source is Git Credential Manager has no account rows and offers a
  card-level **Test**. Buttons: **Sign in** (**Sign in another account** once an account exists),
  which runs `gh auth login --hostname <host> --web` in a new terminal pane; **Install GitHub CLI**
  while `gh` is missing, which runs `winget install --id GitHub.cli -e` the same way. The dialog
  closes first, since it is modal and the sign-in device code would open hidden behind it. Each
  account row has **Make active** (not on the active one), which runs `gh auth switch` in the core;
  **Sign out**, which asks first ("Signs @name out of GitHub CLI on <host>. Other apps that use gh
  lose this account too.") and then runs `gh auth logout` in the core; and **Test**.
  When the host's `ghEnvToken` is set, a muted note under the status reads "<VAR> is set, so gh in
  a terminal uses that token; Bashboard uses the saved account shown here." Every action stays.
- **GitLab card.** One per GitLab host, titled "GitLab" for `gitlab.com` and "GitLab (<host>)" for a
  self-managed one. The status line is the user GitLab CLI is signed in as ("Signed in as @name
  through GitLab CLI"), else Git Credential Manager's sign-in, else "Not signed in", with ", and
  GitLab CLI is not installed" when `glab` is missing. Buttons: **Install GitLab CLI** while `glab`
  is missing, which runs `winget install --id GLab.GLab -e` in a new terminal pane; **Sign in**
  while it is installed and signed out, which runs `glab auth login --hostname <host>` the same
  way, closing the dialog first; **Sign out** once it is signed in, which asks first ("Signs @name
  out of GitLab CLI on <host>. Other apps that use glab lose this sign-in too.") and then runs
  `glab auth logout` in the core (`forge_glab_logout`); and a card-level **Test** whenever a user
  or any token source exists.
- **Bitbucket card.** Whether a `bashboard:bitbucket.org` token is stored, else the source the app
  would use; Git Credential Manager alone warns that it cannot read pipelines or pull requests.
  Buttons: **Add token** (**Replace token** and **Remove token** once one is stored), **Test**,
  **Open the API token page**, and **Copy scopes**, with the scope list and what each is for
  beneath. **Remove token** asks first, and the Bitbucket panes stop working until a token is
  added again. Add and Replace open the token form below the buttons.
- **Azure DevOps card.** One card for `dev.azure.com`, whatever the organization. The status line
  lists the organizations with a stored PAT ("Personal access token stored for <orgs>"), since a
  stored PAT outranks every other source for its organization; else the source the pane would use
  (the `AZURE_DEVOPS_EXT_PAT` variable, Azure CLI with the user it is signed in as, or Git
  Credential Manager); else "No personal access token stored", with ", and Azure CLI is not
  installed" when `az` is missing. Under it, one row per organization with a stored PAT, each
  with **Replace** (opens the token form with that organization filled in), **Remove** (asks
  first: "Deletes the personal access token Bashboard stored for the <org> organization. Its Ship
  panes fall back to the next token source, if there is one."), and **Test**. Buttons: **Add
  token**, **Sign in with Azure CLI** when `az` is installed (runs `az login` in a new terminal
  pane), a card-level **Test** when a PAT is stored or any source exists, **Open the token page**,
  and **Copy scopes**, with the scope list and what each is for beneath. **Open the token page**
  opens the organization's `_usersSettings/tokens` page for the form's organization, else the
  suggested one, else the first with a stored PAT; with none known it opens the form and asks for
  the organization.
- **Test.** Asks the host who the credential belongs to (3.20) and shows the login and, on GitHub,
  the granted scopes, or the error beside the card; a Bitbucket 403 names the missing scope. On
  GitHub it runs per account, so a signed-in account that is not active can be checked without
  switching to it. On Azure DevOps the credential is per organization: the card's Test checks
  each organization with a stored PAT and then each one a pin or open Ship pane names, one line
  each ("<org>: Signed in as <display name>."), a row's Test checks only its own organization,
  and with no organization to check it says to open an Azure DevOps repo first. A test bypasses
  the response cache, so it reaches the host every time.
- **Token form.** A password field (`type="password"`, `autocomplete="off"`) with **Save** and
  **Cancel**, and a hint that `bb auth bitbucket` (or `bb auth azure-devops <org>`) stores one from
  a terminal. For Azure DevOps a required Organization field, with a `dev.azure.com/` prefix, sits
  above it: Replace fills it from its row, and Add token with the first
  organization a pin or open Ship pane names that has no stored PAT. The value goes to the
  core once, as the argument of `forge_set_token(provider, org, token)`, and the page keeps no copy:
  the field is emptied on save, cancel, when the tab is hidden, and when the dialog closes. Escape
  cancels an open form before it closes the dialog. A failed save shows its error in the form.
- **Changes.** A successful switch, sign-out, save, or removal drops the host's cached credentials
  in the core and emits `forge://auth-changed` (3.20); open Ship panes, the Overview, and the tab
  itself refresh on it. The account chip's per-repo `credential.username` behavior is separate and
  is unchanged.
- **Entry points.** **Accounts** in a drilled Ship bar and in the Overview bar; **Manage
  accounts** in the account chip's menu (the chip shows only with two or more accounts, and not on
  a remote pin); the notice buttons **Manage accounts** (GitHub and GitLab `signedOut` and
  `notInstalled`), **Add token** (Bitbucket and Azure DevOps `signedOut`), and **Replace token** (a
  refused token, and `forbidden`), the last two opening the card with the token form open, and for
  Azure DevOps with the repo's organization filled in; the same buttons on an Overview row's error
  line; and the command palette's "Manage code host accounts" (`showAccounts`, no default key). A
  button that names a host opens the tab, expands More hosts when the card is folded there, and
  scrolls that host's card into view; a host the core had not listed is asked for, so the request
  always lands on a card. The Overview's bar button leaves the choice to the tab.

## 5. Readability

Bloom behind text is the main readability risk, so the whole backdrop is dimmed by `scrim.opacity`
(default 0.5) through a CSS `brightness()` filter on its canvas, at 1 minus the opacity; that
matches a black fill at that opacity, and it covers the gaps between panes as well as what sits
behind them. Ctrl+Shift+B cycles none, light, medium, and heavy presets and saves the choice; an opacity
of 0 leaves the backdrop undimmed. The None style has no canvas, so nothing is dimmed there.

`scrim.blurPx` (default 1) blurs the whole backdrop in the same filter, under every drawn style
and at every scrim opacity. The canvas is oversized by twice the blur on each side, since a blur darkens a band
at the canvas edges as wide as itself, and the oversize pushes that band off screen. Blur over a
constantly redrawing canvas is the most expensive effect here, hence the default of 0.

## 6. Backdrop

The backdrop has three styles, set by `backdrop.style` (section 8): `lights` (Swirling Lights, the
default), `matrix` (Matrix), and `none`. Swirling Lights is the colony simulation drawn by
Three.js, and the one that shows sessions as organisms (6.3). Matrix is falling glyph rain drawn
with Canvas 2D. None mounts nothing, so z0 is empty. Exactly one style is mounted at a time, and
changing the setting swaps it live.

### 6.1 Modules

The backdrop code lives in `src/backdrop/`.

- `src/backdrop/sim/` is the colony simulation, with its Vitest suite, and `src/backdrop/render/` is
  the Three.js renderer. Neither touches the DOM. `backdrop.ts` mounts the two as the Swirling
  Lights style.
- `src/backdrop/matrix/` is the Matrix style: `matrixModel.ts` is the pure, DOM-free rain model
  (unit tested), and `matrixBackdrop.ts` draws it on a canvas and runs its step clock.
- `backdropHandle.ts` holds `StyleBackdrop`, the interface every style exposes. `backdropHost.ts`
  is the `BackdropHost`, which owns the canvas and the mounted style, and `colonyRelay.ts` is the
  `ColonyRelay` that carries sessions across style switches (6.2).
- The backdrop has no HUD, controls, or pointer handling; it never shows an interface or takes
  input.

### 6.2 Backdrop API

The rest of the app talks only to `BackdropHost` (`src/backdrop/backdropHost.ts`). It owns the
`#backdrop` canvas and the mounted style, and exposes `apply(settings.backdrop)`,
`setVisible(visible)`, `setAnimated(animated)`, the requested `style`, and a `colony` for
`ColonySync`. `apply` mounts the style when it differs from the one requested before, and otherwise
only pushes the new options to the mounted style; it rejects only when the latest requested style
fails to mount, which shows a "Could not start the background animation" toast.

- **A fresh canvas per style.** Switching styles disposes the mounted one and replaces the canvas
  element with a clone of the original, taken before any style touched it. A canvas that has held
  a WebGL context cannot give a 2D one, and Matrix sets a mirror transform (6.4) on its canvas,
  which Swirling Lights must not inherit.
- **Lazy loading.** Each style is loaded with a dynamic import when it is first mounted, so
  Three.js and the simulation are parsed only when Swirling Lights is shown; Matrix and None never
  load them. A mount that finishes after a later switch discards its result.
- **When it mounts.** Loading settings starts before the rest of startup, and the backdrop mounts
  as soon as they arrive, overlapping the font and stale-terminal work that follows. The saved
  style is therefore the first one shown, never a different one that is swapped out. If settings
  fail to load, the defaults apply, which is Swirling Lights.
- **The colony relay.** `ColonySync` reports session changes only as they happen, so a colony
  mounted after sessions exist would never hear of them. The `ColonyRelay` is the colony the
  app holds: it records each live session's hue and latest mood, forwards to the Swirling Lights
  colony while one is mounted, and replays every recorded session into a newly mounted colony.
  Switching away and back therefore returns each session's lineage, as a fresh founder (the
  organisms themselves are not preserved). While Matrix or None is mounted, the relay keeps
  recording and forwards nothing.

Every style implements this interface, and each adds its own options:

```ts
export interface StyleBackdrop {
  /** Pause rendering entirely, e.g. while the window is minimized. */
  setVisible(visible: boolean): void;
  /** False freezes the backdrop on a still frame (`backdrop.animate`). */
  setAnimated(animated: boolean): void;
  dispose(): void;
}

// Swirling Lights, src/backdrop/backdrop.ts
export interface BackdropHandle extends StyleBackdrop {
  colony: SessionColony;
  /** `backdrop.maxFps`; 0 is uncapped. */
  setMaxFps(maxFps: number): void;
  /** `backdrop.capacity`, `mutationRate`, `zoom`, and `waitingPulse`. */
  setOptions(options: BackdropOptions): void;
}

export interface SessionColony {
  /** Founds a lineage for a session, or returns the existing one. */
  ensure(sessionId: string, hue: number): void;
  setMood(sessionId: string, mood: 'busy' | 'idle' | 'waiting'): void;
  /** Lets the lineage die out naturally instead of vanishing. */
  release(sessionId: string): void;
}

export function mountBackdrop(canvas: HTMLCanvasElement): BackdropHandle;

// Matrix, src/backdrop/matrix/matrixBackdrop.ts
export interface MatrixBackdrop extends StyleBackdrop {
  /** `backdrop.matrix.color`, `zoom`, `speed`, and `density`. */
  setOptions(options: MatrixOptions): void;
}

export function mountMatrix(canvas: HTMLCanvasElement, options: MatrixOptions): MatrixBackdrop;
```

Swirling Lights' simulation runs at a fixed 12 generations per second, and the camera orbits
slowly, holding still while the OS asks for reduced motion. Its simulation and camera controls are
settings (section 8), all hot-reloaded: population capacity (300 to 5000, default 1000; "Density"
in the dialog) and mutation rate (0 to 4, default 0.2; "Color drift"). Two more: zoom
(0.5 to 3, default 2) divides the camera's home distance, so the colony fills more of the window,
and the camera glides to a changed value; `waitingPulse` (default off) turns on the waiting
pulse below.

The Settings tab groups the backdrop's settings, and the scrim, under "Background
Animation"; the UI calls the backdrop the background animation. It opens with a Background select
(None, Swirling Lights, Matrix) and shows only the fields that apply to the chosen style. The
scrim's controls are labeled "Brightness" (shown as 1 minus `scrim.opacity`, so the far left is
fully dimmed) and "Blur".

| Style | Always shown | Also shown while `backdrop.animate` is on |
| --- | --- | --- |
| None | Background | (nothing) |
| Swirling Lights | Background, Animate, Brightness, Blur, Zoom | Frame rate cap, Density, Color drift, Pulse waiting sessions |
| Matrix | Background, Animate, Brightness, Blur, Color, Zoom, Density | Speed |

While `backdrop.animate` is off, the fields a still frame can't show are hidden. Zoom, Brightness,
and Blur still change the frozen view, and so do Matrix's Color and Density, which redraw the still
frame. Matrix has its own Zoom
(`backdrop.matrix.zoom`), separate from Swirling Lights' (`backdrop.zoom`).

### 6.3 Sessions as organisms

These apply to the Swirling Lights style; Matrix and None show no lineages.

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
- **Background floor.** Since session lineages keep the colony from ever emptying, the
  background (non-session) colony is tended on its own: when its living count falls below 15
  percent of capacity, a founder spore is planted near the colony's center every 120 generations
  until it recovers, and 6 generations after it dies out entirely.
- **Changes to the copied code:** per-lineage fertility multipliers, blight immunity, and the
  background floor in
  `src/backdrop/sim/simulation.ts`, a per-lineage pulse attribute in the organism shader, and the
  `SessionColony` bookkeeping. All of it stays render-free in `src/backdrop/sim` except the pulse.

### 6.4 Performance

**Swirling Lights**

- It renders at up to `backdrop.maxFps` (section 8), 20 by default, or at the display's full
  frame rate when it is 0.
  The frame loop still runs on `requestAnimationFrame` and skips any frame that arrives sooner
  than `1 / maxFps` after the last rendered one. The simulation advances by elapsed time, so a
  cap lowers smoothness, not speed. The setting hot-reloads.
- `maxFps` is 0 (uncapped) or 20 to 240. The loop clamps each frame's delta to 1/20 s, so a cap
  below 20 would slow the simulation itself.
- `backdrop.animate: false` stops the frame loop and leaves the backdrop on a still frame, redrawn only
  when the window resizes. Either way, the backdrop pre-warms at mount, simulating up to 16
  seconds headless before its first frame, so it opens at the configured zoom on a grown colony,
  not the lone founding spore. The pre-warm stops after 500 ms of wall-clock time, so a large
  `capacity` opens on a younger colony rather than delaying the first paint. It hot-reloads; turning it back on
  resumes from the still.
- The renderer is created with `preserveDrawingBuffer: false` and alpha disabled; the
  terminals composite over it through normal CSS stacking, with no readback. Disposing it forces
  its WebGL context to be lost, since Chromium caps live contexts and would otherwise keep the
  context until garbage collection.

**Matrix**

- It is a Canvas 2D renderer, `src/backdrop/matrix/matrixBackdrop.ts`, over the pure model in
  `matrixModel.ts`. The model is a grid of cells sized from the canvas and the cell size, with
  one falling drop per column. Each step moves every drop down one row and returns the glyphs to
  draw: the drop's new head cell, and the previous head cell again as ordinary trail so the bright
  head does not leave a white streak. A column whose drop has fallen off the bottom sits idle,
  and each step an idle column starts a new drop at the top with a fixed chance (3 percent times
  `backdrop.matrix.density`, 0.25 to 4, default 3). Columns start independently, which keeps them
  out of lockstep, and the window opens with every column idle, so the rain arrives rather than
  appearing all at once.
- Glyphs are half-width katakana, the digits, and a few symbols, drawn in the `MS Gothic` or
  `Yu Gothic` font that ships with Windows 10 and 11, with `monospace` as the fallback. No font is
  bundled. Drawing waits for the font to load, so the first frames do not cache fallback glyphs.
- The film's glyphs are mirrored. The renderer sets `transform: scaleX(-1)` on its canvas, which
  the compositor applies for free; drops are column-symmetric, so only the glyph shapes change.
- A cell is 20 px times `backdrop.matrix.zoom`, and the canvas is drawn at the device pixel ratio
  and rebuilt when the window resizes.
- The step rate is `backdrop.matrix.speed` (5 to 30, default 10 steps per second); `maxFps` does
  not apply. Steps are scheduled by elapsed time on `requestAnimationFrame`, at most four per
  frame, so a stall never bursts. The setting hot-reloads.
- Each step paints black over the whole canvas at 8 percent alpha, which fades trails. Alpha
  blending alone stalls once 8-bit rounding stops lowering a channel, leaving a faint permanent
  residue, so every fourth step also applies a color-burn fill with a near-white source that
  subtracts a few levels and clamps at zero. Trails therefore fade to true black. Heads are drawn
  in the chosen color mixed 90 percent toward white.
- `backdrop.animate: false`, or the OS asking for reduced motion, stops the loop on a still frame.
  The frame is built by stepping the rain on a cleared canvas for a screen's worth of rows plus
  two mean idle gaps (at most 400 steps), so the frozen view looks like a running one rather than
  an empty screen. A change to the zoom or the window size rebuilds it, and so does a change of
  color or density.

**All styles**

- `setVisible(false)` on minimize, and when the window is fully covered (Tauri window events
  plus the page's `visibilitychange`), so it costs nothing while out of sight. The dashboard
  clock, Wave, and System section (4.6) pause on the same signal, and Matrix stops its loop on it too.
- Ctrl+Shift+A pauses or resumes the mounted style and saves `backdrop.animate`; under None it
  does nothing and saves nothing.
- None mounts nothing: no renderer, no frame loop, and no Three.js load.

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
| `AgentContext` | `src/agentModel.ts` | `agent_context` and `agent://context` (3.4) |
| `ModelServersSnapshot`, `LoadedModel` | `src/modelServersApi.ts` | `model_servers_poll` (3.19) |
| `ForgeRepo`, `Capabilities`, `Run`, `Job`, `Step`, `JobLog`, `PullList`, `PullRequest`, `Reviewer`, `OverviewRepo`, `PinnedRepo`, `ForgeError`, `HostAuth`, `AuthCheck`, `TokenSourceKind` | `src/forgeApi.ts` | The `forge_*` commands (3.20) and `forge://auth-changed`; the rules are under Ship payloads |
| `ShellProfile` | `src/profiles.ts` | `shell_profiles` (3.1) |

**Ship payloads.** The Rust types (`forge/types.rs`) serialize camelCase, with `Option` as null, and
`src/forgeApi.ts` mirrors them field for field. Times are ISO 8601 strings.

- `ProviderKind`: `github`, `bitbucket`, `gitlab`, or `azureDevOps`. `RunStatus`: `queued`,
  `running`, `waiting`, `success`, `failure`, `cancelled`, `skipped`, or `other`; `waiting` means a
  person must act (GitHub `action_required`, Bitbucket `PAUSED` or `HALTED`, GitLab `manual`). `ReviewState`:
  `approved`, `changesRequested`, or `pending`. `AccountSource`: `repoConfig`, `remoteUrl`,
  `cliActive`, `only`, or `none`.
- `Capabilities`: `rerun`, `rerunFailed`, `cancel`, `jobLogs`, and `drafts` (booleans); `prNoun`
  ("pull request" or "merge request"); `runNoun` ("workflow run", "pipeline", or "build");
  `minPollSecs`, the least spacing between polls; and `accounts`, whether the host can hold several
  signed-in accounts the user picks between.
- `ForgeRepo`: `provider`, `host`, `owner`, `name`, `webUrl`, `branch` (the current local branch,
  null when detached or the target has no clone), `capabilities`, `account` (null when none was chosen), `accountSource`, and
  `accounts` (every account signed in to the host, from GitHub CLI's `hosts.yml`; empty when the
  host has no such notion). For GitLab, `owner` is the group path joined with `/`.
- `Run`: `id`, `number`, `name` (the workflow or pipeline), `title` (the commit message's first
  line, or the display title), `branch`, `sha`, `event`, `status`, `rawStatus` (the host's own
  word), `actor`, `createdAt`, `startedAt`, `finishedAt`, and `webUrl`.
- `Job`: `id`, `name`, `status`, `startedAt`, `finishedAt`, `webUrl`, and `steps`, each a `Step`
  with `number`, `name`, and `status`. A host with no per-command step list returns `steps` empty.
  `JobLog`: `text` and `truncated`, the text being the last 1 MiB when the log is longer.
- `PullList`: `items` (the `PullRequest` rows, at most 50) and `total`, the host's count of open
  pull requests, null when the host does not say.
- `PullRequest`: `id`, `number`, `title`, `author`, `draft`, `sourceBranch`, `targetBranch`,
  `createdAt`, `updatedAt`, `webUrl`, `reviewDecision` (null when the host has no verdict yet),
  `reviewers` (each a `Reviewer` with `login` and `state`), `checks` (null when it has none),
  `checksPending` (checks not fetched yet; Bitbucket, GitLab, and Azure DevOps set it), `isMine`, and `reviewRequested` (the viewer is a requested reviewer who has not reviewed). Both
  flags are false when the viewer cannot be identified.
- `OverviewRepo`: `repo` (a `ForgeRepo`), `defaultBranch` (null when the host does not say or the
  lookup failed), `runs` (the newest 20 on every branch, newest first), and `pulls` (a `PullList`
  of the open pull requests only). It is what `forge_overview_repo` returns (3.20). `PinnedRepo`
  is a `ship.pinnedRepos` entry (section 8): `repo`, and optionally `root` and `branches`.
- `ForgeError`: `kind` (`notARepo`, `noRemote`, `unsupportedHost`, `notInstalled`, `signedOut`,
  `ssoRequired`, `forbidden`, `notFound`, `rateLimited`, `network`, or `other`), `message` (plain
  text, never a token or an `Authorization` header), `url` (a page to open), `signIn` (the argv to
  run in a new terminal pane), and `retryAfterSecs`.
- `HostAuth`: `provider` (a `ProviderKind`), `host`, `cliInstalled` (`gh`, `glab`, or `az` was
  found; false for Bitbucket), `accounts` (the users the CLI holds for the host: several for GitHub
  CLI, at most one for GitLab CLI and Azure CLI; empty for Bitbucket), `activeAccount` (or null),
  `tokenSource` (a `TokenSourceKind`: `ghCli`, `glabCli`, `azCli`, `gitCredentialManager`,
  `bashboardCredential`, or `environment`; null when no source has a token), `storedTokens` (the
  tokens Bashboard stored for the host, each `{ org }`: at most one for Bitbucket, with `org` null,
  and one per Azure DevOps organization), `ghEnvToken` (the variable's name, or null; see 3.20),
  `detected` (some signal says the host is used on this machine), and `detectedBy` (the reasons, in
  words; empty when undetected). It never holds a token. `Known`, the argument of
  `forge_auth_status`, is `{ hosts, dirs }`: `hosts` holds `{ provider, host }` for each pin and
  open Ship pane, and `dirs` the folders of open terminal panes. `AuthCheck`: `ok`, `login`,
  `scopes` (the granted scopes when the host reports them), and `message`. The
  `forge://auth-changed` payload is `{ provider, host }`.

**Session status.** A hook event newer than the roster's `statusUpdatedAt` wins; otherwise the
roster's value. `waiting` exists only from hooks, and clears on the next `UserPromptSubmit`,
`Stop`, or roster change to `busy`. The roster payload carries `waitingReason: string | null`
beside each session's status; it is the agent's waiting reason (3.3) and is present only while
the merged status is `waiting`. Each session also carries `agent` (`claude`, `codex`, or
`copilot`). A terminal's `done` is `idle` after a `Stop`, or a long command
that finished, that the user has not looked at yet; `failed` is the same for a nonzero exit (4.8).

**workspace.json.** Version 3, tabs in strip order. Pane ids do not survive a restart, so panes
are saved under keys, and layout leaves hold those keys. A tab's `name` is null while it follows
its focused pane's title. A version 2 file's tabs hold `terminals`, which load as terminal panes;
a version 1 file, which holds one tab's `terminals`, `layout`, and `focused` at the top level,
loads as a single unnamed tab. Absent optional fields take these defaults:

- `dashboardWidth`: 300 px.
- `dashboardSectionOrder`: the default order. Reading keeps known names once each, drops unknown
  names, and inserts a missing element at its default position relative to its neighbors.
- `dashboardTopElements`: the clock and Launch. Reading keeps known names once each. A file without
  it but with the boolean `dashboardClockTop` gets the clock alone when that is true and an empty
  slot when it is false. When neither list names Launch, it joins the top slot last.
  `dashboardSectionOrder` and `dashboardTopElements` read `folder` and `repo`, Launch's names in
  older files, as `launch`.
- `dashboardRightElements`: no column split yet, so every element is in the left column until the
  panel first shows two columns, which applies the default split (4.6). Reading keeps known names
  once each; a list, even an empty one, means the split has happened.
- `dashboardPinsColumn`: `left`; any other value reads as absent.
- `collapsedSections`: none. Reading keeps known names once each; Launch and the clock never
  collapse, so they are dropped.
- `showPanePaths` (the Panes section's paths toggle, 4.6): false; a non-boolean reads as absent.
- `textZoom` (`filesList`, `filePreview`, `gitDiff`, `searchPreview`, `scratch`, and
  `containerLogs`, the zoom new panes of those kinds start at, 4.12 to 4.16): 1 for an absent
  field or one outside 0.5 to 3.
- A terminal pane's `profile`: the default profile. Its `permissionMode` (letters only, kept
  only beside a `sessionId`): the default mode. Its `agent` (`claude`, `codex`, or `copilot`):
  Claude Code, which an unknown value also reads as. Its `resumeModel` (kept only beside a
  `sessionId`): none. Its `scrollbackId` (the scratch id alphabet):
  none, so the terminal starts without saved scrollback. A Files pane's `root`: resolved from its
  `folder`. Its `expanded`: false. A Ship pane's `root`: none, which opens on the Overview;
  a drilled pane saves its local repo root or `remote:<host>/<path>`. Its `tab`: `pipelines`, the
  other being `pulls`; it is omitted from the file when it is `pipelines`. Its `thisBranch`, `thisBranchPulls`, and
  `allPulls`: false, and each omitted when false; any value but `true` reads as false.

**layouts.json.** Names are unique without regard to case. A layout holds one tab whose
terminals carry no session ids, permission modes, or scrollback ids and whose scratch pads have a null
`scratchId`, so they open fresh; the tab's own `name` is ignored, since it takes the layout's. An
entry whose `workspace` holds a version 1 workspace loads as that one tab.

**repos.json.** Roots compare without regard to case. A pin's path is relative to the root, with
forward slashes, when inside the repo, else absolute. `primaryBranch`, the branch the Git pane
compares worktrees with (4.13), is keyed by the main worktree's path; an entry may hold
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
  // #rrggbb for focus borders, selections, highlights, and the --accent custom property. A value
  // below WCAG relative luminance 0.2 falls back to the default, so it stays readable on the dark
  // panes and behind find highlights' dark text. The dialog offers presets, and shows a hand-edited
  // value as Custom.
  "accentColor": "#4fb3c8",
  // accent or white: content text, read by CSS as --content-fg: scratch panes, the file preview, search
  // results and preview, the Files list, the Git file, commit, and branch lists and diff, the
  // Containers list and logs, the Ports list, and the dashboard's names, values, and clock. Secondary text in those
  // places (line numbers, quotes, sizes, dates) takes dimmer shades of it; toolbars, buttons, and
  // the dashboard's gray labels stay UI gray. Terminals take it only for pure white: the default
  // foreground, bright white, and 256-color index 231 (plain white and truecolor white are
  // untouched). accent is 35% of accentColor mixed into #ececec, with the accent's share lowered
  // as needed to keep WCAG relative luminance at 0.5 or more, so it stays paler than the accent
  // for links and highlights; white is #e6e6e6. A #rrggbb value loads as white when it is
  // #e6e6e6 and as accent otherwise; any other value falls back to accent with a notice.
  "contentTextColor": "accent",
  "scrim": { "opacity": 0.5, "blurPx": 1 },
  // style is none, lights (Swirling Lights), or matrix; a missing or invalid value falls back to
  // lights. animate false freezes lights and matrix on a still frame (6.4); none ignores it.
  // maxFps, capacity, mutationRate, zoom, and waitingPulse apply to lights only: maxFps 0 renders
  // at the display's refresh rate, and the rest are the simulation and camera controls (6.2).
  // matrix.color is green (#00ff41) or accent: accentColor at full brightness with its HSV
  // saturation raised by half, so a gray accent stays gray. A #rrggbb value loads as green when it
  // is #00ff41 and as accent otherwise. matrix.zoom is 0.5 to 3 (the base cell is 20 px);
  // matrix.speed is a whole number of rain steps per second, 5 to 30; matrix.density (0.25 to 4)
  // scales how often a new drop starts. Out-of-range or invalid values fall back to their defaults.
  "backdrop": {
    "style": "lights",
    "animate": false,
    "maxFps": 20,
    "capacity": 1000,
    "mutationRate": 0.2,
    "zoom": 2,
    "waitingPulse": false,
    "matrix": { "color": "green", "zoom": 1, "speed": 10, "density": 3 }
  },
  "scrollback": 10000,
  // A shell command that runs this many seconds and finishes unseen marks its terminal done or
  // failed; 0 turns it off (4.8). notifyWhenWaiting raises a Windows notification when a terminal
  // starts waiting while the window is unfocused (4.7).
  "terminal": { "doneAfterSeconds": 30, "notifyWhenWaiting": true },
  // side is right or left; an unknown value falls back to right. sections shows or hides each
  // dashboard element (4.6). An older file's containers.enabled is still read when
  // sections.containers is absent. clockStyle is both, time, or binary; an unknown value falls
  // back to both.
  "dashboard": {
    "visibleOnStart": true,
    "peekOnWaiting": true,
    "side": "right",
    "sections": {
      "launch": true,
      "favorites": false,
      "layouts": false,
      "panes": true,
      "containers": true,
      "ports": true,
      "ship": true,
      "localModels": true,
      "external": true,
      "system": false,
      "wave": false,
      "clock": false
    },
    "clockStyle": "both"
  },
  // resumeSessions types each agent's resume command into restored terminals (4.9). An older
  // file's resumeClaude is still read when resumeSessions is absent.
  "restore": { "enabled": true, "resumeSessions": true, "scrollback": true },
  // Empty URLs use OLLAMA_HOST, then http://127.0.0.1:11434, for Ollama and
  // http://127.0.0.1:1234 for LM Studio. minContext is the context length under which the Local
  // models section warns (4.6); 0 turns the warning off.
  "localModels": { "ollamaUrl": "", "lmStudioUrl": "", "minContext": 64000 },
  // Host name to provider (github, gitlab, bitbucket, or azureDevOps) for a self-hosted host,
  // matched without regard to case (3.20). A GitHub Enterprise Server host and a self-managed
  // GitLab host are served; the Bitbucket provider refuses any host but bitbucket.org, and the
  // Azure DevOps provider serves dev.azure.com only. Hosts the GitHub CLI is signed in to, and
  // hosts in GitLab CLI's config, need no entry. An entry with
  // another kind is dropped with a warning. No Settings tab field; edit the file.
  // pinnedRepos lists the repos on the Ship Overview (4.20), in order: repo is
  // "<host>/<path segments>" and is the pin's identity, root (optional) is a local clone, and
  // branches (optional) adds health branches beyond the default branch and the open pull requests'
  // targets. An entry with an empty or missing repo, or a root or branches of the wrong type, is
  // dropped with a warning naming its position. overviewRefreshMinutes is the minutes between
  // background refreshes of the Overview, 0 to 1440; 0 leaves only Refresh and the 60 s polling of
  // a repo with a run in progress. It has a Settings tab field; pinnedRepos does not.
  // For example { "repo": "bitbucket.org/keysys/kweb", "root": "C:/src/kweb", "branches": ["uat"] }.
  "ship": { "hosts": {}, "overviewRefreshMinutes": 5, "pinnedRepos": [] },
  // zed, vscode, cursor, visualStudio, notepadpp, sublime, rider, intellij, webstorm,
  // pycharm, rustrover, goland, clion, phpstorm, windsurf, vscodeInsiders, vscodium, or default
  // (the file's default app). A non-empty command replaces it, with {path} and {line} filled in
  // (3.12).
  "editor": { "preferred": "default", "command": "" },
  // Minutes between background fetches of repos with an open Git pane; 0 turns it off (3.9).
  "git": { "autoFetchMinutes": 5 },
  // Added to or overriding the defaults in 4.5. Actions that take an argument take it as
  // a field: switchToTab takes "index" from 1 to 8. The Shortcuts tab (4.18) edits this list,
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
- Ship tokens (3.20) stay in the core's memory. They are read only from `gh auth token`, `glab
  auth status --show-token`, `az account get-access-token`, the `AZURE_DEVOPS_EXT_PAT` variable,
  Git Credential Manager (`git credential fill`, never `approve` or `reject`, never interactive),
  or the credentials that the Accounts tab and `bb auth` write: `bashboard:bitbucket.org` and one
  `bashboard:dev.azure.com/<org>` per Azure DevOps organization. They never
  reach the page, a log, or an error message, and `Token`'s `Debug` output hides the value. The one
  way a secret enters the core is the Accounts tab's password field, which sends a Bitbucket token
  or an Azure DevOps personal access token to `forge_set_token` as a single argument; the core writes it to Windows Credential
  Manager and nowhere else, and overwrites its copies afterward on a best effort basis, since the
  IPC layer's own buffers are outside the app's control. The field is emptied on save, cancel, and
  when the dialog closes. A redirect to another
  host drops the `Authorization` header, the Bitbucket provider refuses any host but
  bitbucket.org before it sends anything, and the Azure DevOps provider calls only dev.azure.com,
  so a self-hosted host's token is never sent to Bitbucket Cloud or Azure DevOps. `bb auth` hides
  its input and never prints the token, and the Accounts tab's status and
  test results carry no token.
- `git`, `docker`, and `podman` run with argument lists, never through a shell, and paths come
  after `--` where the CLI accepts it. `open_in_editor` runs only a detected editor or the
  user's own `editor.command`.

## 10. Testing

Pure modules (no DOM) carry the logic worth testing and are covered by Vitest beside each
module (`src/**/*.test.ts`); the Rust core's tests sit in each module and run against temp
folders, temp repos, captured CLI output, and a spawned pty. Keys are the exception: what
reaches the shell through WebView2 and xterm.js can only be checked by hand, with the keyboard
checklist in [development.md](development.md#releasing) before each release.

The Ship module's providers map captured JSON to the normalized shapes in pure functions, and
build the requests that change a build or pipeline apart from sending them, so the GitHub,
Bitbucket, GitLab, and Azure DevOps mappings, remote parsing and host classification, status-code
mapping, the ETag cache, account choice, the Azure DevOps header scheme by token source, and
token-source order are all tested without a network, and `bb auth`'s argument and token handling
the same. The Accounts tab's host ordering and detection, source kinds, and signed-in check are
Rust tests in `forge/accounts.rs`, and its cards, including the folding of undetected hosts, are a
Vitest module (`forgeAccountsModel.test.ts`). The notices and menus, polling intervals, grouping,
and log cleanup are Vitest cases in `shipModel.test.ts` and `shipMenus.test.ts`. Live checks
against a real repo are `#[ignore]` tests, run by hand with `cargo test forge::github --
--ignored` (it uses `gh auth token`), `cargo test forge::bitbucket -- --ignored` (it uses the
token stored by `bb auth bitbucket`), `cargo test forge::azure_devops -- --ignored` (read-only
requests; it needs `BASHBOARD_ADO_LIVE=<org>/<project>/<repo>` and `AZURE_DEVOPS_EXT_PAT`), and
`cargo test forge::http -- --ignored` (TLS through the Windows certificate store).

CI: a GitHub Actions workflow (`.github/workflows/ci.yml`) on `windows-latest` runs the type
check, Vitest, `cargo test`, and `pnpm tauri build`, then uploads the NSIS installer as the
`bashboard-installer` artifact.

## 11. Risks

- **Undocumented session files.** If Claude Code changes `~/.claude/sessions`, the roster
  degrades to showing only hook-reported sessions in this app's panes. Parsing is lenient and
  failures are logged, never fatal.
- **Codex and Copilot internals.** Their hook payloads, transcripts, and resume flags are
  internal to each tool and can change. Every field is optional on parse, a payload the receiver
  cannot read changes nothing, and `BASHBOARD_HOOK_LOG` captures payloads for reports. Support
  for both is a preview.
- **WebGL contexts.** Many panes plus the Swirling Lights backdrop approach Chromium's limit; the
  budget and DOM fallback in 4.4 cover it, at some cost in rendering speed for the extra panes.
  Disposing the backdrop releases its context at once (6.4), so switching styles does not leak one.
- **GPU cost.** The Swirling Lights backdrop plus bloom behind several WebGL terminals is the
  heaviest part of the app. The visibility pausing in 6.4 means it costs nothing while hidden, and
  `backdrop.maxFps` trims it on weaker GPUs. Matrix is far lighter, and None costs nothing.
- **Resume.** Restore types the agent's resume command (4.9); if that session's transcript is
  gone, the command fails visibly in its terminal rather than silently.
- **Off-screen output.** Collapsed terminals and those in background tabs keep parsing output
  into off-DOM xterm instances; a very chatty one costs parse time, though no rendering.
- **Container CLI output.** The JSON from `docker ps` and `podman ps` is not a stable
  contract, and the two differ. Each engine's parser treats every field as optional, so a
  format change degrades a row rather than the list.
- **Edits racing an agent.** A file can change between a Files pane's read and its save. The
  modified-time check in `fs_write_text` turns that into the Reload or Keep mine choice (4.12)
  instead of a silent overwrite.
- **Ctrl+W.** Bound to close pane (as in the current Windows Terminal setup), so bash's
  delete-previous-word is unavailable unless the settings file unbinds it.
