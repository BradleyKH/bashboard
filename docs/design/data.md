# Settings, saved state, and the data model

Section numbers are ids shared across every file in `docs/design/`, so a citation such as
"section 4.5" names one section wherever it lives; [the index](README.md#index) maps each to its file.

## 3.6 Settings (`src-tauri/src/settings/`)

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
- `agentPanesOnly` (the Panes section's AI toggle, 4.6): false, so every pane shows; anything but
  `true` reads as absent.
- `hideStoppedContainers` (the Containers section's eye toggle, 4.6): false, so stopped groups
  show; anything but `true` reads as absent.
- `hideGlobalPins` (the Pins heading's globe toggle, 4.6): false, so global pins list in the
  section; anything but `true` reads as absent.
- `dashboardHideNoticeShown` (whether hiding the dashboard with × has shown its toast, 4.6):
  false; anything but `true` reads as absent.
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
  `folder`. Its `expanded`: false. A Ship pane's `root`: none, which opens on the Overview;
  a drilled pane saves its local repo root or `remote:<host>/<path>`. Its `tab`: `pipelines`, the
  other being `pulls`; it is omitted from the file when it is `pipelines`. Its `thisBranch`, `thisBranchPulls`, and
  `allPulls`: false, and each omitted when false; any value but `true` reads as false.

**layouts.json.** Names are unique without regard to case. A layout holds one tab whose
terminals carry no session ids, permission modes, scrollback ids, or ptys and whose scratch pads have a null
`scratchId`, so they open fresh; the tab's own `name` is ignored, since it takes the layout's. An
entry whose `workspace` holds a version 1 workspace loads as that one tab.

**repos.json.** Roots compare without regard to case. A pin's path is relative to the root, with
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
  // "matchAccent" or one of nord, ayu, gruvbox, monokai, tokyoNight, oneDark, catppuccinMocha,
  // dracula: the syntax color scheme of text previews. Match accent follows the accent preset
  // (files.md section 4.22). Any other value falls back to matchAccent with a notice.
  "codeColors": { "scheme": "matchAccent" },
  // 1 to 2, the Settings tab's Interface size: zoom on controls, the bars that hold them, chrome
  // titles, and the app dialog's tabs (section 5). Out of range falls back to 1.
  "uiScale": 1,
  // Ambient pane effects (section 4.23), both off by default: agentGlow breathes a glow inside
  // panes where an AI agent is working; borderLights runs a light around each pane's border.
  // borderLightsSpeed is 10 to 300 px per second; borderLightsDensity is 0.25 to 4 lights per
  // 1000 px of a pane's border. Out of range falls back to the default.
  "agentGlow": false,
  "borderLights": false,
  "borderLightsSpeed": 60,
  "borderLightsDensity": 1,
  "scrim": { "opacity": 0.5, "blurPx": 1 },
  // style is none, lights (Swirling Lights), galaxy (Galaxy), matrix, wave, image, or
  // slideshow; a missing or invalid value falls back to lights. animate false freezes lights,
  // galaxy, matrix, and wave on a still frame (6.4); the other styles ignore it.
  // maxFps applies to lights, galaxy, and wave, and 0 renders at the display's refresh rate.
  // capacity, mutationRate, and zoom apply to lights and galaxy only: the simulation and camera
  // controls (6.2, 6.6).
  // matrix.color is green (#00ff41) or accent: accentColor at full brightness with its HSV
  // saturation raised by half, so a gray accent stays gray. A #rrggbb value loads as green when it
  // is #00ff41 and as accent otherwise. matrix.zoom is 0.5 to 3 (the base cell is 20 px);
  // matrix.speed is a whole number of rain steps per second, 5 to 30; matrix.density (0.25 to 4)
  // scales how often a new drop starts. wave is for the wave style (6.7): color is
  // accent (accentColor brightened as for matrix), white (#e6e6e6), or spectrum; size (0.3 to 2)
  // is the share of the window the figure fills, spilling past it above 1; speed (0.1 to 3)
  // scales its spin, tilt, and detune sweep; lineWidth (1 to 8) is CSS pixels on the line's near side; echoes is a whole
  // number from 0 to 15. A style of lissajous loads as wave, and a lissajous block fills in any wave
  // field the file doesn't set. image is for the image and slideshow styles (6.5): file
  // and folder may contain %VARS% and are empty until set; fit is fill, fit, stretch, center, or
  // tile; intervalSeconds is a whole number from 5 to 86400; crossfadeSeconds is 0 to 10. Out-of-range or invalid values fall
  // back to their defaults.
  "backdrop": {
    "style": "lights",
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
  // A shell command that runs this many seconds and finishes unseen marks its terminal done or
  // failed; 0 turns it off (4.8). notifyWhenWaiting raises a system notification when a terminal
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
      "branch": false,
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
  // cliWrites lets `bb ci rerun` and `bb ci cancel` act on pipelines; off because pipelines often
  // deploy. It has a Settings tab field.
  "ship": { "hosts": {}, "overviewRefreshMinutes": 5, "pinnedRepos": [], "cliWrites": false },
  // bookmarks are { "name", "url" } pages for the Local Browser pane, in order. An entry with an
  // empty or missing name or url, or a url that is not http or https on localhost or 127.0.0.1,
  // is dropped with a warning naming its position. homeUrl is the page a new pane opens
  // on, with the same host rule; empty opens the pane's start page. homeUrl has a Settings tab
  // field; bookmarks does not. A bookmark or homeUrl may also be a file:/// URL to an .html or
  // .htm file. trustedFolders are folders whose HTML files may reach any host (3.21); a file
  // with Mark of the Web is never trusted. allowedHosts maps a folder to the hosts its pages may
  // reach beyond cdnHosts; the pane's Allow button adds to it. A key is a folder, or a single
  // file for a page opened directly from the home folder or a drive root, which is a mount of its
  // own (3.21). cdnHosts are hosts every file page may load from. reloadOnChange reloads a file
  // page when its file changes on disk. An entry that is not a string, or a folder or allowedHosts
  // key that is not an absolute path, is dropped with a warning.
  // reloadOnChange and trustedFolders have Settings tab fields; the rest do not.
  "localBrowser": {
    "bookmarks": [],
    "homeUrl": "",
    "trustedFolders": [],
    "allowedHosts": {},
    "cdnHosts": ["cdnjs.cloudflare.com", "cdn.jsdelivr.net", "unpkg.com", "fonts.googleapis.com", "fonts.gstatic.com"],
    "reloadOnChange": true
  },
  // zed, vscode, cursor, visualStudio, notepadpp, sublime, rider, intellij, webstorm,
  // pycharm, rustrover, goland, clion, phpstorm, windsurf, vscodeInsiders, vscodium, or default
  // (the file's default app). A non-empty command replaces it, with {path} and {line} filled in
  // (3.12).
  "editor": { "preferred": "default", "command": "" },
  // Minutes between background fetches of repos with an open Git pane; 0 turns it off (3.9).
  // branchSizeThreshold is the lines changed against the comparison ref (tests, lockfiles, and
  // generated files excluded) above which the branch row and session cards show a size warning;
  // 0 turns it off.
  "git": { "autoFetchMinutes": 5, "branchSizeThreshold": 400 },
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
