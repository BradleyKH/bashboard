# Shell and Claude Code setup

## New panes in the current folder

A new pane opens in the focused pane's working directory. Git Bash does not report its working
directory by default, so when Git Bash is the default shell, the setup wizard offers to add these
lines to `~/.bashrc`, in a block
marked `# >>> bashboard shell integration >>>` and `# <<< bashboard shell integration <<<` at the
end of the file, below any prompt framework's init line. It backs the file up to
`~/.bashrc.bashboard-backup` first, and creates `~/.bash_profile` when it is missing so login
shells read `~/.bashrc`. The Setup list in the Help tab (F1) shows whether each shell has the
current lines, with an Install or Update button that does the same. To add them yourself, put these lines at the end of `~/.bashrc` (below
a line such as `eval "$(starship init bash)"`):

```sh
PS0="${PS0-}"'\e]133;C\e\\'
__bashboard_prompt() {
  local status=$?
  printf '\e]133;D;%s\e\\' "$status"
  printf '\e]9;9;%s\e\\' "$(cygpath -w "$PWD")"
  return "$status"
}
PROMPT_COMMAND="__bashboard_prompt${PROMPT_COMMAND:+;$PROMPT_COMMAND}"
```

They add to `PS0` and `PROMPT_COMMAND` instead of replacing them, and hand the last command's
exit status on, so a prompt such as Starship keeps its own hooks and its error indicator.
Without them, new panes start in the home directory. Any shell that emits OSC 7 works too.
The OSC 133 markers (`PS0` and the first `printf`) tell the app exactly when a command starts
and finishes, which drives each terminal's working or idle status. In a pane without them, status follows a
check of the shell's processes every 2 seconds, so it can lag by up to that long.

## PowerShell, Windows PowerShell, and Command Prompt

Besides Git Bash, a pane can run PowerShell 7, Windows PowerShell, and Command Prompt. Each
is offered only when its program is installed, and Command Prompt is always available. PowerShell
7 (`pwsh.exe -NoLogo`) is found on `PATH` or at `%ProgramFiles%\PowerShell\7\pwsh.exe`. Windows
PowerShell (`powershell.exe -NoLogo`) is found at
`%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe`. Bashboard looks once per run, so
restart it after installing PowerShell 7. Set `shell.defaultProfile` to `gitBash`, `pwsh`,
`powershell`, or `cmd` to choose what a plain split runs, and press Alt+Shift+T to split with a
shell of your choice. A terminal's shell is saved with the workspace and restored on relaunch;
terminals not running Git Bash show a badge in the dashboard.

Command Prompt reports its folder automatically: Bashboard sets its `PROMPT` to emit the working
directory (OSC 9;9) ahead of your own `PROMPT`, so new panes open in the same folder. cmd cannot
emit the OSC 133 markers, so its working or idle status comes from the check of the shell's
processes every 2 seconds.

PowerShell 7 and Windows PowerShell do not report their folder until you tell them to. This follows Microsoft's
[Windows Terminal shell integration](https://learn.microsoft.com/en-us/windows/terminal/tutorials/shell-integration)
guidance for the working directory: the lines below wrap whatever `prompt` you already have and
emit the folder (OSC 9;9) ahead of it, so new panes open in the same folder. When PowerShell 7 or
Windows PowerShell is the default shell, the setup wizard offers to add them to that shell's
profile (`$PROFILE`; the two shells keep separate ones), in the same marked block as `~/.bashrc`,
after backing the file up to `<profile>.bashboard-backup`. To add them yourself, open the profile
with `notepad $PROFILE` and put them at the end, after any prompt framework's init line, such as
`oh-my-posh init`:

```powershell
if (-not (Test-Path variable:Global:__BashboardOriginalPrompt)) {
  $Global:__BashboardOriginalPrompt = $function:prompt
}

function Global:prompt {
  $exit = $global:LASTEXITCODE
  $loc = $executionContext.SessionState.Path.CurrentLocation
  $out = "$([char]27)]9;9;`"$loc`"$([char]7)" + (& $Global:__BashboardOriginalPrompt)
  $global:LASTEXITCODE = $exit   # keep the last native exit code visible to the user
  return $out
}
```

The lines work in both shells, and running `. $PROFILE` again does not wrap the prompt twice.
Windows PowerShell's default execution policy on Windows 11 is `Restricted`, which runs no profile
at all; the wizard warns when the policy blocks the profile, and
`Set-ExecutionPolicy -Scope CurrentUser RemoteSigned` lets it run.

The snippet deliberately leaves out the OSC 133 markers from Microsoft's example. Bashboard uses
the markers exclusively once a pane emits any of them, and PowerShell has no reliable hook for
the command-started marker (`C`), so a pane emitting only the others would show as idle while a
command runs. Like Command Prompt, a PowerShell pane's working or idle status comes from the
check of the shell's processes every 2 seconds.

## Claude Code hooks

Without hooks, Bashboard learns a Claude session's state from its session file. Hooks add what
the file cannot: a `waiting` status when Claude needs you, and exact transitions as they
happen. They map to status like this:

| Event | Effect |
| --- | --- |
| `SessionStart` | Binds the session to its pane |
| `UserPromptSubmit` | `busy` |
| `Notification` | `waiting` (permission prompt or idle prompt) |
| `Stop` | `idle`, shown as `done` until you focus that pane |
| `SessionEnd` | Unbinds the session |

Each pane's shell has `BASHBOARD_HOOK_URL`, `BASHBOARD_HOOK_TOKEN`, and `BASHBOARD_PANE_ID` set,
and the hook script posts the event to the app with the pane id, which binds the session to its
pane. The script does nothing outside a Bashboard pane, so the same global hooks are harmless
in Windows Terminal or VS Code.

Open the dashboard and click **Install Claude Code hooks**, use the Claude Code step of the
setup wizard, or click Install beside Claude Code hooks in the Setup list of the Help tab (F1). The install needs `bash.exe` on `PATH`
(Git for Windows) and refuses with an explanation without it. It shows the JSON it will add and
writes only after you confirm. It writes `~/.claude/hooks/bashboard-hook.sh` and appends one
group per event to `~/.claude/settings.json`; your existing hooks are left untouched, and an
event that already has the Bashboard hook is skipped. If `settings.json` has comments or other
non-JSON syntax, the install refuses and changes nothing. The button appears only when Claude Code
has run on this machine (`~/.claude` exists when Bashboard starts) and is hidden once everything
is installed. Claude sessions started after the install report `waiting`.

To add them by hand, copy `hooks/bashboard-hook.sh` to `~/.claude/hooks/` and add this group to
the `SessionStart`, `UserPromptSubmit`, `Notification`, `Stop`, and `SessionEnd` arrays under
`hooks` in `~/.claude/settings.json`:

```json
{ "hooks": [ { "type": "command", "command": "bash ~/.claude/hooks/bashboard-hook.sh", "timeout": 5 } ] }
```
