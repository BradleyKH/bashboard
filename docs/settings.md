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
path), and `{line}` is 1 when no line applies. The Editor section of the settings dialog sets both
fields and lists only the editors it found.

The Font family field in the Appearance section of the settings dialog suggests installed fonts as
you type, and still accepts any name or a comma-separated fallback list.

`accentColor` sets the color of focus borders, selections, find highlights, and other accents
(default `#4fb3c8`, teal). The Accent color field in the Appearance section offers Silver, Orange,
Gold, Green, Teal, Blue, Violet, and Pink. In the file it takes any `#rrggbb` value bright enough to
read on the dark panes; a darker color falls back to the default and shows a notice. A value set
in the file that is not a preset appears in the dialog as Custom.

`contentTextColor` sets the color of text in scratch panes, the file preview and editor, search
results and their preview, the Files list, the Git pane's file, commit, and branch lists and its
diff, the Containers list and logs, and the dashboard's names, values, and clock. It is `accent`
(the default), a pale tint of the accent color that changes with it, or `white`. The tint stays
softer than the accent, so links and highlights still stand out. Secondary text in those places,
such as line numbers, quotes, sizes, and dates, takes a dimmer shade of it. Toolbars, buttons,
and the dashboard's gray labels keep their UI gray, and terminals take it only for pure white
text (the default foreground, bright white, and `#ffffff` in the 256-color palette), keeping
every other color a program picks. The Text color field in the Appearance section offers Accent
tint and White.

Press F1, or click Keyboard shortcuts at the bottom of the dashboard, for a guide to every key
in effect, including your own bindings. The guide is also where keys are changed: click a key to
replace it, click `+` to add another, use Reset on a row to restore its defaults, and Reset all
to drop every custom key. Giving a key to an action that already uses it moves it, and the notice
that follows has Undo.

Most settings can also be changed from the Settings button at the bottom of the dashboard or with
Ctrl+Comma. Changes save to settings.json and keep its comments. Keybindings are edited in the
shortcut guide (Settings > Keyboard > Edit keyboard shortcuts opens it) or in the file; the guide
rewrites the `keybindings` list one entry per line and does not keep comments inside that list.

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

The background (the backdrop) has three styles, chosen with `backdrop.style` or the Background
select in the Background section of the settings dialog: `lights` (Swirling Lights, the
default, a living colony simulation), `matrix` (Matrix, falling glyph rain), and `none` (nothing is
drawn behind the panes). A missing or invalid value falls back to `lights` with a notice. The
choice applies live. `backdrop.animate` applies to both drawn styles and starts `false`, a frozen
still frame; set it to `true` to run the background. Ctrl+Shift+D pauses or resumes whichever style
is showing and saves the choice to `backdrop.animate`; it does nothing under None. The dialog shows
only the fields that apply to the chosen style. Brightness (the inverse of `scrim.opacity`, which
dims the whole background) and Blur (`scrim.blurPx`, 0 to 20 pixels, default 1) apply to
both drawn styles. Blur softens the whole background, including the gaps between panes, and
stays on when Ctrl+Shift+B turns the scrim off; it costs some GPU time while the background
animates.

**Swirling Lights** runs at up to 20 frames per second; raise or lower that with `backdrop.maxFps`
(0 for the display's refresh rate). The simulation runs at 12 generations per second under a slow
camera orbit, held still while Windows animation effects are off. It is tuned with `capacity` (the
population it sustains, 300 to 5000; Density in the settings dialog), `mutationRate` (how far
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

```jsonc
"backdrop": {
  "style": "lights",
  "animate": false,
  "maxFps": 20,
  "capacity": 1000,
  "mutationRate": 0.2,
  "zoom": 2,
  "waitingPulse": false,
  "matrix": { "color": "green", "zoom": 1, "speed": 10, "density": 3 }
}
```

`shell.defaultProfile` picks the shell a plain split runs: `gitBash` (the default), `pwsh`
(PowerShell 7), `powershell` (Windows PowerShell), or `cmd`. An unknown value falls back to
`gitBash` with a notice. A profile that is not installed falls back to the first available profile
in the order Git Bash, PowerShell 7, Windows PowerShell, Command Prompt, with a notice the first
time each missing shell is asked for. `shell.path` and `shell.args` configure Git Bash only. The
Default shell select in the Terminal section of the settings dialog sets it too (see
[PowerShell, Windows PowerShell, and Command Prompt](setup.md#powershell-windows-powershell-and-command-prompt)):

```jsonc
"shell": { "defaultProfile": "gitBash" }
```

Restore on relaunch is controlled by `restore.enabled` (reopen the saved terminals) and
`restore.resumeClaude` (type `claude --resume` into terminals that had a Claude session); both
default to `true`:

```jsonc
"restore": { "enabled": true, "resumeClaude": true }
```

`dashboard.side` (`"right"` by default, or `"left"`) docks the dashboard on that side of the
window; an unknown value falls back to `right` with a notice. `dashboard.sections` shows or hides
each dashboard element: `favorites`, `layouts`, `panes`, `containers`, and `external` default to
`true` and `system` and `clock` to `false` (so `dashboard.sections.system` starts off). A settings file that still has `containers.enabled` and no
`sections.containers` uses it for the Containers section. These only affect the dashboard; the
kind menu offers a Containers pane whenever a container engine is found. All of them apply on save and are in the Dashboard section of the settings dialog, the
elements under "Show on the dashboard".

`dashboard.clockStyle` picks what the clock shows: `"both"` (the default) for the binary dots and
the time, `"time"` for the time only, or `"binary"` for the dots only. An unknown value falls back
to `both` with a notice. It applies on save and is the Clock style select under "Show on the
dashboard", shown while the clock is on.

```jsonc
"dashboard": {
  "side": "right",
  "sections": {
    "favorites": true,
    "layouts": true,
    "panes": true,
    "containers": true,
    "external": true,
    "system": false,
    "clock": false
  },
  "clockStyle": "both"
}
```

`terminal.doneAfterSeconds` (default 30) is the shortest shell command that marks its terminal
`done` or `failed` when it finishes out of view; 0 turns the marks off. It applies to Git Bash with
the `~/.bashrc` lines only.

```jsonc
"terminal": { "doneAfterSeconds": 30 }
```

`git.autoFetchMinutes` (default 5, 0 to 1440) is the number of minutes between background fetches
of repos with an open Git pane; 0 turns them off. It applies on save and is also in the Git
section of the settings dialog.

```jsonc
"git": { "autoFetchMinutes": 5 }
```

Bashboard also keeps `favorites.json`, `layouts.json`, `repos.json`, and `workspace.json` next to
`settings.json`. Bashboard rewrites `workspace.json` itself (version 3, holding every tab);
`favorites.json`, `layouts.json`, and `repos.json` are plain JSON you can edit by hand, and the
panel updates when you save them.

The schema and the default keys are in [docs/design.md](design.md) sections 4.5 and 8.
