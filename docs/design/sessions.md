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
  3. Reads standard input with bounds: at most 64 KiB (`MAX_BODY` in `hooks.rs`), a 2 second
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

  `bb hook --version` prints the embedded marker `bashboard-hook-version:3;`.

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
  `~/.claude/hooks/bashboard-hook.exe` (home is `USERPROFILE`, else `HOME`) when it is missing or
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
- The receiver accepts `POST /hook`, `POST /cli` (3.13), and `POST /ci` (3.23). A `/ci` request,
  which can wait seconds on a code host, is handed to its own thread and answered from there, so
  the loop that carries hook events never waits on it. For `/hook` it answers with these
  codes, checked in this order:
  404 for any other path or method, 403 for a missing or wrong `X-Bashboard-Token`, 413 for a
  body over 64 KiB, 400 for a body that is not JSON or has no string `session_id`, and 204 on
  success. The `X-Bashboard-Agent` header names the sending agent; an absent header means Claude
  Code, and an unknown value is a 400. A payload without a `hook_event_name` takes it from the
  optional `X-Bashboard-Event` header. The receiver
  keeps only `session_id`, `hook_event_name`, `cwd`, `message`, `transcript_path`,
  `permission_mode`, and for Codex's waiting reason the tool's name and description, and emits
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
  home. The model is the newest of `session.model_change`'s `newModel` and the `selectedModel` of
  `session.start` or `session.resume`. Copilot never writes token counts to disk, so there is no context reading.

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
target tab unzooms first. When the list is empty, the chord cycles the terminals with a bound
agent session (3.4) instead, in reading order within each tab (collapsed cards last) and tab
order across tabs, with the same after-the-focused-one rule. With no agent terminals either, it
shows a toast, "Nothing needs you, and no agent sessions are open".

## 4.23 Agent glow and border lights (`src/paneLights.ts`)

Two ambient effects, each off by default and turned on by its own setting (`agentGlow`,
`borderLights`). The border lights also take `borderLightsSpeed` and `borderLightsDensity`;
tail length, head size, intensity, breath cycle, and the rest are constants in `PANE_LIGHTS`
(`src/paneLightsModel.ts`), so they can be adjusted in one place. Under `prefers-reduced-motion` both stay off whatever the settings say.

**Agent glow.** A terminal whose bound session (3.4) is `busy` gets the `agent-working` class,
whichever agent it runs (Claude Code, Codex, or Copilot). A busy shell command without an agent
does not count. While `agentGlow` is on, that pane shows a soft inner glow in the accent color
that breathes from dim to bright and back over 7 seconds. It is an inset shadow on a
`::after` overlay, so it fits inside the 4px gutters, and only its opacity animates, so it
composites without repainting the terminal under it.

**Border lights.** While `borderLights` is on, comets of accent light run clockwise around
each pane of the active tab, along the middle of the gutter, at `borderLightsSpeed` px per
second (default 60). Each comet is a small 4 px head with a 60 px trail on both sides, ahead of
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
draws at up to 30 fps and stops while the window is hidden or minimized.
