#!/usr/bin/env bash
# Opens or closes a session's bubble from coding-buddy://reopen/<sid> or coding-buddy://close/<sid>. Reopening
# shows it again and replays its move from the start.

source "$(dirname "${BASH_SOURCE[0]}")/../scripts/paths.sh"

# Any web page can open coding-buddy:// links, so nothing but a plain session id gets through.
[[ "${1:-}" =~ ^coding-buddy://(reopen|close)/([A-Za-z0-9_-]{1,64})$ ]] || exit 0
action="${BASH_REMATCH[1]}"
sid="${BASH_REMATCH[2]}"
# Read the way the status line reads it, so the gate names the same reaction; a missing file leaves it empty.
ts=$(jq -r '.timestamp // empty' "$BUDDY_STATE_DIR/reaction.$sid.json" 2>/dev/null)
[[ "$ts" =~ ^[0-9]+$ ]] || exit 0
at=$(date +%s)
# A replay gives way to the moves that come up meanwhile, so the status line has to tell it from a first play.
state=replay
# A window that opened at the epoch ended long ago, so the status line draws the bubble closed.
[ "$action" = close ] && { at=0; state=open; }
gate="$BUDDY_STATE_DIR/.move_gate.$sid"
# The status line reads the gate on every tick, so it must never see a half-written file.
printf '%s\n%s\n%s\n' "$ts" "$at" "$state" > "$gate.tmp.$$" && mv "$gate.tmp.$$" "$gate"
