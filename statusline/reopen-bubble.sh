#!/usr/bin/env bash
# Reopens a session's closed bubble from coding-buddy://reopen/<sid>: the status line shows it again
# and replays its move from the start.

source "$(dirname "${BASH_SOURCE[0]}")/../scripts/paths.sh"

# Any web page can open coding-buddy:// links, so nothing but a plain session id gets through.
[[ "${1:-}" =~ ^coding-buddy://reopen/([A-Za-z0-9_-]{1,64})$ ]] || exit 0
sid="${BASH_REMATCH[1]}"
# Read the way the status line reads it, so the gate names the same reaction; a missing file leaves it empty.
ts=$(jq -r '.timestamp // empty' "$BUDDY_STATE_DIR/reaction.$sid.json" 2>/dev/null)
[[ "$ts" =~ ^[0-9]+$ ]] || exit 0
gate="$BUDDY_STATE_DIR/.move_gate.$sid"
# The status line reads the gate on every tick, so it must never see a half-written file.
printf '%s\n%s\nopen\n' "$ts" "$(date +%s)" > "$gate.tmp.$$" && mv "$gate.tmp.$$" "$gate"
