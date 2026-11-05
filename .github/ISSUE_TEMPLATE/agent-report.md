---
name: Agent report
about: Codex, Copilot, or Local models behaving differently than the user guide describes (preview)
title: "[agent] "
labels: ""
---

Codex, Copilot, and Local models are a preview, so reports on how they behave on a real setup help
a great deal. Thank you for sending one.

## Agent and version

Which agent (Codex, Copilot, Claude Code) and its version (`codex --version`, `copilot --version`,
`claude --version`), plus your Bashboard version (Help tab, About).

## What happened

What you expected (a status, a model line, a resume) and what you saw instead.

## Hook payloads

Start Bashboard with `BASHBOARD_HOOK_LOG` set to a file path, reproduce the problem in a pane, and
paste the relevant entries from that file. Each entry begins with a timestamp and the agent's name.
Redact anything private first.

```
```

## Transcript lines

A few lines from the agent's session file around the problem (Codex keeps them under
`~/.codex/sessions`, Copilot under `~/.copilot/session-state`). Redact prompts, paths, and anything
else private before pasting.

```
```
