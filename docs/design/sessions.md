# Agent sessions and hooks

Section numbers are ids shared across `docs/design/`; [the index](README.md#index) maps each to its file.

## 3.2 SessionRoster (`src-tauri/src/roster.rs`)

**Agents.** Each supported coding agent (`claude`, `codex`, `copilot`) is one row of the agent
table, `src/agents.json` (3.24), which carries its display name, home folder, the executables
that identify its process, and the rest of what the roster, hook installer, and front end share.
`src-tauri/src/agents.rs` parses it into an `Agent` per `AgentId` (serialized in lowercase and
parsed by `AgentId::parse`). The home folders sit under the user's home: `USERPROFILE`, else
`HOME`, on Windows, and `HOME` elsewhere. An agent counts as
detected when its home folder exists (for Copilot, with a `session-state` folder inside, since
VS Code's Copilot extension creates `~/.copilot` on its own), which is what `agents_detected()`
reports; detection never consults `PATH`, since VS Code installs a `copilot-shim\copilot.exe`
launcher there that is not the Copilot CLI. Every `Session` carries its `agent`.

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
  `sessions_get()` returns the last list emitted, for the front end's first load.
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

## 3.3 HookReceiver (`src-tauri/src/hooks.rs`)

The roster says whether a session is busy; hooks add what it cannot: "waiting for you" and
exact transitions as they happen.

- On startup the core binds `127.0.0.1:0` (an OS-assigned port) and generates a random
  128-bit token. Every pane's environment gets `BASHBOARD_HOOK_URL` and `BASHBOARD_HOOK_TOKEN`.
- The hook program is `bb hook <agent> [event]` (`src-tauri/src/hook_client.rs`, which `bb`
  includes by path). Agents run it on every hook event. `<agent>` is `claude`, `codex`, or
  `copilot`. The optional `event` is sent as `X-Bashboard-Event`, for an agent whose payload
  lacks `hook_event_name`; the three current agents put it in the payload, so the registered
  commands omit it. Each run:

  1. Exits 0 silently outside a Bashboard pane (`BASHBOARD_HOOK_URL` unset or empty), without
     reading standard input.
  2. Prints the agent's expected reply to standard output before any network work, so a failed
     post cannot cost the agent its reply. For Claude Code, Codex, and Copilot the reply is
     nothing, because Codex's `PermissionRequest` and Copilot's `permissionRequest` read a
     hook's stdout as an allow or deny decision, and empty output leaves the normal prompt.
  3. Reads standard input with bounds: at most 1 MiB (`MAX_BODY` in `hook_client.rs`, which the
     receiver shares; Claude Code's `Stop` and `SubagentStop` carry the final message whole), a 2 second
     deadline, and an early stop as soon as the bytes read are one complete JSON object or
     array, which returns promptly when an agent writes its payload and leaves stdin open.
  4. When `BASHBOARD_HOOK_LOG` names a file, appends `--- <UTC ISO time> agent=<agent>`, the
     body, and a newline to it, for bug reports about an agent's payload shape.
  5. Skips the post when the body is empty, since the receiver answers 400 to it.
  6. Posts the body to `$BASHBOARD_HOOK_URL/hook` with `X-Bashboard-Token`
     (`BASHBOARD_HOOK_TOKEN`), `X-Bashboard-Pane` (`BASHBOARD_PANE_ID`), `X-Bashboard-Agent`, and
     `X-Bashboard-Event` when given, with 1 second connect, write, and read timeouts. Every error
     is ignored, and the exit code is always 0, because a failing hook would surface as an
     error in the agent, and Bashboard being away is not one.

  `bb hook --version` prints the embedded marker `bashboard-hook-version:5;`.

  `bb statusline <agent> [<command>]` (`src-tauri/src/statusline_client.rs`, included by `bb`
  beside `hook_client.rs`, whose bounded reader and limits it shares) is the program behind a
  wrapped Claude Code status line (3.28). Like `bb hook` it is installer-internal: it has no
  entry in the CLI reference or the user-facing help, and it works outside a pane, since a
  status line runs wherever Claude Code does. `<command>` is one argument, so the user's
  original command string reaches the shell exactly. Each run:

  1. With no `<command>` and outside a Bashboard pane, exits 0 without reading standard input.
  2. Otherwise reads standard input with `bb hook`'s bounds (1 MiB, a 2 second deadline, an
     early stop at one complete JSON value).
  3. Inside a pane, and when the body is not empty, posts it to `$BASHBOARD_HOOK_URL/usage` with
     `X-Bashboard-Token`, `X-Bashboard-Pane`, and `X-Bashboard-Agent`, under the same timeouts as
     `bb hook`. Every error is ignored, so Bashboard being away never delays or blanks the
     status line by more than those bounds.
  4. With a `<command>`, runs it through `sh -c` (`bash` is the fallback off Windows; Claude
     Code runs status lines through bash on Windows, so `sh` is on `PATH`), writes the captured
     input to its standard input, copies its standard output to this program's, and exits with
     its exit code. The command text travels in the `BASHBOARD_STATUSLINE_COMMAND` environment
     variable, which the shell evaluates, because an argument passed to an MSYS `sh` loses
     doubled backslashes to its command line parsing and the environment arrives verbatim.
     Without a `<command>` it prints nothing and exits 0.

  A wrong argument count is a usage error (exit 2) that posts nothing, and a shell that cannot
  be started exits 1 after the post.

  The install copies the `bb` that sits beside the running app into each agent's `hooks/` folder
  as `bashboard-hook.exe` (`bashboard-hook` on macOS and Linux): `~/.claude/hooks/`,
  `~/.codex/hooks/`, and `~/.copilot/hooks/`. One binary serves every agent, told which agent it
  forwards for by its argument, and a hook run starts no shell and needs no `curl`.

  `HOOK_VERSION` in `hook_client.rs` versions the program; any change to its behavior bumps it,
  and a test holds it to the marker. The installer reads an installed file's version by scanning
  its bytes for `bashboard-hook-version:` and parsing the digits up to `;`, never by running it,
  as the preview's `scriptState`: `missing`; `outdated` when its version is lower or it has no
  marker; `current` at the same version, even when its bytes differ, so a hand-placed copy
  survives; and `newer` when a newer Bashboard wrote it. `current` and `newer` count as
  installed, and the install writes the program only when it is missing or outdated, so an older
  build never downgrades a newer build's program and two installed builds never swap it back and
  forth.

  An existing program is replaced by renaming it aside to `<name>.old`, which lets Windows
  replace an executable that a hook is running, then copying the new binary to a temporary file
  in the same folder and renaming that into place (mode 0755 on Unix). The next install removes
  the `.old` file, best effort.

  Because the variables exist only inside this app's panes, the same global hook config does
  nothing for sessions in Windows Terminal or VS Code.
- Claude Code hook registration in `~/.claude/settings.json`, merged beside any hooks the user
  already has, which keep working:

  | Event | Meaning in the app |
  | --- | --- |
  | `SessionStart` | Session bound to its pane |
  | `UserPromptSubmit` | `busy` |
  | `Notification` | `waiting` when its `notification_type` needs input (a permission prompt, an elicitation dialog, or an agent needing input; or no type, from older Claude Code); other notices, including the idle prompt, change nothing; carries `message` |
  | `Stop` | `idle`, shown as `done` until the pane is looked at (4.8); `background` instead when its `background_tasks` lists running work other than shells and monitors (3.30) |
  | `SubagentStart` | Nothing |
  | `SubagentStop` | `busy` when it names a task the session's `background` wait lists, since the session wakes on its own (3.30); otherwise nothing |
  | `SessionEnd` | Session unbound from its pane |

  Each event gets one group appended, and the registered command is exactly:

  ```json
  { "hooks": [ { "type": "command", "command": "~/.claude/hooks/bashboard-hook.exe hook claude", "timeout": 5 } ] }
  ```

  The command has no `.exe` on macOS and Linux. Claude Code runs hook commands through its own
  bash on Windows, so `~` expands; Bashboard's handlers need no Git Bash on `PATH`. A handler
  is Bashboard's when its command contains `bashboard-hook.sh` or `bashboard-hook` followed by a
  non-word character or the end of the string. The install rewrites a Bashboard handler
  whose command differs from the current one in place (same group, same handler index, so
  Codex's trust keys stay stable), appends a group to an event that lacks one, and never alters
  other groups. A home other than the default is named by its full path. The install also
  deletes a leftover `hooks/bashboard-hook.sh` in that agent's home.

  The dashboard panel has an "Install Claude Code hooks" button, shown while Claude Code is
  detected (`~/.claude` exists, checked at startup) and the hooks are not fully installed. It shows the exact JSON it will merge and writes it only after
  confirmation; it never edits `settings.json` silently. The preview lists the hooks it would
  rewrite ("Updates these hooks in") and the hooks it would append ("Adds these hooks to")
  separately, showing both blocks when both apply. When nothing would be added and either
  existing Bashboard handlers run an older command or the program is outdated, the button, the
  dialog title, and its confirm button say "Update" instead of "Install". When every handler is
  already current and only the program needs writing, the dialog says the hooks in settings are
  already in place and only the hook program will be written or updated, with no JSON. Copilot's
  `hooks/bashboard.json` is written whole, so a file that exists but differs is listed as updated
  and a missing one as added. The install copies the program to
  `~/.claude/hooks/bashboard-hook.exe` when it is missing or
  outdated, then re-reads
  `settings.json` and merges the groups, through a temporary file and a rename. A missing
  `settings.json` is created. A `settings.json` that is not plain JSON (comments, trailing
  commas) is refused with an error naming the file, and nothing is written.
- **Codex hooks** go in `hooks.json` under the Codex home, merged the same way as Claude Code's
  (a Bashboard handler whose command differs is rewritten in place, an event lacking one gets a
  group appended, other groups are never altered, a file that is not plain JSON is refused). The
  registered handler has `command` `~/.codex/hooks/bashboard-hook hook codex` and
  `commandWindows` `"%USERPROFILE%\.codex\hooks\bashboard-hook.exe" hook codex`; when
  `CODEX_HOME` relocates the home, both name the full path of the program. The install also
  deletes a leftover `hooks/bashboard-hook.sh` in the Codex home:

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
  installed but untrusted hook says Codex will ask to trust it on its next start. An update that
  changes a hook's command makes Codex ask again. Bashboard never edits `config.toml`.
- **Copilot hooks** are written whole to `hooks/bashboard.json` under the Copilot home, a file
  Bashboard owns (`{ "version": 1, "hooks": { ... } }`, each event holding one command entry with
  `bash` and `powershell` commands and `timeoutSec` 5). The `bash` command is
  `~/.copilot/hooks/bashboard-hook hook copilot` and the `powershell` command is
  `& "$env:USERPROFILE\.copilot\hooks\bashboard-hook.exe" hook copilot`; a Copilot home other
  than the default is named by its full path. The events use PascalCase names, which
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
  JSON it will add, whether the hooks are already in, whether the agent is detected, and for
  Codex the trust state; `hooks_install(agent)` writes it. An absent agent means Claude Code.
- The receiver accepts `POST /hook`, `POST /cli` (3.13), `POST /ci` (3.23), `POST /size`
  (3.25), `POST /worktree` (3.27), and `POST /usage` (3.28). A `/ci`, `/size`, or `/worktree`
  request, which can wait seconds on a code host, a large diff, or a checkout, is
  handed to its own thread and answered from there, so the loop that carries hook events never
  waits on it. For `/hook` it answers with these
  codes, checked in this order:
  404 for any other path or method, 403 for a missing or wrong `X-Bashboard-Token`, 413 for a
  body over 1 MiB, 400 for a body that is not JSON or has no string `session_id`, and 204 on
  success. The `X-Bashboard-Agent` header names the sending agent; an absent header means Claude
  Code, and an unknown value is a 400. A payload without a `hook_event_name` takes it from the
  optional `X-Bashboard-Event` header. The receiver
  keeps only `session_id`, `hook_event_name`, `cwd`, `message`, `transcript_path`,
  `permission_mode`, for Codex's waiting reason the tool's name and description, and for Claude
  Code's background waits (3.30) a `Stop`'s `background_tasks` and a subagent event's `agent_id`, and emits
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

## 3.4 Pane to session binding

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
newest model, the context tokens, and the context window when the transcript reports one. A
Claude Code session's window comes from its status line input instead (3.28): each `/usage`
post's `session_id` and `context_window.context_window_size` set the window on that session's
reading, which wins over the transcript's. A post for a session the reader is not tracking is
dropped, since the status line sends the window again on its next update.

**Branch size badge.** A terminal card (4.6) whose folder is in a git repo shows a warning chip
at the end of its agent line, reading the line count ("512 lines"), while the worktree's changes
against its comparison ref exceed `git.branchSizeThreshold` (3.25; 0 turns it off). The tooltip
spells out the added and removed lines, the file count, the comparison ref, and what the test,
lockfile, and generated file exclusions left out. A card with the chip always has the agent line, even when the
session has no model or tokens to show, and a card with no agent session shows the chip alone;
the chip is absent at or under the threshold, with no comparison ref, and for a repo rooted at the
home folder. Sizes come from the store the Git pane's branch row (4.13) and the dashboard's Branch
section (4.6) share: one entry per worktree, refetched on `git://changed` for it and when a
session running in that folder reports `Stop`, so the count catches up as a turn ends, never on a
timer, and paused while the window is hidden.

- **Claude Code.** The JSONL file Claude Code appends to under `~/.claude/projects/`: the hook
  overlay's `transcript_path` when there is one; for a session bound by ancestry, which sends no
  hooks, the first `~/.claude/projects/*/<sessionId>.jsonl`, searched again at most every 5
  seconds until found. The reading is the newest line of `type` `assistant` that is not
  `isSidechain` and carries `message.usage` (a `<synthetic>` model is skipped): context is
  `input_tokens + cache_creation_input_tokens + cache_read_input_tokens`, and the model is
  `message.model`. The transcript does not name the context window; the status line does.
- **Codex** (`transcript/codex.rs`). The newest `sessions/YYYY/MM/DD/rollout-*-<id>.jsonl` under
  the Codex home. The model is the newest `turn_context` line's `model`; context tokens are the
  newest `token_count` event's `last_token_usage.total_tokens`, with its `model_context_window`
  as the window.
- **Copilot** (`transcript/copilot.rs`). `session-state/<id>/events.jsonl` under the Copilot
  home. The model is the newest of `session.model_change`'s `newModel` and the `selectedModel` of
  `session.start` or `session.resume`. With journal rotation on, Copilot archives the journal as
  `events.N.jsonl` and replaces `events.jsonl` with a head that opens with `session.journal_link`
  and replays the session state as ordinary events flagged `checkpoint`; those reuse the event
  types above, so they are read like any other line. When the live file names no model, the
  reader takes it from the newest archive that does, comparing N as a number (`events.10.jsonl`
  is newer than `events.9.jsonl`); the live file's model always wins. The folder is always
  `<copilot home>/session-state/<id>/`, since no hook payload field names another location.
  Copilot never writes token counts to disk, so there is no context reading.

The core reads only a Claude file's last 64 KiB, widening to the whole file, streamed line by
line, when the tail holds no qualifying line; the other formats are read whole in batches. A
`notify` change marks the session dirty, and a dirty session is re-read at most once per second.
A changed reading emits `agent://context` (section 7), and `agent_context()` returns every known
entry so a page reload shows them at once. Nothing is tracked until the dashboard first calls
`agent_context()`, which it does while the Panes section or the Needs you list is enabled, and
`agent_context_stop()` when both are off; entries are pruned with the hook overlay. A tracked
Codex session's rollout also yields the account's usage limits (3.28).

## 3.24 Agent table (`src/agents.json`)

The facts about each supported coding agent that are data rather than behavior live in one JSON
file, `src/agents.json`: an array with one row per agent, in the order Claude Code, Codex,
Copilot. Rust reads it through `include_str!` into a `OnceLock` (`src-tauri/src/agents.rs`), and
the front end imports it through `src/agentTable.ts`, the same way `src/defaultKeybindings.json`
is shared. A command field is a string, or `{ "windows": "...", "posix": "..." }` when the
platforms differ (no row needs that form). `{id}`, `{mode}`, and `{model}` are placeholders.

| Field | Meaning |
| --- | --- |
| `id` | `claude`, `codex`, or `copilot`; the `AgentId` enum in `agents.rs` and the union in `agentTable.ts` |
| `name` | Display name ("Claude Code", "Codex", "Copilot"), shown by `agentName` |
| `preview` | The agent is labeled a preview wherever `isPreviewAgent` is used; Codex and Copilot are |
| `home` | `dir`, the folder under the user profile; `env`, a variable that relocates it (`CODEX_HOME`, `COPILOT_HOME`); `detectMarker`, an entry only the agent writes, required inside the folder for detection (Copilot's `session-state`) |
| `process` | `executables`, lowercase names without `.exe`, one list for every OS; `nodeMarker`, text a `node` host's command line must contain to count (`@github/copilot`) |
| `statusApp` | The `app` value the agent sends in OSC 7501 reports (4.24), or null when it sends none; `agentForStatusApp` maps it back to the agent |
| `launch` | The command that starts the agent |
| `localModels` | Offers the agent in the Launch menu's "<agent> on a local model" submenu (`ollama launch <id>`), the only part of the Launch menu the table drives |
| `resume` | `command` with `{id}`; `modeArg` (`--permission-mode {mode}`), appended when the saved pane has a non-default permission mode; `modelArg` (`--model {model}`), appended when a model is saved. A null argument means the agent takes none |
| `hookShell` | The shell that runs the hook command on each platform: `windows` is `cmd` (`%USERPROFILE%`, no call operator) or `powershell` (`$env:USERPROFILE` and the `& ` call operator), and `posix` is `sh` |
| `usage` | Where the agent's usage limits come from: `statusLine` (Claude Code's status line input), `rollout` (Codex's session file), or `none` (Copilot); 3.28. Front end only like `launch` and `resume`, which `agents.rs` skips; a test holds each value to this set, and the sources themselves are code |

`resumeCommandFor` in `agentTable.ts` builds the resume command and validates nothing; callers
check the session id, mode, and model first (`resumeCommand` in `savedWorkspace.ts`). The newest
model seen per session is kept for restore for every agent whose row has a `modelArg`.
`agent_commands` in `hook_install.rs` reads `hookShell.windows` on every platform, because it
builds both platforms' command strings wherever it runs; `Agent::hook_shell` is the
current-platform value.

What stays code, because it is behavior rather than data: each agent's hook event to status table
(`hooks.rs`, 3.3), its installer and file format (`hook_install.rs`), and its transcript reader
(`transcript/`, 3.4). Tests hold the enum, the TypeScript union, and the JSON to the same ids, so
a row without its variant, or the reverse, fails the build.

## 3.28 Usage limits (`src-tauri/src/usage.rs`, `src-tauri/src/statusline_client.rs`, `src/usageModel.ts`)

A subscription limits an agent's use to windows (a 5-hour window, a weekly one). Bashboard learns
how much of each window is spent from the agent itself and feeds the Needs you list's usage rows
(4.28). Cost per session is not collected.

**Window.** `UsageWindow` is `agent`, `label`, `usedPercent`, and `resetsAt`, serialized
camelCase. `usedPercent` is a number, not necessarily whole; `resetsAt` is seconds since the
epoch, or null when the source gives none. Claude Code's labels are "5-hour" and "weekly". Codex's
come from the window's length in minutes: 10080 is "weekly", a whole number of days is
"<n>-day", a whole number of hours is "<n>-hour" (300 is "5-hour"), and anything else is
"<n>-minute"; a window that names no length is labeled "primary" or "secondary".

**Sources.** Each agent's `usage` field (3.24) names its source: `statusLine` for Claude Code,
`rollout` for Codex, `none` for Copilot, which reports no limits.

**Claude Code: the status line.** Claude Code runs the configured `statusLine` command on every
update and feeds it a JSON document on standard input; `rate_limits.five_hour` and
`rate_limits.seven_day` each hold `used_percentage` and `resets_at`. They are absent until a
response carried rate-limit headers, which only subscription logins get, and an absent window
yields nothing. The same input's `session_id` and `context_window.context_window_size` give the
session's context window to the transcript reader (3.4). Claude Code accepts one status line command and shows its output, so Bashboard
cannot read the input beside the user's command. The install therefore wraps the command rather
than taking its place. With an existing `{ "type": "command", "command": X }` it writes

```json
{ "type": "command", "command": "~/.claude/hooks/bashboard-hook.exe statusline claude 'X'" }
```

where `X` is the original command quoted as one POSIX argument: wrapped in single quotes, each
`'` inside it written `'\''`. The command has no `.exe` on macOS and Linux, and `~` expands
because Claude Code runs status lines through bash. `bb statusline` (3.3) posts the input to
`/usage`, then runs `X` with the same input and passes its output and exit code through, so the
user's status line looks the same. With no status line configured the install writes the bare
`... statusline claude`, which prints nothing, so the status line stays empty. The wrapper
keeps `X` recoverable exactly: an existing wrapper is rewritten with the current program path and
the same `X`, so installing again changes nothing when the path is current; any other `statusLine`
field (`padding`, for one) is untouched; a `statusLine` whose type is not `command` is left alone;
and a command that names the hook program but does not parse as a wrapper is left alone rather
than wrapped a second time. The preview lists the status line among the additions on a first
install and among the updates otherwise, so it never turns an update into an install. There is no
uninstall; `docs/setup.md` says how to restore `X` by hand.

`POST /usage` takes the body on `/hook`'s terms: the token alone, with no pane check, because
Claude Code may run outside a Bashboard pane. The receiver answers 404 for a method other than
POST, 403 for a missing or wrong `X-Bashboard-Token`, 413 for a body over 1 MiB, 400 for an
unknown `X-Bashboard-Agent` (absent means Claude Code) or a body that is not JSON, and 204
otherwise, including for an input with no rate limits. It reads the body as a Claude Code status
line input, the only wrapper there is. It answers on the loop that carries hook events.

**Codex: the rollout.** Codex writes a `token_count` event to its rollout (3.4) after each turn,
and its `payload.rate_limits` is a snapshot with `primary` and `secondary` windows, each
`used_percent`, `window_minutes`, and `resets_at`. Most events carry null. The transcript worker
reads the newest non-null snapshot from the tail of each tracked Codex session's rollout, so
Codex limits arrive only while the worker runs, which is while the Panes section or the Needs you
list is shown (3.4). An API-key login reports null in every event and so yields nothing.
`rate_limit_reached_type`, when set, does not name the exhausted window, so the fullest window is
reported at 100. The worker reports a session's windows when they differ from the last it
reported for that session.

**Store.** The core keeps one window per agent and label, ordered by agent (the table's order)
and then label. A report replaces the entry with the same agent and label, and the newest report
wins, because neither input names an account: two Claude Code logins, or two Codex ones, show
whichever reported last. A window a report leaves out is kept, since both inputs omit a window
until they have a number for it. The store is not saved, so it is empty after a restart until the
next report. `usage_snapshot()` returns every window, and `usage://changed` carries the whole
snapshot whenever a report changed anything.

**Freshness and expiry.** The front end (`listenUsage` in `appEvents.ts`) loads the snapshot at
startup and takes each event as the whole snapshot, so an event that lands before the startup
snapshot resolves supersedes it. `toUsageWindows` turns `resetsAt` into epoch milliseconds and the
agent id into its display name (3.24), and `needsYouStore.setUsage` receives the result. The core
never drops a window; the Needs you list ignores one whose reset time has passed, rechecked once
a minute, so a window disappears at its reset without a new report. A window with no reset time
stays until a report replaces it. Which windows become rows is the `needsYou.usagePercent`
threshold (4.28, section 8).

## 3.30 Background waits (`src-tauri/src/hooks.rs`, `src-tauri/src/background_agents.rs`)

Claude Code ends a turn, and sends `Stop`, while background agents it launched are still running;
when one finishes, the session wakes and works on its result with no prompt from the user. Read
as `idle`, such a turn would show as `done` and enter Needs you (4.28) while the session is still
at work.

**The wait.** A Claude Code `Stop` carries `background_tasks`, each with `id`, `type`, `status`,
and `description`. The receiver keeps the entries whose status is not `completed`, `failed`,
`killed`, `stopped`, or `cancelled`, leaving out `shell` and `monitor` tasks: a dev server or a log
watch can run for as long as the session does, and counting it would keep the session from ever
reading as done. A `Stop` with any left sets the overlay to `background` and keeps that list; any
other status clears it. A `SubagentStop` whose `agent_id` is in the list sets `busy`, because the
session is waking; a nested subagent's stop wakes only its parent agent and changes nothing. The
next `Stop` decides again between `background` and `idle`.

The roster payload has no `background` status: the merge (3.2) reports it as `busy`, held like
`waiting` against anything but a newer roster `busy`, since Claude Code's session file says `idle`
while the session waits. The roster's own `busy` on waking wins as it does for `waiting`.

**Stuck agents.** Claude Code writes each subagent's transcript to
`<session>/subagents/agent-<id>.jsonl` beside the session's own transcript (the overlay's
`transcript_path` without `.jsonl`), appending on every message and tool result, so its modified
time is the agent's heartbeat. `agent-<id>.meta.json` beside it names the agent's parent
(`parentAgentId`) and gains `"finished": true` when the agent ends. An agent waiting on its own
background agents writes nothing until they report, so an agent's activity is the newest write
among its own transcript and those of its unfinished descendants.

The roster's 10 second sweep judges each `subagent` task of every session in `background`: one
whose activity is at least `needsYou.stuckAgentMinutes` (section 8, default 15; 0 turns the check
off) old is stuck, and the stalest stuck task speaks for the session. A stuck session's merged
status is `waiting`, changed at its last activity plus the threshold, with the reason
`Background agent may be stuck: <description>`, so it is Blocked in Needs you (4.28) and raises
attention (4.7) like any other wait. A verdict applies only while the session's wait still lists
its task, so one from an earlier wait never colors a later one, and it clears on the next sweep
after the agent writes again. Tasks of other types, and a subagent whose transcript cannot be read,
are never judged.

The check sees only transcript writes, so a subagent blocked on one long tool call, or on a
background shell of its own, past the threshold reads as stuck while it may not be; the threshold
is the trade between that and how long a hung agent goes unnoticed.

## 3.33 Session history (`src-tauri/src/history/`)

The Sessions dialog (4.32) lists past sessions for every agent in `src/agents.json` (3.24): Claude
Code, Codex, and Copilot. The history index builds that list from each agent's transcripts, caches
it on disk, and keeps it current as transcripts change.

**Commands and events.** `session_history_list()` returns the cached list, sorted by `updatedAt`
descending. The first call builds the index on a worker thread, so the command never blocks the
main thread. `history://changed` carries the full list whenever the index changes.
`session_history_repo_root(cwd)` returns the main repo root holding a folder, so the Sessions
dialog (4.32) can scope to a terminal's repo even when it has no indexed sessions.

**Entry.** `PastSession` is serialized camelCase, with these fields:

- `agent` and `sessionId`.
- `cwd`, read from the transcript's contents and never decoded from a folder name. `cwdExists`
  says whether that folder is still on disk.
- `repoRoot`, the main repo root. A worktree resolves to its main repo, and the field is null
  outside git.
- `branch`.
- `title`, which is never empty.
- `firstPrompt` and `lastPrompt`, trimmed to 200 characters.
- `startedAt` and `updatedAt`, in milliseconds since the epoch. `updatedAt` is the newest record's
  time, else the file's modified time.
- `permissionMode`, the last permission-mode record in a Claude Code transcript.
- `model`, the newest model, which Copilot's resume command needs.

Only these fields are read or forwarded.

**Sources.** The agents' transcript formats are internal and undocumented, so every field is
optional on parse and an unparseable line is skipped. A transcript with no user prompt is not
listed.

- Claude Code: `~/.claude/projects/<slug>/<id>.jsonl`. The session id is the file stem. `cwd`,
  `gitBranch`, and `timestamp` come from user and assistant records. The title is the last
  `custom-title` record (written by `/rename`), else the last `ai-title`, else the last `summary`,
  else the first user prompt. `lastPrompt` is the last `last-prompt` record's value, else the last
  user text. The first prompt skips `isMeta` records, command wrappers, and tool results.
  Subagent and sidechain transcripts are skipped: files under a `subagents` folder, files whose
  names start with `agent-`, and files whose user records are all `isSidechain`.
- Codex: `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`. Files ending in `.zst` are skipped. The
  first line is a `session_meta` record with the id, timestamp, cwd, and git branch. The title is
  the `thread_name` for that id in `~/.codex/session_index.jsonl` (the last matching line wins),
  else the first user message. `model` comes from `turn_context` records.
- Copilot: `~/.copilot/session-state/<id>/`. `workspace.yaml` is read leniently, line by line, for
  `cwd`, `git_root`, `branch`, `summary`, and the timestamps. `events.jsonl` supplies the first
  user message and the model. The title is the summary, else the first prompt.

**Repo root.** The main repo root is found by walking up from the cwd for a `.git` entry. A `.git`
folder is the main repo. A `.git` file marks a worktree: its `gitdir:` line names the worktree's
git folder, whose `commondir` file names the main repo's `.git`, and the main repo is that
folder's parent. Nothing shells out to git. The lookup, along with whether the cwd exists, is
memoized per cwd during a build.

**Reads.** Only the first 16 KB and the last 64 KB of each transcript are read. Readers tolerate a
partial first or last line, since a window can start or end mid-record.

**Cache.** `history-cache.json` in the app's config folder maps each path to its `(size, mtime,
PastSession)`, written atomically. A build re-reads only files that were added or whose size or
modified time changed, and drops entries whose files are gone. A cache written with an older
`CACHE_VERSION` is discarded, so a reader change re-reads every file.

**Watcher.** Each agent's transcript root is watched recursively with `notify`, debounced by one
second and cut off after 5 seconds (`DEBOUNCE_MAX`), since a streaming transcript never goes quiet.
A root missing at startup (an agent installed later) is retried every 30 seconds. Each change triggers an incremental rebuild on a worker thread, and `history://changed`
fires only when the rebuilt list differs from the last one sent.

## 4.7 Attention

When a terminal enters `waiting`, or rings the bell (`term.onBell`, which also catches the
existing `printf '\a'` hook):

- An expanded terminal's pane border pulses until it is focused; a collapsed terminal's card
  pulses until it is expanded. A terminal in a background tab also pulses that tab in the tab
  strip and its group header in the dashboard, until none of the tab's terminals is marked.
- A terminal being **looked at** (the focused, expanded pane of the active tab in a focused
  window) is not marked. Attention clears when the pane becomes the one looked at,
  including when switching to its tab or when the window regains focus with it focused.
- If the window is unfocused, the taskbar button flashes. For `waiting` (not the bell), and while
  `terminal.notifyWhenWaiting` is on, a system notification (`toast.rs` on Windows, `toast_mac.rs`
  on macOS, `toast_linux.rs` on Linux) also shows the pane's title and its waiting reason; clicking
  it brings the window forward and focuses that pane. A debug build on Windows sends it under
  PowerShell's AppUserModelID, since Windows drops toasts from an id no Start menu shortcut
  registers. On macOS the first notification asks for permission, and a build without an app
  bundle (`pnpm tauri dev`) sends none. On Linux it goes to the desktop's freedesktop notification daemon over
  the session bus; `toast_linux.rs` covers the click routing and limits, and with no daemon the
  notification is dropped and one line is logged.

`done` and `failed` (4.8) are quieter: they change the status dot on the title strip, card,
tab, and group header, and nothing else. They raise no attention, so no pulse, taskbar flash, or
panel peek.

**Next thing that needs you.** `nextAttention` (Ctrl+Shift+N) walks the Needs you list in its
order (4.28, Groups and order). Terminals that rang the bell without a status are not included; their pulse stays
the cue. With `needsYou.walkAll` (section 8, default on) the walk visits every row; off, it visits only
the terminals. Rows the user has hidden (4.28) are skipped. The jump goes to the row after the current
position, wrapping, or to the first row when there is none. The position is the focused terminal's row,
or, after a walk landed on a Ship or sign-in row, that row for as long as focus has not moved by other
means, since opening a Ship pane would otherwise lose the place. `waiting` does not clear on focus, so
repeated presses walk the whole list; `done` and `failed` clear on focus, so they drop out as they are
visited, and a walk whose row left the list resumes at the row now in its place.

Each row it lands on acts as clicking that row does (4.28). When the walk is empty, the chord cycles the terminals with a bound agent session (3.4)
instead, in reading order within each tab (collapsed cards last) and tab order across tabs, with the
same after-the-focused-one rule. With no agent terminals either, it shows a toast, "Nothing needs
you, and no agent sessions are open".

## 4.23 Agent glow and border lights (`src/paneLights.ts`)

Two ambient effects, each off by default and turned on by its own setting (`agentGlow`,
`borderLights`). The border lights also take `borderLightsSpeed` and `borderLightsDensity`;
tail length, head size, intensity, breath cycle, and the rest are constants in `PANE_LIGHTS`
(`src/paneLightsModel.ts`), so they can be adjusted in one place. Under `prefers-reduced-motion` both stay off whatever the settings say.

**Agent glow.** A terminal whose bound session (3.4) is `busy` gets the `agent-working` class,
whichever agent it runs (Claude Code, Codex, or Copilot). So does a terminal whose program layer
(4.24) decides its status and reports `working` with an `app` that names a known agent. A busy
shell command without an agent does not count. While `agentGlow` is on, that pane shows a soft inner glow in the accent color
that breathes from dim to bright and back over 7 seconds. It is an inset shadow on a
`::after` overlay, so it fits inside the 4px gutters, and only its opacity animates, so it
composites without repainting the terminal under it.

**Border lights.** While `borderLights` is on, comets of accent light run clockwise around
each pane of the active tab, along the middle of the gutter, at `borderLightsSpeed` px per
second (default 120). Each comet is a small 2 px head with a 60 px trail on both sides, ahead of
the head as well as behind it, fading out toward each end. A pane runs `borderLightsDensity`
comets per 1000 px of loop (default 1), rounded, and at least one, so larger panes carry more. A pane's first comet starts at a random point on its loop, so neighbors don't run in step;
the rest spread out from it. When a pane or window resize changes the count, a new comet fades in
at the middle of the widest gap, and a retired one is the one with its neighbors closest, which
fades out. The count only changes once the loop is 0.15 comets past the halfway point, so a
divider dragged near the boundary doesn't make a comet flicker. When any pane on screen has
attention (4.7), only those panes keep their comets; the rest fade out, and they fade back in
once attention clears. Attention keeps its own 1-second border pulse; the comets never take on
that rhythm, so the pulse stays the strongest signal on screen.

The comets draw on one Canvas2D layer, `#pane-lights`, fixed over the window between the
backdrop and `#panes`. It sits outside the scrim's filter (4.1), so the scrim does not dim it,
and it uses no WebGL context, so it costs nothing from the terminal budget (4.4). It reads the
pane rects each frame, so splits, drags, zoom, and the dashboard's width need no extra wiring. It
draws at up to 20 fps and stops while the window is hidden or minimized.

## 4.24 Program status (OSC 7501)

A program can write its own status into the terminal stream through OSC 7501, the Program Status
Protocol (https://www.superlogical.com/rex/docs/build/program-status). Claude Code (2.1.295 and
later) and Codex do, once the terminal answers their probe. It gives a pane working, waiting, and
done status for an agent that has no hooks installed. `src/programStatus.ts` parses it, a terminal
pane (`pane.ts`) holds the state, and `src/terminalStatus.ts` layers it into the pane's status
(4.8).

**Grammar read.** The body after `ESC ] 7501 ;` is `?` (a probe) or `key=value` pairs separated by
`:`, and the last value for a key wins. A body over 4087 bytes is ignored. A malformed pair is
skipped and the rest applies.

| Key | Use |
| --- | --- |
| `state` | Required: `idle`, `working`, `blocked`, `done`, or `error`. `clear` is an action, not a state. A report without a valid state is ignored |
| `kind` | Read only with `blocked`: `permission`, `question`, or `auth`; any other value is dropped |
| `msg` | Base64 UTF-8 text, the waiting reason. A report whose `msg` fails to decode or holds a control character is discarded whole |
| `title` | Validated the same way and otherwise unused |
| `app` | The reporting program; matched against each agent's `statusApp` (3.24) |
| `id` | Names a child record. A report carrying one is ignored; only the root record counts |

**Probe.** A program reports only after the terminal answers its probe, `ESC ] 7501 ; ? ST`. The
pane writes `ESC ] 7501 ; ?:states=idle,working,done,blocked,error:kinds=permission,question,auth ESC \`
to the pty as if typed. A pane that is `muted`, which it is while it replays saved scrollback on
reattach (3.1), never answers: a replayed probe has no one to answer. Answering also makes
Claude Code stop painting its spinner glyph in the window title, so the title is not watched.

**State kept.** The pane keeps the last root report with two times: when the state last changed
(a repeated report of the same state leaves it alone) and when the latest report arrived. It
forgets the report when `state=clear` arrives or the shell prompt returns (OSC 133 `A`), so a
later program in the same pane starts clean. Reports replayed on reattach restore the state but
leave no done mark, since they describe old work.

**Mapping.** `working` is `working`. `blocked` is `waiting`, with the decoded `msg`, trimmed and
cut at 200 characters, as the reason, else "Needs permission", "Has a question", or "Needs
sign-in" by `kind`, else the generic waiting text. `idle` and `done` are `idle`, and `error` is
`failed`. A report moving from `working` or `blocked` to `done`, `idle`, or `error` while the pane
is not being looked at (4.7) leaves a program mark, shown as `done` (`failed` for `error`) until
the pane is looked at, the way a hook `Stop` does (4.8); work that begins after the mark replaces
it. Dashboard cards resolve through the same layer and reason as the title strip (4.6).

**Precedence.** A bound hook session (3.4) whose status is not `unknown` wins. The exception is a
session whose status last changed more than 2 minutes before the latest report, when that report
is `working` or `blocked`: the hooks went quiet while the program moved on, so the program's
status wins. With no bound session, or an `unknown` one, the program status wins over the shell's
(OSC 133 and the sweep). A report of `idle`, `done`, or `error` never overrides a quiet session.

**Scope.** Program status carries status only. A dashboard card's model, context, and resume
details still come from the hook session and its transcript (3.3, 3.4), so they need hooks.

**Current limitation on Windows.** ConPTY as `portable-pty` creates it drops OSC sequences written
to its input, so the probe reply never reaches the program and Windows status comes from hooks
(see `docs/discoveries.md`). Hookless status works on macOS and Linux.

## 4.32 Sessions dialog (`src/sessionsDialog.ts`, `src/sessionHistoryModel.ts`)

The Sessions dialog lists live and past agent sessions and resumes one. It is about the size of the
app dialog (4.18). It opens from the command palette action "Resume session" (`openSessions`,
with no default chord), or from a history button (a clock with an arrow) in a terminal's title
strip, beside the pin button. The history button shows on focus or hover, as the pin button does,
and is absent on container shells.

**Scope.** A checkbox at the top reads "Only <repo name>", or "Only this folder" outside a git
repo. Repo matching compares main repo roots (3.33), so a worktree's sessions count as its repo's,
and a session started in a subfolder counts too. The box is checked when the dialog opens with a
folder context: from a terminal's history button, or from the palette while a terminal pane is
focused and its cwd is known. Without a folder context the box is unchecked and disabled. The
choice is not persisted; each open picks its default.

**List.** Sessions are grouped Today, Yesterday, Previous 7 days, Previous 30 days, and Older, by
`updatedAt` on local calendar days, newest first, with a sticky header per group. Each row shows the
title, an agent badge (CC, CX, or CP) when more than one agent has sessions, the folder
(`displayPath`), the branch when known, the relative time, a live dot when the session is running now, and a muted "folder missing" note when
its cwd is gone. Live sessions from the roster are merged in, and a live session missing from
history is added from its roster fields.

**Search and filters.** The search field is focused on open. It filters by title, first prompt,
last prompt, and folder, case-insensitively, and every word must match. Agent filter chips appear
only when more than one agent has sessions, and a model select (`modelOptions`, skipping Claude
Code's placeholder ids such as `<synthetic>`) only when sessions span more than one model.

**Keys.** Up and Down move the selection, Enter resumes, and Escape or a click on the backdrop
closes the dialog. Keys never reach the terminal, and focus returns to where it came from. A
loading note shows until the first list arrives, and the empty state names the active scope. While
the dialog is open it updates from `history://changed`.

**Resume.** A live session focuses its pane when it is bound to one, and the dialog closes. A past
session is resumed in a terminal. If the dialog came from a terminal that is idle at its shell (no
agent bound, not busy) and already sits in the session's cwd, the resume command runs there;
otherwise a new terminal opens in the session's cwd and runs it. The command comes from
`resumeCommandFor` in `src/agentTable.ts`, given the session's last permission mode (Claude Code)
and model (Copilot). Claude Code's `--resume` looks a session up by its cwd, so it must run in the
original folder. If that folder is gone (a deleted worktree, for example), the resume
opens in the main repo root instead, with a toast.

**Row menu.** Right-clicking a row (`src/contextMenu.ts`) offers Resume, Copy session id, Copy
resume command, and Open folder in the OS file manager (File Explorer, Finder, or File Manager;
`fileManagerName` in `src/platform.ts`).

**Modules.** The pure logic (scope, query matching, grouping, the live merge, and the resume plan)
lives in `src/sessionHistoryModel.ts`, with no DOM. The rows render in `src/sessionHistoryRow.ts`.
