#!/usr/bin/env bash
set +e
SCRIPT_DIR="${BASH_SOURCE[0]%/*}"
ROOT="$(cd "$SCRIPT_DIR/.." 2>/dev/null && pwd)" || exit 0
[ -n "$ROOT" ] || exit 0
# shellcheck source=../scripts/paths.sh
source "$ROOT/scripts/paths.sh"
# This hook only writes canned reactions, and starting bun just to read that they are off holds up the turn.
_canned_off='"cannedReactions"[[:space:]]*:[[:space:]]*false'
IFS= read -r -d '' _config 2>/dev/null < "$BUDDY_STATE_DIR/config.json"
[[ "$_config" =~ $_canned_off ]] && exit 0
BUN="$(command -v bun 2>/dev/null || true)"
[ -x "$BUN" ] || BUN="$HOME/.bun/bin/bun"
[ -x "$BUN" ] || BUN="/opt/homebrew/bin/bun"
[ -x "$BUN" ] || BUN="/usr/local/bin/bun"
[ -x "$BUN" ] || exit 0
exec "$BUN" run "$ROOT/server/hooks/file-type-react.ts" || exit 0
