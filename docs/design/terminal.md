# Terminal panes

Section numbers are ids shared across every file in `docs/design/`, so a citation such as
"section 4.5" names one section wherever it lives; [the index](README.md#index) maps each to its file.

## 3.1 PtyManager (`src-tauri/src/pty.rs`)

One pty per terminal, keyed by an id the core assigns and never reuses (a page reload restarts
the front end while older ptys may still be exiting). The pty id is what `BASHBOARD_PANE_ID`
holds and what sessions bind to (3.4); the front end gives each pane its own id (4.11) and maps
a terminal's pane id to its pty id.

| Command | Purpose |
| --- | --- |
| `pty_spawn(cols, rows, cwd?, profile?, command?, onData, onExit) -> { id, startedAt, profile }` | Start a shell; `profile` is the id actually started. `command`, an argument list, runs in place of the profile's interactive shell (container shells, 4.16) |
| `pty_attach(id, startedAt, onData, onExit)` | Take over a running pty's output and exit from the page that spawned it (Reattach, below) |
| `shell_profiles() -> ShellProfile[]` | The shells that can be started (section 7) |
| `pty_write(id, data)` | Keystrokes and pastes |
| `pty_resize(id, cols, rows)` | After a fit |
| `pty_kill(id)` | Close a terminal |
| `pty_list() -> [{ id, pid, startedAt }]` | Reconcile after a reload or a rebuilt window |

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
- **PowerShell arguments.** PowerShell reports nothing by default, so the core appends
  `-NoExit -EncodedCommand <wrapper>` to the `pwsh` and `powershell` profiles' arguments
  (`src-tauri/src/powershell_prompt.rs`). The wrapper runs after the user's profile, keeps that
  profile's `prompt` in `$Global:__BashboardOriginalPrompt`, and replaces `prompt` with one that
  emits OSC 9;9 with the current location ahead of the original. A guard skips the capture when
  that variable already exists, so a profile carrying the same wrapper is not wrapped twice. It
  uses `$([char]27)` rather than `` `e ``, which Windows PowerShell 5.1 lacks, and restores
  `$LASTEXITCODE` after calling the original prompt. It emits no OSC 133: the front end ignores
  the sweep once a pane emits any marker (4.8), and PowerShell has no reliable hook for the
  command-started marker, so its status also comes from the sweep. A pane started with an
  explicit `command` gets neither this nor cmd's `PROMPT`.
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
- **Reattach.** A pty outlives the page that spawned it: a page reload, or a window rebuilt after
  WebView2's browser process died (3.22), leaves its shell running. Each pty keeps its newest
  1 MB of output whether or not a page is listening, so a shell never blocks on a full pipe
  while no page reads it. `pty_attach` sends that tail, starting after its first line break when
  older output was dropped, as the first `onData` message (always, even when empty), then live
  output, and moves `onExit` to the new page; the sink runs under the same lock as the swap, so
  no chunk is lost or repeated between the two. The pty must match on `startedAt` as well as
  `id`, since ids restart with the core and a saved id from an earlier run would otherwise name
  a different shell. A pty that exits while no page listens is removed as usual.
- **Orphans.** On front-end load, `pty_list` returns the ptys that outlived the last page. The
  restored workspace reattaches the ones its saved terminals name (4.9), and the rest are
  killed.

## 3.5 Platform glue

- **Browser accelerators.** WebView2's `AreBrowserAcceleratorKeysEnabled` is set to false at
  window creation (`lib.rs`), so Ctrl+F, Ctrl+R, Ctrl+P, F5, and zoom keys reach the page.
  Verified in the keyboard test.
- **Clipboard.** `clipboard_read_text` reads through `arboard` because WebView2 puts
  `navigator.clipboard.readText` behind a permission prompt. Writes use
  `navigator.clipboard.writeText`, which needs no prompt.
- **Links.** `open_url` (`src-tauri/src/links.rs`) opens a URL in the system browser through
  `tauri-plugin-opener`, called from Rust. It accepts only `http` and `https` and returns an
  error for anything else. An `http` loopback URL on a port that speaks TLS opens as `https`
  (`prefer_tls`, 4.21). The page gets no opener permission, so it cannot launch other
  programs or schemes directly.
- **Attention.** `window.request_user_attention` flashes the taskbar button when a session in
  an unfocused window starts waiting.

## 3.17 Fonts (`src-tauri/src/fonts.rs`)

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

## 3.26 Azure context (`src-tauri/src/cloud_context.rs`)

The machine-wide half of the cloud chip (4.25): the default Azure subscription, read from disk.
The core never runs `az` and never polls.

- **Source.** `azureProfile.json` in `AZURE_CONFIG_DIR` (when set and non-empty) or `~/.azure`.
  The file is UTF-8 with a BOM, which is stripped before parsing. The context is the
  subscription with `isDefault` true: its `name`, its `id`, and `user.name` when present. A file
  that is missing, unparseable, or has no default subscription yields no context; a missing
  login is not an error.
- **Watching.** The directory is watched (not the file, since `az login` rewrites it in several
  steps), and a burst of events is coalesced by a 250 ms debounce into one re-read. A change that
  alters the context emits `cloud://azure` with `{ name, id, user }`, or null when it is gone.
  If the directory does not exist at launch, nothing is watched, so a first `az login` after
  that needs an app restart.
- **Command.** `azure_context() -> { name, id, user } | null` returns the current context; the
  front end calls it once at startup and then follows `cloud://azure`.

## 4.4 Terminal pane (`pane.ts`)

One `TerminalPane` per terminal: an xterm `Terminal` with fit, WebGL, Unicode 11, and search
addons, bound to one pty. Font defaults to the bundled `JetBrainsMono Nerd Font Mono` (3.16),
with `Cascadia Mono` as the fallback, 14 px.

**WebGL context budget.** Chromium allows roughly 16 live WebGL contexts per page, and the backdrop uses
one while the Swirling Lights or Galaxy style is mounted (none under Matrix or None). Only expanded terminals in the active tab count: each uses the WebGL renderer until 8 are
on screen, and past that, newly shown ones use the DOM renderer. Collapsing a terminal, or
switching away from its tab, disposes the WebGL addon, freeing its context; expanding it or
switching back attaches one again if the budget allows. If the browser drops a WebGL context
(`onContextLoss`), that pane falls back to the DOM renderer instead of going blank.

**Title strip:** the kind menu (4.11), the status dot (4.8), the bound session's name or the
shell's working directory, any buttons of the pane's own kind (`PaneView.stripActions`; the
Files pane's, 4.12; a terminal's cloud chips, 4.25, then its pin button, a pin icon that opens
the new pin popup for a command pin in its working directory, 4.6), then a collapse button, a zoom button (with two or more expanded
panes in the tab, 4.2), and a close button that acts as Ctrl+W (`requestClosePane`); the rest of
the strip is the drag handle for docking. The status dot's tooltip shows the waiting reason
(3.3) while the terminal is `waiting`; the strip's text is unchanged. Every pane kind
has the same strip, with its own title and no status dot. The strip always sits in the layout
above the pane's body, for every pane kind and even when the pane is alone in its tab; it is
never a hover overlay, which would sit over the buttons and first row at the top of the pane. The title is cut short with an ellipsis
before the pane's own buttons give up any room.

**Title strip menu.** A right-click on a title strip of any pane kind opens Change kind (a
submenu of the kind menu's entries, 4.11), Collapse, Zoom or Restore (only while the zoom button
shows, 4.2), on a terminal New pin, and, after a separator, Close pane. Each item does what its
button does.

**Right-click.** A right-click in a terminal does whatever xterm.js and the running program do
with it, in every profile, and no menu opens. `main.ts` registers one `contextmenu` listener on
`window` in the capture phase, before anything else mounts, that cancels the default and never
stops propagation, so xterm.js still sees the event (it moves its hidden textarea under the
pointer, and passes the button to a program that turned on mouse reporting). The cancelled
default is WebView2's built-in menu, whose Refresh reloads the page. The app adds no terminal menu and no right-click handling of its own.

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

## 4.8 Terminal status

Every terminal is `idle`, `working`, `waiting`, `done`, or `failed`, resolved in order:

1. **Bound agent session.** Its session status (section 7): `busy` shows as `working`, `idle`
   as `idle` (or `done`, below), `waiting` as `waiting`, and `unknown` falls through. A session
   whose status last changed more than 2 minutes before a newer `working` or `blocked` program
   report also falls through.
2. **Program status.** What the program running in the pane reported through OSC 7501: `working`,
   `blocked` as `waiting` with the program's message as the reason, `idle` and `done` as `idle`,
   `error` as `failed` (4.24). It is how an agent without hooks reports, and the pane forgets it
   when the shell prompt returns.
3. **Shell activity.** `working` while a foreground command runs, otherwise `idle`. OSC 133
   markers give exact transitions: `C` (command started) to `working`, `D` (command finished)
   to `idle`. A shell without the `~/.bashrc` lines (4.2) falls back to the core's activity
   sweep (3.1), which reports `working` while the shell has a running job (background jobs
   included), up to 2 seconds late.

A plain shell has no `waiting` state; a program that needs the user either reports `blocked`
through OSC 7501 (2 above) or rings the bell, which raises attention (4.7) without changing
status.

**Done.** When a bound session's `Stop` hook arrives (any agent's) while its terminal is not being looked
at (4.7), the terminal shows `done` instead of `idle` until it is. Any later status (a new
prompt, `waiting`, the session ending) replaces it. A roster change to `idle` does not set it.
A program report (4.24) moving from `working` or `blocked` to `done`, `idle`, or `error` while the
terminal is not being looked at leaves the same mark, `failed` for `error`; reports replayed on
reattach leave none.

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

`done` and `failed` are display state only; the session stays `idle`. They are not saved, so
restored terminals start without them.

## 4.25 Cloud context chip (`src/cloudContextModel.ts`)

A terminal's title strip shows which cloud identity its commands run as, in a chip immediately
left of the pin button, and the pane's session card in the dashboard shows the same chips. The
chip is for noticing that a shell holds production credentials before running something in it.

**AWS, per pane.** The `~/.bashrc` lines (docs/setup.md) and the PowerShell prompt wrapper
Bashboard injects report the shell's `AWS_PROFILE` and region (`AWS_REGION`, else
`AWS_DEFAULT_REGION`) as `ESC ] 7502 ; aws ; <profile> ; <region> ST`. They use shell builtins
only, because in Git Bash every subprocess costs a fork and a per-prompt process would slow every
prompt, and they emit only when the pair differs from the last one sent, so the first prompt of
each shell emits once. Command Prompt has no hook, so its panes get no AWS chip. The pane's OSC
handler passes the body to `parseOsc7502` (`osc.ts`), which returns `{ profile, region }` (either
may be empty) or null for another provider, so a later provider does not confuse an older build.
The context is kept per pane and is not saved.

**Azure, machine-wide.** The context from 3.26 applies to every pane alike, since an `az login`
is per user, not per shell.

**Chips.** `cloudChips(aws, azure, pattern, enabled)` returns the chips in order, AWS first.

| Chip | Shown when | Text |
| --- | --- | --- |
| AWS | the profile or the region is set | `aws <profile>`, plus ` · <region>` when a region is set; `default` stands in for an empty profile |
| Azure | the subscription name matches the production pattern | `az <subscription name>` |

Azure is limited to production matches so that a developer who is logged in to Azure does not see
a chip in every pane. A chip is gray, and red when it matches the production pattern: for AWS the
profile (the region is not matched), for Azure the subscription name, so every Azure chip is red.
Hovering a chip lists the provider, the profile or subscription name, the region or subscription
id, and the user when known (Azure only). With `cloud.badge` false, or with nothing set, there
are no chips.

**Pattern.** `cloud.productionPattern` (section 8; default `prod|prd|live`) is a JavaScript
regular expression, compiled case-insensitively and without the global flag, which would carry
`lastIndex` from one test to the next. An empty pattern never matches, and an invalid one falls
back to the default so a typo does not silently turn the warning off. Settings changes recompile
it and redraw the chips.
