# Agent sessions and hooks

Section numbers are ids shared across every file in `docs/design/`, so a citation such as
"section 4.5" names one section wherever it lives; [the index](README.md#index) maps each to its file.

## 3.2 SessionRoster (`src-tauri/src/roster.rs`)

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

## 3.3 HookReceiver (`src-tauri/src/hooks.rs`)

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
