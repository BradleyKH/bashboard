---
name: bashboard
description: Use the bb CLI when running inside a Bashboard terminal pane. Covers checking CI status, waiting for CI after a push, reading why a pipeline or workflow failed, rerunning or canceling CI runs, and measuring how big the current branch is against its size threshold before committing, and opening Bashboard panes (files, git, search, scratch, terminal, ship, ports, containers, local browser). Trigger on questions about CI or build status, failing pipelines or checks, "wait for CI", committing, branch or PR size, whether to split a branch, or showing something in a pane.
bashboard-skill: true
---

# Bashboard `bb` CLI

`bb` drives the Bashboard pane it runs in. It only works inside a Bashboard pane, where
`BASHBOARD_HOOK_URL` is set. Outside one it fails, except `bb help`, `bb auth ...`, and
`bb skill install`, which also work in any terminal. If `BASHBOARD_HOOK_URL` is unset, do not
retry; tell the user `bb` is unavailable here.

## CI commands

`bb ci` works on GitHub, GitLab, Bitbucket, and Azure DevOps. It uses the repo of the current
folder and the current branch unless `--branch` says otherwise.

- `bb ci [status] [--branch B] [--json]`: prints the repo, branch, short SHA, one line per run
  (status, name, duration, link), and the PR line. Exit 0 unless the request fails (exit 1).
  `--branch` and `--json` work on every `bb ci` command, and `--flag=value` works too.
- `bb ci wait [--branch B] [--interval SECS] [--timeout DUR] [--json]`: polls status and prints
  one line per status change. `--interval` defaults to 30 seconds and is raised to 10 if lower;
  `--timeout` defaults to 30m and takes `90`, `90s`, `30m`, `1h`, or `1h30m`.
- `bb ci log [--run ID] [--job ID]`: without `--job`, prints a failure report (failed jobs, failed
  steps, links, and a log excerpt starting near the first real error) for `--run`, or for the
  newest failed run when `--run` is omitted; with no failed run it prints "No failed run on
  BRANCH." and exits 1. With `--job`, which needs `--run`, it prints that job's full log.
- `bb ci rerun [--failed] [--run ID]`: reruns a run, or only its failed jobs with `--failed`.
  Azure DevOps can only rerun failed jobs, so it needs `--failed`; Bitbucket cannot use it.
- `bb ci cancel [--run ID]`: cancels a run.
- `bb skill install`: writes this skill to `~/.claude/skills/bashboard/SKILL.md` under `HOME`
  (else `USERPROFILE`). It says "already up to date" when the file is identical, and refuses
  (exit 1) to replace a file whose front matter lacks `bashboard-skill: true`.

### `bb ci wait` exit codes

- 0: every run on the head SHA is final and none failed, or the PR merged.
- 1: a final run failed or was cancelled.
- 2: it gave up: the timeout passed, no run appeared on the head SHA within 5 minutes (the
  clock restarts if a push changes the head SHA), 8 consecutive reads failed (only an
  unreachable Bashboard or a host error counts), or the PR was closed without merging. It also
  exits 2 when the request itself is refused or invalid: bad arguments, not in a pane, a bad
  token, no live pane, or a 400 or 404 answer. The message on stderr says which.

Exit 2 means "unknown", not "failed". Report it as such; do not treat it as a CI failure. A run
that waits on a person (an approval) is not final, so `wait` keeps waiting for it.

### Workflow

1. After a push, run `bb ci wait`. Run it in the foreground or background as suits the task, and
   keep going with other work if it runs in the background. Do not poll `bb ci status` in a loop
   yourself; `wait` already does that.
2. On exit 0, report CI as green. On exit 2, say why it gave up and offer `bb ci status`.
3. On exit 1, run `bb ci log` and read the failure report before changing anything. Fix the
   cause the report shows, not the first symptom. If the excerpt is cut off or unclear, read the
   whole job with `bb ci log --run ID --job ID`. `bb ci status` prints no IDs (`--json` adds
   each run's `id`) and `bb` never lists job IDs, so use this only when you have a job ID, such
   as from a job link.
4. Commit and push the fix, then `bb ci wait` again.

Use `--json` when you need to parse the output; otherwise the plain output is easier to read.

### Rerun and cancel need permission

`bb ci rerun` and `bb ci cancel` change state on the remote host. They are refused unless the
user's `ship.cliWrites` setting is on, and the error names that setting. Run them only when the
user asks. If one is refused, tell the user about `ship.cliWrites` and stop; do not try to work
around it, and do not edit the user's settings yourself. Do not rerun a failure to see whether it
goes away without the user's say-so; read the log first.

## Branch size

`bb pr size [--json]` counts the lines and files the current branch changes against its
comparison ref (usually `origin/main`), including uncommitted and untracked work, leaving out
tests, lockfiles, and generated files. It prints one line with the count, the comparison ref, and the user's
`git.branchSizeThreshold`. Exit 0: at or under the threshold, the threshold is off (0), or there
is no comparison ref. Exit 1: over the threshold. Exit 2: the request failed (not in a pane, not
in a git repo); the message on stderr says why.

Run `bb pr size` before committing. On exit 1, tell the user the branch is over the threshold,
give the count, and propose how to split the work into smaller branches or PRs before you
continue; go on only once the user agrees to keep it whole or picks a split. Exit 2 is "unknown",
not "too big".

## Pane commands

These open or show a pane next to the one you are running in. Each prints little; the effect is
visible to the user. Relative paths resolve against the folder `bb` runs in.

- `bb open <path>`: show a folder in the Files pane, or a file's folder with it selected.
- `bb edit <path>[:<line>]`: open a file or folder in the user's preferred editor, optionally at
  a line.
- `bb git`: open the Git pane for this folder's repo.
- `bb search [<query>]`: open a Search pane, with the query filled in when given.
- `bb scratch [<text>]`: open a scratch pad with the text, or with piped standard input (up to 1
  MiB), e.g. `git diff | bb scratch`.
- `bb term [<folder>] [-- <command>]`: open a terminal here or in another folder. Words after
  `--` are typed into the new shell as one line followed by Enter, in that shell's syntax.
- `bb ship`: show this folder's repo in the Ship pane (the Overview outside a repo).
- `bb ports`, `bb containers`: show the Ports or Containers pane.
- `bb browse [<url>]`: open a Local Browser pane. Only localhost and 127.0.0.1 are allowed; a bare
  port such as `5173` works.
- `bb auth bitbucket` and `bb auth azure-devops <org>`: store a token for the Ship pane. They
  prompt the user with echo off, so leave these to the user.
- `bb help`: list the commands.

Two options go anywhere in a pane command: `--collapsed` opens the new pane collapsed, and
`--tab` (or `-t`) opens it alone in a new tab. They cannot be combined, and `bb ship`, `bb ports`,
and `bb containers` ignore `--collapsed`. `--` ends the options, so
`bb search -- --collapsed` searches for that text.

Use panes to show the user something worth looking at (a diff, a log excerpt, a dev server), not
for every command you run.
