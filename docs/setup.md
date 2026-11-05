# Shell and coding agent setup

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

Hooks install per agent: each detected coding agent gets its own button in the dashboard footer
("Install <agent> hooks") and its own entry in the setup wizard's Coding agents step and the Setup
list. [Codex](#codex-hooks-preview) and [Copilot](#copilot-hooks-preview) are a preview; the rest
of this section describes Claude Code.

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

Open the dashboard and click **Install Claude Code hooks**, use the Coding agents step of the
setup wizard, or click Install beside Claude Code hooks in the Setup list of the Help tab (F1). The install needs `bash.exe` on `PATH`
(Git for Windows) and refuses with an explanation without it. It shows the JSON it will add and
writes only after you confirm. It writes `~/.claude/hooks/bashboard-hook.sh` and appends one
group per event to `~/.claude/settings.json`; your existing hooks are left untouched, and an
event that already has the Bashboard hook is skipped. If `settings.json` has comments or other
non-JSON syntax, the install refuses and changes nothing. The button appears only when Claude Code
has run on this machine (`~/.claude` exists when Bashboard starts) and is hidden once everything
is installed. Claude sessions started after the install report `waiting`.

The hook script carries a version line (`# bashboard-hook-version: N`). When the hooks are
registered but the installed script is older than the app's, or has no version line, the button
reads **Update Claude Code hooks** and the Setup list shows "Hook script out of date"; updating
rewrites only the script. A script from a newer Bashboard counts as installed and is never
replaced by an older one, and a hand-edited script at the app's version is left alone. The same
applies to the Codex and Copilot hooks below.

To add them by hand, copy `hooks/bashboard-hook.sh` to `~/.claude/hooks/` and add this group to
the `SessionStart`, `UserPromptSubmit`, `Notification`, `Stop`, and `SessionEnd` arrays under
`hooks` in `~/.claude/settings.json`:

```json
{ "hooks": [ { "type": "command", "command": "bash ~/.claude/hooks/bashboard-hook.sh", "timeout": 5 } ] }
```

## Agent hooks

Claude Code's hooks are described [above](#claude-code-hooks). Codex and Copilot use the same
hook script, `bashboard-hook.sh`, which takes the agent's name as its argument and does nothing
outside a Bashboard pane. Each install shows what it will write, and writes only after you confirm.
It needs `bash.exe` on `PATH` (Git for Windows). An agent's button appears only when its home
folder exists when Bashboard starts (for Copilot, once the CLI has run a session and created
`~/.copilot/session-state`), and is hidden once everything is installed.

### Codex hooks (preview)

The install writes the script to `~/.codex/hooks/bashboard-hook.sh` and merges one group per
event (`SessionStart`, `UserPromptSubmit`, `PermissionRequest`, `PostToolUse`, `Stop`,
`SessionEnd`, and `Interrupt`) into `~/.codex/hooks.json`, leaving your existing hooks untouched.
When `CODEX_HOME` is set, that folder is used instead of `~/.codex`.

Codex asks you to trust new hooks the next time it starts, and runs them only after you do. Until
then the Setup list shows "Installed, not yet trusted".

### Copilot hooks (preview)

The install writes the script to `~/.copilot/hooks/bashboard-hook.sh` and the whole of
`~/.copilot/hooks/bashboard.json`, a file Bashboard owns, for the events `SessionStart`,
`UserPromptSubmit`, `Notification`, `PostToolUse`, `Stop`, and `SessionEnd`. When `COPILOT_HOME` is
set, that folder is used instead of `~/.copilot`.

### Reporting a problem with an agent

Set `BASHBOARD_HOOK_LOG` to a file path in the environment Bashboard starts from, and the hook
script appends every raw payload it receives to that file, each under a line with a timestamp and
the agent's name. Attach a few of those entries, the agent's version, and a few lines of its
transcript (with anything private redacted) to an issue from the agent report template.

## Code hosts

The Ship pane shows a repo's pipeline runs, job logs, and open pull requests. It reads them from
the code host's API with a sign-in you already have, so each host needs a one-time setup. Bashboard
never runs a sign-in flow of its own and keeps tokens in memory only; the one thing it stores is a
Bitbucket API token, in Windows Credential Manager. Open the pane from any pane's kind menu (see
the [user guide](user-guide.md#ship-pane)); when something is missing, the pane shows the same
steps with buttons that do them.

The dialog's **Accounts** tab is the place to do the setup below. It has a card for each code
host showing where its token comes from (never the token itself), and buttons for signing in,
switching or removing an account, and adding, replacing, or removing a Bitbucket token. Open it
from the **Accounts** button in the Ship pane's bar, from a Ship notice's buttons, or from the
command palette ("Manage code host accounts"). Each step below also has a command that does the
same from a terminal.

### GitHub

Bashboard reads GitHub through the GitHub CLI, then falls back to Git Credential Manager's token.

1. Install the GitHub CLI. In the Accounts tab, the GitHub card's **Install GitHub CLI** runs
   `winget install --id GitHub.cli -e` in a terminal pane. You can run that command yourself, or use
   the installer from [cli.github.com](https://cli.github.com). Restart any terminals that were
   open, so they see it.
2. Sign in. In the Accounts tab, choose **Sign in** on the GitHub card; it closes the dialog and
   runs `gh auth login --hostname github.com --web` in a terminal pane, where you follow the
   prompts in your browser. From a terminal, run `gh auth login`, choose GitHub.com (or GitHub
   Enterprise Server), HTTPS, and sign in with a browser; for an Enterprise Server host, run
   `gh auth login --hostname <host>` instead.
3. Check. The card lists the signed-in accounts and the active one, and **Test** asks GitHub who
   the token belongs to and which scopes it has. From a terminal, run `gh auth status`.

A host you are signed in to with `gh` is recognized without any setting, and gets its own card in
the Accounts tab. A GitHub Enterprise Server host that `gh` is not signed in to needs an entry in
`ship.hosts` (see [Settings](settings.md#settings)); it then gets a card too.

**Several accounts.** Choose **Sign in another account** on the card, or run `gh auth login` again
for each account. **Make active** on an account's row does what `gh auth switch --hostname <host>
--user <user>` does, and **Sign out** (after a confirmation) does what `gh auth logout --hostname
<host> --user <user>` does; signing out removes the account from the GitHub CLI for every app that
uses it. The pane's bar then shows "as @name", and you pick the account a repo uses from that
button, whose menu also has **Manage accounts**. Or run
`git config credential.username <user>` in the repo, which is what the pick does. The same setting
stops Git Credential Manager asking which account to use on every push, so one choice serves both.
Without it the repo follows whichever account `gh auth switch` last chose, and the button is shown
in a warning color to say so.

**Environment tokens.** If `GH_TOKEN` or `GITHUB_TOKEN` is set in the environment Bashboard was
launched from (for an Enterprise Server host, `GH_ENTERPRISE_TOKEN` or `GITHUB_ENTERPRISE_TOKEN`),
`gh auth status` and `gh` in a terminal act as that token's account. The Ship pane still uses the
account **Make active** or `gh auth switch` chose, and **Make active** and **Sign out** on the
Accounts tab work as usual; the GitHub card notes which variable is set.

**Troubleshooting.**

- **"Single sign-on needs authorizing."** The organization requires SSO. Use **Authorize** in the
  pane, which opens GitHub's page for authorizing the token for that organization, then retry.
- **A repo shows "not found".** Under the wrong account, GitHub answers "not found" for a private
  repo. Pick the account that has access from the pane's account button.
- **"GitHub CLI isn't installed" right after installing it.** Bashboard looks in the CLI's install
  folders too, so the pane finds it, but a terminal that was open before the install does not have
  it on its `PATH`. Open a new pane.

### Bitbucket Cloud

Bitbucket has no official command line tool, and Git Credential Manager's Bitbucket sign-in cannot
read pipelines or pull requests, so Bashboard uses a Bitbucket API token. Only Bitbucket Cloud
(bitbucket.org) is supported; Bitbucket Data Center is not.

1. Open [id.atlassian.com/manage-profile/security/api-tokens](https://id.atlassian.com/manage-profile/security/api-tokens).
   You can also get there from Bitbucket: your profile picture, **Account settings**, the
   **Security** tab, then **Create and manage API tokens**.
2. Choose **Create API token with scopes**.
3. Name it "Bashboard" and set an expiry. Note the date, since the token stops working then. Choose
   **Next**.
4. Choose **Bitbucket** as the app, then **Next**.
5. Tick each scope in the table below, then **Next**.
6. Choose **Create token** and copy the token. It is shown once and cannot be read again.
7. In the Accounts tab, choose **Add token** on the Bitbucket card, paste the token into the
   field, and choose **Save**. The field hides what you type. Or, in a terminal, run
   `bb auth bitbucket` and paste the token when asked; the input is hidden there too.
8. Choose **Test** on the card to confirm Bitbucket accepts it; the result names the login, or the
   scope the token lacks.

| Scope | What it is for |
| --- | --- |
| `read:repository:bitbucket` | Find the repository |
| `read:pullrequest:bitbucket` | List pull requests |
| `read:pipeline:bitbucket` | List pipeline runs, steps, and logs |
| `write:pipeline:bitbucket` | Optional: re-run and stop pipelines |
| `read:user:bitbucket` | Tell which pull requests are yours or await your review |

Every scope but `write:pipeline:bitbucket` is required: without `read:user:bitbucket`, for example,
the pull request list reports the missing scope instead of loading. Without `write:pipeline:bitbucket`, Re-run and Cancel report that the token is missing it.
When a request needs a scope the token lacks, the pane's message names it: "This token is missing
the `<scope>` scope." Scopes cannot be added to an existing token, so make a new one with the full
list and store it with **Replace token** on the Bitbucket card (or `bb auth bitbucket`). A running
Bashboard picks the replacement up at once; no restart is needed.

**Where it goes.** The Accounts tab and `bb auth bitbucket` save the token in Windows Credential
Manager as the generic credential `bashboard:bitbucket.org`, for this machine only. Check it with
`cmdkey /list:bashboard:bitbucket.org`, and remove it with **Remove token** (after a confirmation)
or `bb auth bitbucket --clear`. The command works in any terminal, not only a Bashboard pane.
Bashboard reads the token from there and sends it to Bitbucket only. The Accounts tab never shows
the token again after you save it, and Bashboard writes it nowhere else; the field in the tab is
the one place a token is typed into the app, and it is emptied when you save, cancel, or close the
dialog.

**Renewing.** When the token expires, the pane says Bitbucket rejected it. Make a new one with the
steps above and choose **Replace token** on the card, or run `bb auth bitbucket` again; either
replaces the stored one.

**Rate limits.** Bitbucket allows 1,000 requests an hour per user, so Bashboard polls Bitbucket more
slowly than GitHub, and pull request checks are fetched again only when a pull request changes.
