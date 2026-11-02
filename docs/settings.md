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

The background animation (the backdrop) starts frozen on a still frame; set `backdrop.animate`
to `true` to run it, at up to 20 frames per second. Raise or lower that with `backdrop.maxFps`
(0 for the display's refresh rate). Ctrl+Shift+D pauses or resumes the animation and saves the
choice to that setting. The simulation runs at 12 generations per second under a slow camera
orbit, held still while Windows animation effects are off. It is tuned with `capacity` (the
population it sustains, 300 to 5000; Density in the settings dialog), `mutationRate` (how far
offspring drift in color and strategy, 0 to 4; Color drift in the dialog), `zoom` (0.5 to 3;
above 1 brings the colony closer so it fills more of the window), and `waitingPulse` (a steady
brightness pulse on a waiting Claude session's organisms, off by default). All of these are also
in the Background Animation section of the settings dialog, along with Brightness and Blur, which
set the scrim behind terminals (Brightness is the inverse of `scrim.opacity`):

```jsonc
"backdrop": {
  "animate": false,
  "maxFps": 20,
  "capacity": 1000,
  "mutationRate": 0.2,
  "zoom": 2,
  "waitingPulse": false
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
  }
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
