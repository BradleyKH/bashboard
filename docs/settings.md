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
app and a toast says so. Scripts, programs, and shortcuts (`.bat`, `.exe`, `.lnk`, `.ps1`, and
the like) open in Notepad rather than their default app, which would run them.
`editor.command` replaces the editor with your own command line, for example
`code.cmd -g "{path}:{line}"`. Double quotes group an argument, and no shell runs it, so the
program name must include its extension when it is a shim such as `code.cmd`. `{path}` and
`{line}` are filled in wherever they appear (and only there; a command without `{path}` gets no
path), and `{line}` is 1 when no line applies. The Editor section of the Settings tab sets both
fields and lists only the editors it found.

The Font family field in the Appearance section of the Settings tab suggests installed fonts as
you type, and still accepts any name or a comma-separated fallback list.

`font.size` (default 14, from 6 to 48 px) is the Text size field in the Appearance section, also
stepped by Ctrl+= and Ctrl+-. It sizes terminal text and the text you read in other panes: code
and the text editor in a preview, scratch pads, Search's code lines, and Containers logs render
at it directly, and the Files list, Markdown and CSV previews, and the Git diff scale with it from
their own sizes at the default 14. Each pane's zoom buttons multiply on top.

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

`codeColors.scheme` sets the colors code takes in text previews: the Files and Search previews
and editor, rendered markdown's fenced blocks, and the Git diff. It is `matchAccent` (the
default), which picks the scheme paired with the current accent, one of `nord`, `ayu`,
`gruvbox`, `monokai`, `tokyoNight`, `oneDark`, `catppuccinMocha`, and `dracula`, or `none`, which
turns code colors off and shows every character in the text color; any other value falls back to
`matchAccent` and shows a notice. The Code colors field in the Appearance section, after Text
color, offers Match accent, the eight schemes by name, and None, and names the scheme Match
accent resolves to, as "Match accent (Tokyo Night)". Below the field, a short TSX sample shows
the chosen scheme in the Font family you set and the Text color you chose, and redraws as you
change the scheme, the accent, the text color, or the font, before anything is saved. Text that no
scheme colors (identifiers, operators, and punctuation) takes Text color.

Under Match accent, each accent preset has a scheme:

| Accent | Scheme |
| --- | --- |
| Silver | Nord |
| Orange | Ayu |
| Gold | Gruvbox |
| Green | Monokai |
| Teal | Tokyo Night |
| Blue | One Dark |
| Violet | Catppuccin Mocha |
| Pink | Dracula |

A custom `accentColor` takes the scheme of the preset nearest in hue, and one that is nearly gray
(HSV saturation under 0.2) takes Nord, as Silver does.

`uiScale` sets the size of the app's chrome, from `1` (the default, compact) to `2`; at `1.5` the
dashboard's buttons match its Launch buttons. It covers buttons, text boxes, and dropdowns in the
pane title bars, the tab strip, the dashboard, pane toolbars, the find bar, and menus, and
everything in the Help, Settings, Accounts, Shortcuts, CLI, and About dialog. The bars that hold
them grow to fit, and pane titles, tab titles, and the dashboard's section titles grow with them;
pane content and terminal text follow `font.size` instead. The Interface size slider in the
Appearance section sets it live.

`agentGlow` (default `false`) gives a terminal a soft glow in the accent color while an AI agent
(Claude Code, Codex, or Copilot) is working in it; the glow slowly brightens and dims, and stops
when the agent finishes or waits for you. `borderLights` (default `false`) sends a small light
around the border of every pane in the active tab. When a pane needs you, only that pane keeps
its light until you get to it. Both are toggles in the Appearance section, Agent glow and Border
lights, and apply live. Neither appears while Windows is set to reduce animations.
`borderLightsSpeed` (default `60`, 10 to 300 px per second) sets how fast the lights travel, and
`borderLightsDensity` (default `1`, 0.25 to 4) how many run per 1000 px of a pane's border, with
at least one per pane. Both are sliders under Border lights in Settings, shown while it is on.

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

A chord names its modifiers with `ctrl`, `alt`, `shift`, and `win`. On macOS, write `cmd` for
Command and `option` for Option (`win` and `alt` still work); the macOS defaults are Cmd chords,
so there the first example above is `{ "keys": "cmd+w", "action": "unbound" }`.

The background (the backdrop) has seven styles, chosen with `backdrop.style` or the Background
select in the Background section of the Settings tab: `lights` (Swirling Lights, the
default, a living colony simulation), `galaxy` (Galaxy, a slowly turning spiral galaxy), `matrix` (Matrix, falling glyph rain), `wave` (Wave, a large version of the
dashboard's Wave), `image` (Image, a
picture from your disk), `slideshow` (Slideshow, the pictures in a folder in turn), and `none`
(nothing is drawn behind the panes). A missing or invalid value falls back to `lights` with a
notice. The choice applies live. `backdrop.animate` applies to Swirling Lights, Galaxy, Matrix, and Wave and starts
`false`, a frozen still frame; set it to `true` to run the background. Ctrl+Shift+A pauses or
resumes any of them and saves the choice to `backdrop.animate`; it does nothing under Image,
Slideshow, or None, and the dialog shows Animate only for the four styles it affects. The dialog
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
above 1 brings the colony closer so it fills more of the window). These apply to Swirling
Lights and Galaxy. While `backdrop.animate` is off, the dialog hides the frame rate cap, Density,
and Color drift, which a still frame cannot show.

**Galaxy** shares Swirling Lights' settings, read for a fixed starfield: `capacity` sets how many
stars there are (8 per unit, up to 40,000), `mutationRate` how fast and how far hues wander across
the disc (0 holds them still; 4 wanders the whole color wheel), and `zoom` how close the camera
sits. The stars fill the disc in a swirl with only a hint of spiral arms, and its light is even
from the center to the rim, so text reads the same wherever a pane sits. Density and Zoom change
how fine and how close the field looks, not how bright it is. The disc turns
slowly under a camera tilted 45 degrees from overhead, which sways a little unless Windows
animation effects are off.

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

**Wave** draws the dashboard's Wave across the whole window: a looping line turning in 3D
whose weave tightens with CPU load, whose spin quickens with network traffic, and whose
lopsided detune sweeps faster as memory fills. It runs at up to `backdrop.maxFps` like Swirling
Lights. Its fields live under `backdrop.wave`, which are Color, Size, Speed, Line width, and
Echoes in the dialog (a file that says `lissajous` for the style or the block still loads as
Wave):

- `color` is the line's color: `accent` (the default, a vivid, full-brightness version of the
  accent color, as for the Matrix rain), `white`, or `spectrum`, a rainbow running along the line
  that slowly turns.
- `size` (0.3 to 2, default 0.85) is the share of the window the figure fills. It stretches to
  the window's shape, and above 1 it spills past the edges.
- `speed` (0.1 to 3, default 0.5) scales how fast it spins, tilts, and sweeps; at 1 it moves at the
  dashboard Wave's pace. Load reshapes it just as quickly at any speed. The dialog hides Speed
  and the frame rate cap while `backdrop.animate` is off.
- `lineWidth` (1 to 8, default 3) is the line's width in pixels on its near side; the far side
  draws at about a third of that.
- `echoes` (0 to 15, default 4) is how many faint copies trail the line through its spin.

An invalid value falls back to its default with a notice. With `animate` off Wave shows a still
figure shaped by the load when it froze; while Windows animation effects are off it holds still
but reshapes on each new reading.

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
  "matrix": { "color": "green", "zoom": 1, "speed": 10, "density": 3 },
  "wave": { "color": "accent", "size": 0.85, "speed": 0.5, "lineWidth": 3, "echoes": 4 },
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
each dashboard element: `launch`, `panes`, `containers`, `ports`, `ship`, `localModels`, and `external` default to
`true`, and `favorites`, `layouts`, `branch`, `system`, `wave`, and `clock` to `false`. While `favorites` or `layouts` is off,
the panel's top bar has a button for it instead, and while `launch` is off, a **+** button that
drops the Launch menu. A settings file that still has `sections.folder` and no `sections.launch`
uses it for Launch. A settings file that still has `containers.enabled` and no
`sections.containers` uses it for the Containers section. These only affect the dashboard; the
kind menu offers a Containers pane whenever a container engine is found, and a Ports pane
always. The Ship section lists what needs you across the repos pinned to the Ship Overview (a red health branch, your own pull request with changes requested or failing checks, or up to 5 pull requests awaiting your review), then the running pipelines and a count of open pull requests, and offers to pin repos while none is pinned. The Branch section follows the focused pane's worktree, showing its branch size meter against `git.branchSizeThreshold`, ahead and behind counts, uncommitted changes, and the branch's latest CI run, and hides itself while the focused folder is not in a git repo. The Local AI models section (a preview) hides itself while no Ollama or LM Studio server answers. All of them apply on save and are in the Dashboard section of the Settings tab, the
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
    "branch": false,
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

`terminal.notifyWhenWaiting` (default `true`) shows a system notification (Windows or macOS) when a
terminal starts waiting while Bashboard is in the background; clicking it brings the window forward
on that pane. On macOS, the first notification asks for permission.

```jsonc
"terminal": { "doneAfterSeconds": 30, "notifyWhenWaiting": true }
```

`scrollback` (default 10000) is how many lines each terminal keeps. `shell.startingDirectory`
(default `%USERPROFILE%`, and it may hold other `%VARS%`) is where a terminal starts when it has
no folder to inherit. All of these are in the Terminal section of the Settings tab.

`git.autoFetchMinutes` (default 5, 0 to 1440) is the number of minutes between background fetches
of repos with an open Git pane; 0 turns them off. It applies on save and is also in the Git
section of the Settings tab.

`git.branchSizeThreshold` (default 400) is the number of lines changed against the comparison ref in a
worktree, with tests, lockfiles, and generated files excluded, above which the branch row of the Git pane and the
dashboard session cards show a size warning. 0 turns the warning off; the dashboard's Branch section
still shows the meter, uncolored, at 0. It applies on save and is in the Git section of the Settings
tab.

```jsonc
"git": { "autoFetchMinutes": 5, "branchSizeThreshold": 400 }
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

`ship.cliWrites` (default `false`) lets `bb ci rerun` and `bb ci cancel` act on pipelines; off by
default because pipelines often deploy. It applies on save and is also in the Ship section of the
Settings tab.

```jsonc
"ship": {
  "overviewRefreshMinutes": 5,
  "pinnedRepos": [
    { "repo": "bitbucket.org/keysys/kweb", "root": "C:/Users/me/source/repos/kweb", "branches": ["uat"] }
  ],
  "cliWrites": false
}
```

## Local Browser

`localBrowser.bookmarks` (default `[]`) lists the pages saved in the Local Browser pane, in order.
Each entry is `{ "name": "...", "url": "..." }`. A URL must be `http` or `https` on `localhost`
or `127.0.0.1`, with an optional port and path, or a `file:///` URL to an `.html` or `.htm` file. An
entry with an empty or missing name or URL, or a URL outside that rule, is dropped with a notice
naming its position, and the other entries still apply. The list has no field in the Settings tab;
edit the file.

`localBrowser.homeUrl` (default `""`) is the page a new Local Browser pane opens on, under the same
URL rule. Empty opens the pane's start page. It applies on save and is also in the Local Browser
section of the Settings tab.

`localBrowser.trustedFolders` (default `[]`) lists folders whose HTML files the pane may let reach
any host. Each entry is an absolute folder path. A file in any other folder reaches only its own
folder's files, the CDN hosts below, and the hosts you allow for its folder. A file that Windows marks as
downloaded from the internet (Mark of the Web) is never trusted, even in a trusted folder. An entry
that is not a string, or is not an absolute path, is dropped with a notice, and the other entries
still apply. It applies on save and is also in the Local Browser section of the Settings tab, one
folder per line.

`localBrowser.allowedHosts` (default `{}`) maps a folder to the hosts its pages may reach beyond the
CDN hosts. A key is an absolute folder path, or the absolute path of a single file for a page opened
directly from your home folder or a drive root, since each such page stands alone; its value is a
list of host names. The pane's Allow button adds to it when a page's request to a new host is
blocked. A Downloaded page (one with Mark of the Web) never reaches a loopback host, so for it a
`localhost`, `*.localhost`, `127.x.x.x`, `0.0.0.0`, or `[::1]` entry here or in `cdnHosts` is
ignored, as is a scheme-only entry (`https:`) or a wildcard that could match one (`*`). A key that
is not an absolute path, a value that is not a list, or a host that is not a string is dropped with
a notice naming it, and the other entries still apply. It has no field in the Settings tab; edit the
file.

`localBrowser.cdnHosts` (default `["cdnjs.cloudflare.com", "cdn.jsdelivr.net", "unpkg.com",
"fonts.googleapis.com", "fonts.gstatic.com"]`) lists the hosts every HTML file page may load
scripts, styles, and fonts from, whatever its folder. An entry that is not a string is dropped
with a notice naming its position. An empty list means pages load nothing from the network unless
their folder allows it. It has no field in the Settings tab; edit the file.

`localBrowser.reloadOnChange` (default `true`) reloads an HTML file page in the pane when its file
changes on disk. Off, the pane shows a "Changed on disk" notice with a Reload button instead. It applies on save and is
also in the Local Browser section of the Settings tab.

```jsonc
"localBrowser": {
  "homeUrl": "http://localhost:5173",
  "bookmarks": [
    { "name": "App", "url": "http://localhost:5173" },
    { "name": "API health", "url": "http://127.0.0.1:8080/health" },
    { "name": "Report", "url": "file:///C:/Users/me/reports/q3.html" }
  ],
  "trustedFolders": ["C:/Users/me/reports"],
  "allowedHosts": { "C:/Users/me/sketches": ["api.example.com"] },
  "reloadOnChange": true
}
```

Bashboard also keeps `favorites.json`, `layouts.json`, `repos.json`, and `workspace.json` next to
`settings.json`. Bashboard rewrites `workspace.json` itself (version 3, holding every tab);
`favorites.json`, `layouts.json`, and `repos.json` are plain JSON you can edit by hand, and the
panel updates when you save them.

The default keys are in [docs/design/keys.md](design/keys.md) section 4.5, and the schema in
[docs/design/data.md](design/data.md) section 8.
