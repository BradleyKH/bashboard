# Open questions

Questions about Bashboard that need a decision before the right behavior is knowable. Bashboard has no client, so every question is internal.

## Client questions

_None (internal project)._

## Internal questions

| # | Question | Blocks now? | Owner | Status | Notes |
|---|----------|-------------|-------|--------|-------|
| 1 | Should the shell prompt hooks report the cloud context on every prompt instead of only when it changes, so the cloud chip is correct again after a nested shell exits? | No | Bradley | open | Emitting every prompt still forks nothing (printf is a builtin) but adds a few bytes of output per prompt. Evidence: src-tauri/src/shell_integration.rs BASH_SNIPPET; in a PowerShell pane set $env:AWS_PROFILE, run bash --norc, export AWS_PROFILE=dev, exit, and the chip still reads aws dev. |
