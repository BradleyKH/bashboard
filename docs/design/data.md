# Settings, saved state, and the data model

Section numbers are ids shared across `docs/design/`; [the index](README.md#index) maps each to its file.

## 3.6 Settings (`src-tauri/src/settings/`)

Stored as `settings.json` in Tauri's app config folder (`%APPDATA%\dev.bashboard` on Windows,
`~/Library/Application Support/dev.bashboard` on macOS, `$XDG_CONFIG_HOME/dev.bashboard` or
`~/.config/dev.bashboard` on Linux), watched and hot-reloaded. Schema in section 8. Debug builds
use the `dev` subfolder for this file and for the app-owned files below (`config_dir.rs`), seeding settings.json from the installed app's
copy on first run.

The app never rewrites the file whole. `settings_set(path, value)` changes one value in place
(`src-tauri/src/settings_edit.rs`), adding the key and any missing parent objects, and keeps
comments and formatting everywhere else; the write goes to a temp file renamed into place. The
watcher then reloads it like a hand edit, so changes reach the front end through
`settings://changed` either way. A file that is not valid JSONC is left alone and the change
fails.

## 3.7 Workspace and favorites (`src-tauri/src/workspace.rs`)

Five app-owned files next to `settings.json`, each read and written whole through a pair of
commands. Every write the core makes to these and to the scrollback and pad files below goes to
a temp file, is flushed to disk, and is renamed into place, so neither a crash nor a power cut
leaves half a file (`src-tauri/src/atomic_file.rs`):

| File | Commands | Contents |
| --- | --- | --- |
| `workspace.json` | `workspace_load`, `workspace_save` | Open tabs, their panes, and layouts (section 7), for restore (4.9); dashboard state and pane text zoom |
| `favorites.json` | `favorites_load`, `favorites_save` | Favorite folders (4.6) |
| `layouts.json` | `layouts_load`, `layouts_save` | Named layouts (4.6) |
| `repos.json` | `repos_load`, `repos_save` | Pinned files and folders per repo (4.12), and the branch worktrees are compared with (4.13) |
| `pins.json` | `pins_load`, `pins_save` | Global command pins (4.6) |

The core treats all five as opaque JSON, except that the worktree commands (3.9) read each repo's
`primaryBranch` from `repos.json`; the front end owns their shape and validation.
`favorites.json`, `layouts.json`, `repos.json`, and `pins.json` are hand-editable, so they are
watched and hot-reloaded like `settings.json`, emitting `favorites://changed`, `layouts://changed`,
`repos://changed`, and `pins://changed`. They are kept out of `settings.json` because the app rewrites them from the
dashboard, and rewriting a hand-edited JSONC file would drop its comments.

Each save first copies the file it replaces to `<name>.bak`, when that file parses, so a
half-typed hand edit never becomes the backup. The `*_load` commands recover from a file that
exists but does not parse: it is moved aside as `<name>.corrupt-<unix seconds>`, which keeps the
next save from overwriting it, and `<name>.bak` is loaded instead. A missing file loads as
nothing without consulting the backup, so deleting a file still resets it. The watcher's reloads
leave an unparsable file alone, since it may be mid-edit.

Scratch pads (4.15) live beside them as `scratch/<id>.txt`, written by `scratch_save(id, text)`
and removed by `scratch_delete(id)`; `scratch_load(id)` reads one back on restore.

Terminal scrollback (4.9) lives in `scrollback/<id>.txt`. `scrollback_save_all(entries)` writes
each `{ id, text }` and deletes every other file in the folder, so it holds exactly the terminals
of the last saved workspace; `scrollback_save(id, text)` writes one without touching the
others; `scrollback_load(id)` reads one back, as an empty string when it is missing. Ids use the scratch pads' alphabet.

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
| `GlobalPin` | `src/globalPins.ts` | `pins.json` (3.7, 4.6), in display order |
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
  `ssoRequired`, `forbidden`, `notFound`, `rateLimited`, `network`, `needsFilePermission` (a
  Linux token save with no keyring and no permission for the file; 3.35), or `other`), `message` (plain
  text, never a token or an `Authorization` header), `url` (a page to open), `signIn` (the argv to
  run in a new terminal pane), `retryAfterSecs`, and `azCli` (whether Azure CLI is installed, sent
  only on Azure DevOps errors).
- `HostAuth`: `provider` (a `ProviderKind`), `host`, `cliInstalled` (`gh`, `glab`, or `az` was
  found; false for Bitbucket), `installArgv` (the command that installs the missing `gh` or `glab`,
  from `auth::install_argv`: winget, or Homebrew by name or full path; set only while the CLI is
  missing, and null when there is no installer or no CLI), `accounts` (the users the CLI holds for the host: several for GitHub
  CLI, at most one for GitLab CLI and Azure CLI; empty for Bitbucket), `activeAccount` (or null),
  `tokenSource` (a `TokenSourceKind`: `ghCli`, `glabCli`, `azCli`, `gitCredentialManager`,
  `bashboardCredential`, or `environment`; null when no source has a token), `storedTokens` (the
  tokens Bashboard stored for the host, each `{ org, location }`: at most one for Bitbucket, with
  `org` null, and one per Azure DevOps organization; `location`, `keyring` or `file`, is present on
  Linux only), `ghEnvToken` (the variable's name, or null; see 3.20), `detected` (some signal says
  the host is used on this machine), `detectedBy` (the reasons, in words; empty when undetected),
  `knownOrgs`, and `canMoveToKeyring` (Linux: a stored token is in the fallback file and a keyring
  answers). It never holds a token. `Known`, the argument of
  `forge_auth_status`, is `{ hosts, dirs }`: `hosts` holds `{ provider, host }` for each pin and
  open Ship pane, and `dirs` the folders of open terminal panes. `AuthCheck`: `ok`, `login`,
  `scopes` (the granted scopes when the host reports them), and `message`. The
  `forge://auth-changed` payload is `{ provider, host }`.

**Session status.** A hook event newer than the roster's `statusUpdatedAt` wins; otherwise the
roster's value. `waiting` exists only from hooks, and clears on the next `UserPromptSubmit`,
`Stop`, or roster change to `busy`. A Claude Code turn that ends with background agents running
reads as `busy` rather than `idle`, held the same way, and as `waiting` once one of those agents
looks stuck (3.30). The roster payload carries `waitingReason: string | null`
beside each session's status; it is the agent's waiting reason (3.3) and is present only while
the merged status is `waiting`. Each session also carries `agent` (`claude`, `codex`, or
`copilot`). A terminal's `done` is `idle` after a `Stop`, or a long command
that finished, that the user has not looked at yet; `failed` is the same for a nonzero exit (4.8).

**workspace.json.** Version 3, tabs in strip order. Pane ids do not survive a restart, so panes
are saved under keys, and layout leaves hold those keys. A tab's `name` is null while it follows
its focused pane's title. A version 2 file's tabs hold `terminals`, which load as terminal panes;
a version 1 file, which holds one tab's `terminals`, `layout`, and `focused` at the top level,
loads as a single unnamed tab. A tab with no panes is dropped on load, and `activeTab` follows its
tab through the drops or is clamped into range. Absent optional fields take these defaults:

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
- `agentPanesOnly` (the Panes section's AI toggle, 4.6): false, so every pane shows; anything but
  `true` reads as absent.
- `hideStoppedContainers` (the Containers section's eye toggle, 4.6): false, so stopped groups
  show; anything but `true` reads as absent.
- `needsYouHides` (hide keys of the Needs you rows the user hid until their state changes, 4.28): none.
  Reading keeps the strings and drops anything else; an empty list reads as absent.
- `hideGlobalPins` (the Pins heading's globe toggle, 4.6): false, so global pins list in the
  section; anything but `true` reads as absent.
- `dashboardHideNoticeShown` (whether hiding the dashboard with × has shown its toast, 4.6):
  false; anything but `true` reads as absent.
- `tourDone` (whether the first-run tour finished or was skipped, 4.29): false; anything but
  `true` reads as absent.
- `appImageOfferShown` (whether the AppImage menu entry offer has been shown, 3.32): false;
  anything but `true` reads as absent.
- `filesView` (the view a new Files pane starts in, 4.12): the Tree view; any value but
  `"folder"` or `"tree"` reads as absent.
- `filesSorts` (the sort a new Files pane starts at, by folder, 4.12): an object from a folder's
  comparison key (separators as `/`, case folded except on Linux) to `{ key, desc }`; a folder
  absent starts at Modified, newest first. Reading drops malformed entries, and only the 200
  folders sorted most recently are kept.
- `textZoom` (`filesList`, `filePreview`, `gitDiff`, `searchPreview`, `scratch`, and
  `containerLogs`, the zoom new panes of those kinds start at, 4.12 to 4.16): 1 for an absent
  field or one outside 0.5 to 3.
- A terminal pane's `profile`: the default profile. Its `permissionMode` (letters only, kept
  only beside a `sessionId`): the default mode. Its `agent` (`claude`, `codex`, or `copilot`):
  Claude Code, which an unknown value also reads as. Its `resumeModel` (kept only beside a
  `sessionId`): none. Its `scrollbackId` (the scratch id alphabet):
  none, so the terminal starts without saved scrollback. Its `pty` (`{ id, startedAt }`, both
  integers, valid only while the core that spawned it runs): none, so the terminal starts a new
  shell. A Files pane's `root`: resolved from its
  `folder`. Its `expanded`: false. Its `view`: `folder`, the other being `tree`. Its
  `openFolders` (the tree's expanded folders, as paths below `folder` with forward slashes;
  entries that are not strings, are empty, or hold `..` are dropped): none. Its `sort`: the
  folder's entry in `filesSorts`, else Modified, newest first, which a malformed value also reads
  as. A Git pane's `tab`: Changes; only `branches` is saved, and any other value reads as absent.
  A Ship pane's `root`: none, which opens on the Overview;
  a drilled pane saves its local repo root or `remote:<host>/<path>`. Its `tab`: `pipelines`, the
  other being `pulls`; it is omitted from the file when it is `pipelines`. Its `thisBranch`, `thisBranchPulls`, and
  `allPulls`: false, and each omitted when false; any value but `true` reads as false. A Browser
  pane's `url`: none, the start page, which an empty or non-string value also reads as. Its
  `devtools`: closed, with the drawer's defaults. Its `device`: none.

**layouts.json.** Names are unique without regard to case. A layout holds one tab whose
terminals carry no session ids, permission modes, scrollback ids, or ptys and whose scratch pads have a null
`scratchId`, so they open fresh; the tab's own `name` is ignored, since it takes the layout's. An
entry whose `workspace` holds a version 1 workspace loads as that one tab.

**repos.json.** Roots compare without regard to case on Windows and macOS and exactly on Linux, whose file systems tell case apart (`pathCompare.ts`). A pin's path is relative to the root, with
forward slashes, when inside the repo, else absolute. A pin with a `command` (the whole command
line, as one string) is a command pin, and its path is the folder the command runs in; `label` is
optional on either kind. `primaryBranch`, the branch the Git pane
compares worktrees with (4.13), is keyed by the main worktree's path; an entry may hold
it with no pins, and Automatic omits it.

**pins.json.** A list of `{ label?, command }`, the global command pins in display order. Both are
trimmed; an entry with a blank command is dropped, and so is a repeat of an earlier entry's command
(commands compare exactly, since case can matter to a shell). A pin has no path, since it runs in
the focused pane's folder.

## 8. Settings

[docs/settings.md](../settings.md) owns each field's meaning, range, and Settings tab field. This
section keeps the file's shape with its defaults, and the rules a user does not need.

```jsonc
{
  // Off Windows, startingDirectory is %HOME% and defaultProfile is loginShell. Any lowercase id
  // up to 32 characters parses as a profile (a shell's file name from /etc/shells); one that is
  // not installed falls back as described in 3.1. path and args configure Git Bash only.
  "shell": {
    "path": "C:\\Program Files\\Git\\bin\\bash.exe",
    "args": ["--login", "-i"],
    "startingDirectory": "%USERPROFILE%",
    "defaultProfile": "gitBash"
  },
  "font": { "family": "JetBrainsMono Nerd Font Mono, Cascadia Mono", "size": 14 },
  // Read by CSS as --accent. A value below WCAG relative luminance 0.2 falls back to the
  // default, so it keeps 4.5:1 contrast on the dark panes and behind find highlights' dark text.
  "accentColor": "#4fb3c8",
  // Read by CSS as --content-fg. accent is 35% of accentColor mixed into #ececec, with the
  // accent's share lowered as needed to keep WCAG relative luminance at 0.5 or more; white is
  // #e6e6e6. Terminals take it for the default foreground, bright white, and 256-color index 231,
  // never for truecolor white. A #rrggbb value loads as white when it is #e6e6e6 and as accent
  // otherwise.
  "contentTextColor": "accent",
  // Match accent's pairings are in files.md section 4.22.
  "codeColors": { "scheme": "matchAccent" },
  // Scales controls, the bars that hold them, chrome titles, and the app dialog (section 5).
  "uiScale": 1.25,
  // Section 4.23.
  "agentGlow": false,
  "borderLights": false,
  "borderLightsSpeed": 120,
  "borderLightsDensity": 1,
  // Section 4.30.
  "tabTransition": true,
  "showBackgroundTabs": false,
  "scrim": { "opacity": 0.5, "blurPx": 1 },
  // animate false freezes lights, galaxy, matrix, and wave on a still frame (6.4). capacity,
  // mutationRate, and zoom drive lights and galaxy (6.2, 6.6); wave is 6.7, image 6.5. The
  // accent color of matrix and wave is accentColor at full brightness with its HSV saturation
  // raised by half, so a gray accent stays gray. A #rrggbb matrix.color loads as green when it
  // is #00ff41 and as accent otherwise. matrix.speed, wave.echoes, and image.intervalSeconds are
  // whole numbers.
  "backdrop": {
    "style": "galaxy",
    "animate": false,
    "maxFps": 20,
    "capacity": 1000,
    "mutationRate": 0.2,
    "zoom": 2,
    "matrix": { "color": "green", "zoom": 1, "speed": 10, "density": 3 },
    "wave": { "color": "accent", "size": 0.85, "speed": 0.5, "lineWidth": 3, "echoes": 4 },
    "image": { "file": "", "folder": "", "fit": "fill", "intervalSeconds": 600, "crossfadeSeconds": 5, "shuffle": true, "includeSubfolders": false }
  },
  "scrollback": 10000,
  // doneAfterSeconds is 4.8; notifyWhenWaiting is 4.7 and 4.28.
  "terminal": { "doneAfterSeconds": 30, "notifyWhenWaiting": true },
  // Section 4.6. When the newer key is absent, an older file's sections.folder (Launch's old
  // name) seeds sections.launch, and its containers.enabled seeds sections.containers.
  "dashboard": {
    "visibleOnStart": true,
    "peekOnWaiting": true,
    "side": "right",
    "sections": {
      "launch": true,
      "pins": true,
      "needs": true,
      "favorites": false,
      "layouts": false,
      "panes": true,
      "containers": true,
      "ports": true,
      "ship": true,
      "branch": false,
      "localModels": true,
      "external": true,
      "system": false,
      "media": true,
      "wave": false,
      "clock": false
    },
    "clockStyle": "both",
    "mediaArt": true,
    "mediaTitle": true,
    "mediaArtist": true,
    "systemRows": { "cpu": true, "memory": true, "network": true, "disk": true },
    "portRows": 10
  },
  // Section 4.28; stuckAgentMinutes is 3.30.
  "needsYou": { "walkAll": true, "usagePercent": 80, "stuckAgentMinutes": 15 },
  // Section 4.9. An older file's resumeClaude is read when resumeSessions is absent.
  "restore": { "enabled": true, "resumeSessions": true, "scrollback": true },
  // Section 3.19. An empty ollamaUrl uses OLLAMA_HOST, else http://127.0.0.1:11434; an empty
  // lmStudioUrl uses http://127.0.0.1:1234.
  "localModels": { "ollamaUrl": "", "lmStudioUrl": "", "minContext": 64000 },
  // hosts (3.20) is matched without regard to case; pinnedRepos is 4.20.
  "ship": { "hosts": {}, "overviewRefreshMinutes": 5, "pinnedRepos": [], "cliWrites": false },
  // Section 3.21. A bookmark url or homeUrl must be http or https on localhost or 127.0.0.1,
  // with an optional port and path, or a file:/// URL to an .html or .htm file. An allowedHosts
  // key may be a single file, for a page opened directly from the home folder or a drive root.
  // homeUrl, trustedFolders, and reloadOnChange have Settings tab fields; bookmarks,
  // allowedHosts, and cdnHosts do not.
  "localBrowser": {
    "bookmarks": [],
    "homeUrl": "",
    "trustedFolders": [],
    "allowedHosts": {},
    "cdnHosts": ["cdnjs.cloudflare.com", "cdn.jsdelivr.net", "unpkg.com", "fonts.googleapis.com", "fonts.gstatic.com"],
    "reloadOnChange": true
  },
  // Linux only. disableDmabufRenderer is read once at launch (3.31); allowFileCredentials on
  // each token save (3.35).
  "linux": { "disableDmabufRenderer": "auto", "allowFileCredentials": false },
  // Section 3.12.
  "editor": { "preferred": "default", "command": "" },
  // autoFetchMinutes is 3.9.
  "git": { "autoFetchMinutes": 5, "branchSizeThreshold": 400 },
  // Section 4.25.
  "cloud": { "badge": false, "productionPattern": "prod|prd|live" },
  // Added to or overriding the defaults in 4.5. The Shortcuts tab (4.18) rewrites this list
  // one entry per line; comments inside it are not kept, comments elsewhere in the file are.
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
