#!/usr/bin/env bash
# Forwards a Claude Code hook event to Bashboard. Silent no-op outside a Bashboard pane.
[ -n "$BASHBOARD_HOOK_URL" ] || exit 0
curl -s -m 1 -X POST \
  -H "X-Bashboard-Token: $BASHBOARD_HOOK_TOKEN" \
  -H "X-Bashboard-Pane: $BASHBOARD_PANE_ID" \
  --data-binary @- "$BASHBOARD_HOOK_URL/hook" >/dev/null 2>&1 || true
exit 0
