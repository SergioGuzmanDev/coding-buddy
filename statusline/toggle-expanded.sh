#!/usr/bin/env bash
# Flips "expanded" in config.json; while it is on, the status line shows the full panel and bubble.

source "$(dirname "${BASH_SOURCE[0]}")/../scripts/paths.sh"

config="$BUDDY_STATE_DIR/config.json"
[ -f "$config" ] || printf '{}\n' > "$config"
# The status line reads config.json every second, so it must never see a half-written file.
tmp="$config.tmp.$$"
jq '.expanded = ((.expanded // false) | not)' "$config" > "$tmp" && mv "$tmp" "$config"
