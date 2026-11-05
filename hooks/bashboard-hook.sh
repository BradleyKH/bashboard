#!/usr/bin/env bash
# bashboard-hook-version: 1
# Bump the version above, and HOOK_VERSION in src-tauri/src/hook_install.rs, on every change:
# an app only replaces a script whose version is lower than its own.
# Forwards an agent hook event to Bashboard. Silent no-op outside a Bashboard pane.
# Usage: bashboard-hook.sh [agent]   (agent defaults to claude)
# Nothing may reach stdout: Codex's PermissionRequest and Copilot's permissionRequest
# read stdout as an allow or deny decision, and empty output leaves the normal prompt.
[ -n "$BASHBOARD_HOOK_URL" ] || exit 0
agent="${1:-claude}"
payload=$(cat)
if [ -n "$BASHBOARD_HOOK_LOG" ]; then
  printf -- '--- %s agent=%s\n%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$agent" "$payload" \
    >>"$BASHBOARD_HOOK_LOG" 2>/dev/null || true
fi
# Piped rather than --data-binary "$payload": curl would read a payload starting with @ as a file.
printf '%s' "$payload" | curl -s -m 1 -X POST \
  -H "X-Bashboard-Token: $BASHBOARD_HOOK_TOKEN" \
  -H "X-Bashboard-Pane: $BASHBOARD_PANE_ID" \
  -H "X-Bashboard-Agent: $agent" \
  --data-binary @- "$BASHBOARD_HOOK_URL/hook" >/dev/null 2>&1 || true
exit 0
