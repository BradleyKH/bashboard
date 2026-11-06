# Settings

Settings live at `%APPDATA%\dev.bashboard\settings.json`. The file is created with defaults
on first run, accepts `//` comments, and reloads when you save it. An invalid value falls back
to its default and shows a notice naming the field. If a save leaves the file as invalid JSON,
the running settings stay in effect and a notice appears until the file is fixed.

Most settings take effect on save. `dashboard.visibleOnStart` and `restore.*` apply at the next
launch, and `shell.*` applies to panes opened after the change.

`editor.preferred` picks the editor that Open in editor uses: `zed`, `vscode`, `cursor`,
`visualStudio`, `notepadpp`, `sublime`, `rider`, `intellij`, `webstorm`, `pycharm`, `rustrover`,
`goland`, `clion`, `phpstorm`, `windsurf`, `vscodeInsiders`, `vscodium`, or `default` (the file's
default app). JetBrains IDEs installed through the Toolbox App or the standalone installer are both
found. If the chosen editor is not installed or will not start, the file opens in the default
app and a toast says so.
`editor.command` replaces the editor with your own command line, for example
`code.cmd -g "{path}:{line}"`. Double quotes group an argument, and no shell runs it, so the
program name must include its extension when it is a shim such as `code.cmd`. `{path}` and
`{line}` are filled in wherever they appear (and only there; a command without `{path}` gets no
path), and `{line}` is 1 when no line applies. The Editor section of the Settings tab sets both
fields and lists only the editors it found.

The Font family field in the Appearance section of the Settings tab suggests installed fonts as
you type, and still accepts any name or a comma-separated fallback list.

`accentColor` sets the color of focus borders, selections, find highlights, and other accents
(default `#4fb3c8`, teal). The Accent color field in the Appearance section offers Silver, Orange,
Gold, Green, Teal, Blue, Violet, and Pink. In the file it takes any `#rrggbb` value bright enough to
read on the dark panes; a darker color falls back to the default and shows a notice. A value set
in the file that is not a preset appears in the dialog as Custom.

`contentTextColor` sets the color of text in scratch panes, the file preview and editor, search
results and their preview, the Files list, the Git pane's file, commit, and branch lists and its
diff, the Containers list and logs, the Ports list, and the dashboard's names, values, and clock. It is `accent`
(the default), a pale tint of the accent color that changes with it, or `white`. The tint stays
softer than the accent, so links and highlights still stand out. Secondary text in those places,
such as line numbers, quotes, sizes, and dates, takes a dimmer shade of it. Toolbars, buttons,
and the dashboard's gray labels keep their UI gray, and terminals take it only for pure white
text (the default foreground, bright white, and `#ffffff` in the 256-color palette), keeping
every other color a program picks. The Text color field in the Appearance section offers Accent
tint and White.

The Shortcuts tab of the app dialog (open it with F1 or the dashboard's **?** button, then click
Shortcuts) lists every key in effect, including your own bindings. It is also where keys are changed: click a key to
replace it, click `+` to add another, use Reset on a row to restore its defaults, and Reset all
to drop every custom key. Giving a key to an action that already uses it moves it, and the notice
that follows has Undo.

Most settings can also be changed in the Settings tab, which the dashboard's **⚙** button and
Ctrl+Comma open; its filter field narrows the list as you type. Changes save to settings.json and
keep its comments. Keybindings are edited in the Shortcuts tab or in the file; the tab rewrites the `keybindings` list one entry per line and does not keep comments inside that list.

Entries in the `keybindings` list add to or override the default keys. To remove a default so
the key reaches the shell, add an `unbound` entry. Ctrl+W closes a pane by default, so this
gives it back to bash's delete-previous-word:

```jsonc
{ "keys": "ctrl+w", "action": "unbound" }
```

The `switchToTab` action takes an `index` from 1 to 8 for that tab; the default keys bind
Ctrl+Alt+1 through Ctrl+Alt+8 to it:

```jsonc
{ "keys": "ctrl+alt+1", "action": "switchToTab", "index": 1 }
```

Keys that type text (`sendInput`) are added in the file; the guide lists them but has no field
for their text.

The background (the backdrop) has five styles, chosen with `backdrop.style` or the Background
select in the Background section of the Settings tab: `lights` (Swirling Lights, the
default, a living colony simulation), `matrix` (Matrix, falling glyph rain), `image` (Image, a
picture from your disk), `slideshow` (Slideshow, the pictures in a folder in turn), and `none`
(nothing is drawn behind the panes). A missing or invalid value falls back to `lights` with a
notice. The choice applies live. `backdrop.animate` applies to Swirling Lights and Matrix and starts
`false`, a frozen still frame; set it to `true` to run the background. Ctrl+Shift+A pauses or
resumes either one and saves the choice to `backdrop.animate`; it does nothing under Image,
Slideshow, or None, and the dialog shows Animate only for the two styles it affects. The dialog
shows only the fields that apply to the chosen style. Brightness (the inverse of `scrim.opacity`,
which dims the whole background) and Blur (`scrim.blurPx`, 0 to 20 pixels, default 1) apply to
every style but None. Blur softens the whole background, including the gaps between panes, and
stays on when Ctrl+Shift+B turns the scrim off; it costs some GPU time while the background
animates.

**Swirling Lights** runs at up to 20 frames per second; raise or lower that with `backdrop.maxFps`
(0 for the display's refresh rate). The simulation runs at 12 generations per second under a slow
camera orbit, held still while Windows animation effects are off. It is tuned with `capacity` (the
population it sustains, 300 to 5000; Density in the Settings tab), `mutationRate` (how far
offspring drift in color and strategy, 0 to 4; Color drift in the dialog), `zoom` (0.5 to 3;
above 1 brings the colony closer so it fills more of the window), and `waitingPulse` (a steady
brightness pulse on a waiting Claude session's organisms, off by default). These apply to
Swirling Lights only. While `backdrop.animate` is off, the dialog hides the frame
rate cap, Density, Color drift, and the pulse toggle, which a still frame cannot show.

**Matrix** draws digital rain, one falling column of half-width katakana, digits, and symbols per
cell column, in the `MS Gothic` or `Yu Gothic` font that ships with Windows. Its fields live under
`backdrop.matrix`, which are Color, Zoom, Speed, and Density in the dialog:

- `color` is the rain's color: `green` (the default, the classic `#00ff41`) or `accent`, a
  vivid, full-brightness version of the accent color that changes with it (Silver stays a pale
  silver). The leading glyph of each column is drawn near white, and the trail fades to black.
- `zoom` (0.5 to 3, default 1) scales the glyph size; at 1 a cell is 20 px.
- `speed` (5 to 30, default 10) is how many rain steps run per second. It is independent of
  `maxFps`, which Matrix ignores. The dialog hides Speed while `backdrop.animate` is off.
- `density` (0.25 to 4, default 3) scales how often a new drop starts in a column once the last
  one has fallen off the bottom. Lower values leave more empty columns; higher ones keep the
  screen busy.

An invalid `color`, `zoom`, `speed`, or `density` falls back to its default with a notice. With `animate` off
(or while Windows animation effects are off) Matrix shows a still frame of rain that is already
falling, not an empty screen.

**Image** and **Slideshow** draw pictures from your disk (PNG, JPEG, WebP, AVIF, BMP, or GIF; a GIF
shows its first frame). Their fields live under `backdrop.image`:

- `file` is Image's picture and `folder` is Slideshow's folder. Both may contain `%VARS%` and start
  empty; the Settings tab has a Browse button beside each. Nothing is drawn until one is set.
- `fit` is how the picture fills the window, as in the Windows wallpaper settings: `fill` (the
  default; covers the window, cropping the overflow), `fit` (the whole picture, with bars),
  `stretch`, `center` (actual size), or `tile`. Bars and empty space take the app's background
  color.
- `intervalSeconds` (5 to 86400, default 600) is how long Slideshow shows each picture. The dialog
  offers 30 seconds to 1 day; another value set in the file shows as Custom.
- `crossfadeSeconds` (0 to 10, default 5) is how long Slideshow takes to fade from one picture to
  the next; 0 switches with no fade.
- `shuffle` (default `true`) shows the folder in random order, every picture once before any
  repeats; off, it goes in name order. `includeSubfolders` (default `false`) also takes pictures
  from the folders inside it.

Slideshow fades between pictures (and switches instantly while Windows animation effects are off),
reads the folder again before each change so added and removed pictures are picked up, and
holds its place while the window is minimized. A picture that cannot be shown (missing, unreadable,
or over 100 MB) raises a notice; Slideshow skips it and moves on.

```jsonc
"backdrop": {
  "style": "lights",
  "animate": false,
  "maxFps": 20,
  "capacity": 1000,
  "mutationRate": 0.2,
  "zoom": 2,
  "waitingPulse": false,
  "matrix": { "color": "green", "zoom": 1, "speed": 10, "density": 3 },
  "image": { "file": "", "folder": "", "fit": "fill", "intervalSeconds": 600, "crossfadeSeconds": 5, "shuffle": true, "includeSubfolders": false }
}
```

`shell.defaultProfile` picks the shell a plain split runs: `gitBash` (the default), `pwsh`
(PowerShell 7), `powershell` (Windows PowerShell), or `cmd`. An unknown value falls back to
`gitBash` with a notice. A profile that is not installed falls back to the first available profile
in the order Git Bash, PowerShell 7, Windows PowerShell, Command Prompt, with a notice the first
time each missing shell is asked for. `shell.path` and `shell.args` configure Git Bash only. The
Default shell select in the Terminal section of the Settings tab sets it too (see
[PowerShell, Windows PowerShell, and Command Prompt](setup.md#powershell-windows-powershell-and-command-prompt)):

```jsonc
"shell": { "defaultProfile": "gitBash" }
```

Restore on relaunch is controlled by `restore.enabled` (reopen the saved terminals),
`restore.resumeSessions` (type the agent's resume command into terminals that had an agent session; an older `resumeClaude` key is still read), and
`restore.scrollback` (save each terminal's scrollback when the window closes and show it again
above the new prompt); all three default to `true`. Turning `restore.scrollback` off also deletes
the scrollback already saved, at the next close:

```jsonc
"restore": { "enabled": true, "resumeSessions": true, "scrollback": true }
```

`dashboard.side` (`"right"` by default, or `"left"`) docks the dashboard on that side of the
window; an unknown value falls back to `right` with a notice. `dashboard.sections` shows or hides
each dashboard element: `launch`, `panes`, `containers`, `ports`, `forge`, `localModels`, and `external` default to
`true`, and `favorites`, `layouts`, `system`, `wave`, and `clock` to `false`. While `favorites` or `layouts` is off,
the panel's top bar has a button for it instead, and while `launch` is off, a **+** button that
drops the Launch menu. A settings file that still has `sections.folder` and no `sections.launch`
uses it for Launch. A settings file that still has `containers.enabled` and no
`sections.containers` uses it for the Containers section. These only affect the dashboard; the
kind menu offers a Containers pane whenever a container engine is found, and a Ports pane
always. The Ship section lists what needs you across the repos pinned to the Ship Overview (a red health branch, your own pull request with changes requested or failing checks, or up to 5 pull requests awaiting your review), then the running pipelines and a count of open pull requests, and offers to pin repos while none is pinned. The Local AI models section (a preview) hides itself while no Ollama or LM Studio server answers. All of them apply on save and are in the Dashboard section of the Settings tab, the
elements under "Show on the dashboard".

`dashboard.clockStyle` picks what the clock shows: `"both"` (the default) for the binary dots and
the time, `"time"` for the time only, or `"binary"` for the dots only. An unknown value falls back
to `both` with a notice. It applies on save and is the Clock style select under "Show on the
dashboard", shown while the clock is on; right-clicking the clock sets it too.

```jsonc
"dashboard": {
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
}
```

`terminal.doneAfterSeconds` (default 30) is the shortest shell command that marks its terminal
`done` or `failed` when it finishes out of view; 0 turns the marks off. It applies to Git Bash with
the `~/.bashrc` lines only.

`terminal.notifyWhenWaiting` (default `true`) shows a Windows notification when a terminal starts
waiting while Bashboard is in the background; clicking it brings the window forward on that pane.

```jsonc
"terminal": { "doneAfterSeconds": 30, "notifyWhenWaiting": true }
```

`scrollback` (default 10000) is how many lines each terminal keeps. `shell.startingDirectory`
(default `%USERPROFILE%`, and it may hold other `%VARS%`) is where a terminal starts when it has
no folder to inherit. All of these are in the Terminal section of the Settings tab.

`git.autoFetchMinutes` (default 5, 0 to 1440) is the number of minutes between background fetches
of repos with an open Git pane; 0 turns them off. It applies on save and is also in the Git
section of the Settings tab.

```jsonc
"git": { "autoFetchMinutes": 5 }
```

`localModels.ollamaUrl` and `localModels.lmStudioUrl` (both default empty) set the address Bashboard
asks for local AI models. An empty Ollama URL uses `OLLAMA_HOST` when it is set (a bind address such as
`0.0.0.0` maps to `127.0.0.1`), else `http://127.0.0.1:11434`; an empty LM Studio URL uses
`http://127.0.0.1:1234`. `localModels.minContext` (default 64000) is the context length below which a loaded
model is flagged; 0 turns the warning off. All three are in the Local AI models section of the
Settings tab.

```jsonc
"localModels": { "ollamaUrl": "", "lmStudioUrl": "", "minContext": 64000 }
```

`ship.hosts` (default `{}`) tells Bashboard which provider a self-hosted host runs. It maps a
host name, such as `ghe.example.com`, to `github`, `gitlab`, `bitbucket`, or `azureDevOps`. Use it
for a self-hosted GitHub Enterprise Server host the GitHub CLI (`gh`) is not signed in to, or a
self-managed GitLab host that GitLab CLI's (`glab`) config does not list; a host you are signed in
to with `gh` or `glab` is found without an entry. Of the four kinds, `github` and `gitlab` are
served for a self-hosted host. `azureDevOps` names Azure DevOps Services (dev.azure.com), whose
clone URLs are recognized without an entry; an entry for another host does not make Azure
DevOps Server work, since Bashboard calls dev.azure.com only. The Bitbucket provider speaks only
Bitbucket Cloud (bitbucket.org), so any other Bitbucket host is refused with "Bitbucket Data Center
isn't supported yet" before a request is sent. Host names are
lowercased when the file loads, so their case does not matter. An entry with any other kind is
dropped with a notice, and the other entries still apply. The map has no field in the Settings tab;
edit it in the file. See [Code hosts](setup.md#code-hosts) for what the Ship pane needs.

```jsonc
"ship": { "hosts": { "ghe.example.com": "github" } }
```

`ship.pinnedRepos` (default `[]`) lists the repos on the Ship pane's Overview tab, one row each. An
entry's `repo` is `<host>/<path segments>`, such as `bitbucket.org/keysys/kweb`, and is the pin's
identity. `root` (optional) is a local clone of the repo. `branches` (optional) adds branches to the
row's health strip beyond the automatic ones. Pin and unpin from the Ship pane ("Pin to Overview"
and "Unpin"); the file is also yours to edit, and it applies on save. An entry whose
`repo` is missing or empty, or whose `root` or `branches` has the wrong type, is dropped with a
notice naming its position in the list, and the other entries still apply. The list has no field in
the Settings tab.

`ship.overviewRefreshMinutes` (default 5, 0 to 1440) is the number of minutes between background
refreshes of the Overview; 0 turns them off, leaving the Refresh button. A repo with a pipeline
queued or running on any branch is refreshed every 60 seconds whatever the interval. Each
refresh costs about 3 requests (its runs, its open pull requests, and the statuses of open pull
requests that changed), and Bitbucket allows 1,000 requests an hour per user, so Bitbucket repos
stay within 600 an hour between them: with more than three pinned, each is refreshed no more often
than every 18 seconds times the number pinned (every 3 minutes for ten), even when this interval
is shorter. It applies on save and is also in the Ship section of the Settings tab.

```jsonc
"ship": {
  "overviewRefreshMinutes": 5,
  "pinnedRepos": [
    { "repo": "bitbucket.org/keysys/kweb", "root": "C:/Users/me/source/repos/kweb", "branches": ["uat"] }
  ]
}
```

Bashboard also keeps `favorites.json`, `layouts.json`, `repos.json`, and `workspace.json` next to
`settings.json`. Bashboard rewrites `workspace.json` itself (version 3, holding every tab);
`favorites.json`, `layouts.json`, and `repos.json` are plain JSON you can edit by hand, and the
panel updates when you save them.

The default keys are in [docs/design/keys.md](design/keys.md) section 4.5, and the schema in
[docs/design/data.md](design/data.md) section 8.
