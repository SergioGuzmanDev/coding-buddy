#!/usr/bin/env bash
# coding-buddy status line — animated, right-aligned multi-line companion
#
# Art rendering: the server (writeStatusState in server/state.ts) pre-bakes
# every frame with eye, hat overlay, and blink resolved, and writes them into
# status.json along with the frame-index sequence. This script is a dumb
# cycler — one jq call per tick picks the current frame body.
#
# BUDDY_FAKE_NOW env var: override wall clock for snapshot tests.
#
# Uses Braille Blank (U+2800) for padding — survives JS .trim()
#
# When running inside buddy-shell (the PTY wrapper), skip status line rendering
# so the buddy doesn't show up twice (once in status line, once in wrapper panel).
# Bash treats COLUMNS as a special variable and may refresh it from a
# controlling PTY after startup. Snapshot the exported value before any
# sourced helper or external command can trigger that refresh.
_INHERITED_COLUMNS="${COLUMNS:-}"
_INHERITED_ROWS="${LINES:-}"
# Width math and substring slicing must agree on UTF-8 codepoints. Claude Code
# emits Unicode art even when a caller inherited the POSIX C locale.
_LOCALE_HINT="${LC_ALL:-${LC_CTYPE:-${LANG:-}}}"
case "$_LOCALE_HINT" in
    *UTF-8|*utf-8|*utf8|*UTF8) ;;
    *)
        _UTF8_LOCALE=""
        for _candidate in C.UTF-8 en_US.UTF-8; do
            if locale -a 2>/dev/null | grep -Fx "$_candidate" >/dev/null 2>&1; then
                _UTF8_LOCALE="$_candidate"
                break
            fi
        done
        [ -n "$_UTF8_LOCALE" ] && export LC_ALL="$_UTF8_LOCALE"
        ;;
esac

[ "$BUDDY_SHELL" = "1" ] && exit 0

# shellcheck source=../scripts/paths.sh
source "$(dirname "${BASH_SOURCE[0]}")/../scripts/paths.sh"
source "$(dirname "${BASH_SOURCE[0]}")/substatus.sh"

STATE="$BUDDY_STATE_DIR/status.json"
CONFIG_FILE="$BUDDY_STATE_DIR/config.json"
# Per-session ID resolved by paths.sh (CLAUDE_CODE_SESSION_ID > TMUX_PANE > default)
SID="$BUDDY_SID"
REACTION_FILE="$BUDDY_STATE_DIR/reaction.$SID.json"
BUDDY_STATUSLINE_INPUT=$(cat)

# Unfocused iTerm2 sessions under animate "focused" reprint their last render until their reaction or
# the config changes. Claude Code's input differs on every tick, so it cannot be part of that check.
RENDER_CACHE=""
if [ -n "${ITERM_SESSION_ID:-}" ] && [ -f "$BUDDY_STATE_DIR/focused-session" ] \
    && grep -q '"animate": *"focused"' "$CONFIG_FILE" 2>/dev/null; then
    _render_cache="$BUDDY_STATE_DIR/.render.$SID"
    if [ "$(cat "$BUDDY_STATE_DIR/focused-session")" = "${ITERM_SESSION_ID#*:}" ]; then
        # Reprinting a render from before this focus would undo everything shown while focused.
        [ -f "$_render_cache" ] && rm -f "$_render_cache"
    elif [ "$_render_cache" -nt "$CONFIG_FILE" ] && [ "$_render_cache" -nt "$REACTION_FILE" ]; then
        cat "$_render_cache"
        exit 0
    else
        RENDER_CACHE="$_render_cache"
    fi
fi

[ -f "$STATE" ] || exit 0

# Assigns the NUL-terminated values on stdin to the named variables; one jq per file instead of one
# per field, since every jq start costs more than the rest of a field's work.
read_fields() {
    local _field
    for _field in "$@"; do IFS= read -r -d '' "$_field"; done
}

# "absent" distinguishes a legacy status.json (no field at all) from an explicit
# 0, which means "no achievement pending" and must not render. Claude Code's input is read as one
# array so a malformed field there cannot shift the values after it.
# The level comes from xp.json because awarding XP rewrites only that file; the copy in status.json
# is as old as the last buddy tool call. It is read raw so a damaged xp.json cannot blank the buddy.
_xp_file="$BUDDY_STATE_DIR/xp.json"
[ -f "$_xp_file" ] || _xp_file=/dev/null
read_fields MUTED NAME RARITY STARS SHINY ACHIEVEMENT ACHIEVEMENT_AT LEVEL MOOD \
    TRANSCRIPT CONTEXT_PCT USAGE_5H_PCT < <(jq -j --arg input "$BUDDY_STATUSLINE_INPUT" --rawfile xp "$_xp_file" '
    def pct: if type == "number" then floor else 0 end;
    (.muted // false), (.name // ""), (.rarity // "common"), (.stars // ""), (.shiny // false),
    (.achievement // ""), (if has("achievementAt") then (.achievementAt // 0) else "absent" end),
    ((try ($xp | fromjson | .level) catch null) // .level // 1), (.mood // "focused"),
    (try ($input | fromjson | [(.transcript_path // ""), (.context_window.used_percentage | pct),
        (.rate_limits.five_hour.used_percentage | pct)]) catch ["", 0, 0])[]
    | tostring, "\u0000"' "$STATE" 2>/dev/null)
[ "$MUTED" = "true" ] && exit 0
[ -z "$NAME" ] && exit 0

# ─── Animation timing ───────────────────────────────────────────────────────
NOW=${BUDDY_FAKE_NOW:-$(date +%s)}
# The actual frame body is selected later once density/rows are known.

# ─── Rarity color (theme-aware) ─────────────────────────────────────────────
_THEME="dark"
if [ -f "$CONFIG_FILE" ]; then
    # try: a malformed rainbowColors must not blank every other setting read by the same jq.
    read_fields _cfg_theme _cfg_animate _color _bubble_color _cfg_hide_rarity _custom _cfg_inline _cfg_expanded \
        _cfg_click _ttl _bw _bm _wa _density < <(jq -j '
        (.theme // "auto"), (if .animate == null then "true" else (.animate | tostring) end),
        (.color // ""), (.bubbleColor // ""), (.showRarity == false), (try ((.rainbowColors // []) | @tsv) catch ""),
        (.subStatusInline // false), (.expanded // false), (.clickToExpand // false), (.reactionTTL // 900),
        (.bubbleWidth // 44), (.bubbleMargin // 8), (.statuslineWidthAdjust // 0), (.statuslineDensity // "auto")
        | tostring, "\u0000"' "$CONFIG_FILE" 2>/dev/null)
    [ "$_cfg_theme" = "light" ] && _THEME="light"
fi

NC=$'\033[0m'
NEUTRAL=$'\033[39m'
case "$RARITY" in
  common)
    [ "$_THEME" = "light" ] && C=$'\033[38;2;90;90;90m' || C=$'\033[38;2;153;153;153m' ;;
  uncommon)
    [ "$_THEME" = "light" ] && C=$'\033[38;2;22;115;55m' || C=$'\033[38;2;78;186;101m' ;;
  rare)
    [ "$_THEME" = "light" ] && C=$'\033[38;2;55;85;210m' || C=$'\033[38;2;177;185;249m' ;;
  epic)
    [ "$_THEME" = "light" ] && C=$'\033[38;2;110;55;200m' || C=$'\033[38;2;175;135;255m' ;;
  legendary)
    [ "$_THEME" = "light" ] && C=$'\033[38;2;180;120;0m' || C=$'\033[38;2;255;193;7m' ;;
  *)         C=$'\033[0m' ;;
esac

B=$'\xe2\xa0\x80'  # Braille Blank U+2800

# ─── Rainbow colors for shiny buddies ────────────────────────────────────────
# Default ROYGBIV palette; overridden by rainbowColors in config.json
_hex_to_ansi() {
    local hex="${1#\#}"
    printf '\033[38;2;%d;%d;%dm' "$(( 16#${hex:0:2} ))" "$(( 16#${hex:2:2} ))" "$(( 16#${hex:4:2} ))"
}

RAINBOW=(
  $'\033[38;2;255;50;50m'
  $'\033[38;2;255;140;0m'
  $'\033[38;2;255;220;0m'
  $'\033[38;2;50;210;50m'
  $'\033[38;2;50;120;255m'
  $'\033[38;2;100;50;220m'
  $'\033[38;2;180;50;220m'
)

ANIMATE=1
if [ -f "$CONFIG_FILE" ]; then
    # A clock-driven frame changes every session's status line in the same second; "focused" animates
    # only the iTerm2 session named in focused-session, written by scripts/macos/buddy_focus.py.
    case "$_cfg_animate" in
        false) ANIMATE=0 ;;
        focused)
            if [ -n "${ITERM_SESSION_ID:-}" ]; then
                _focused=$(cat "$BUDDY_STATE_DIR/focused-session" 2>/dev/null)
                [ "$_focused" = "${ITERM_SESSION_ID#*:}" ] || ANIMATE=0
            fi
            ;;
    esac
    [[ "$_color" =~ ^#?[0-9A-Fa-f]{6}$ ]] && C=$(_hex_to_ansi "$_color")
    [[ "$_bubble_color" =~ ^#?[0-9A-Fa-f]{6}$ ]] && BC=$(_hex_to_ansi "$_bubble_color")
    # "// true" would turn an explicit false into true.
    [ "$_cfg_hide_rarity" = "true" ] && STARS=""
    if [ -n "$_custom" ]; then
        RAINBOW=()
        for _hex in $_custom; do
            RAINBOW+=("$(_hex_to_ansi "$_hex")")
        done
    fi
fi

COLOR_ENABLED=1
[ -n "${NO_COLOR:-}" ] && COLOR_ENABLED=0

RAINBOW_LEN=${#RAINBOW[@]}
RAINBOW_OFFSET=$(( ANIMATE ? NOW % RAINBOW_LEN : 0 ))

_is_positive_int() {
    case "$1" in
        ''|*[!0-9]*) return 1 ;;
    esac
    [ "$1" -gt 0 ] 2>/dev/null && return 0
    return 1
}

# ─── Terminal size (rows + columns from the same stty size probe) ─────────────
COLS=0
ROWS=0

# Claude Code renders this command inside a content box, not across the full
# terminal. Reserve two columns for settings.json padding (1 per side) and
# twelve for Claude Code's internal left/right content margins. The 14-column
# reserve is calibrated against the reported ~74-column content box; the
# regression fixture is rendered at 60, 80, and 120 columns to assert the
# resulting budget before output.
CHROME_RESERVE=14
STATUSLINE_WIDTH_ADJUST=0

ROWS=0
COLS=0

# Rows/cols resolution precedence (real use):
#   1. BUDDY_STATUSLINE_ROWS / BUDDY_STATUSLINE_COLS (validated positive ints)
#   2. exported LINES / COLUMNS (validated positive ints)
#   3. Linux: /proc/$PID/fd/0 PTY via stty size (captures both values)
#   4. macOS: ps + stty on /dev/$TTY_NAME (captures both values)
#   5. Windows: PowerShell (Get-Host).UI.RawUI.WindowSize.Height/Width
#   6. final defaults: ROWS 999 (full), COLS 125
if _is_positive_int "${BUDDY_STATUSLINE_ROWS:-}"; then
    ROWS=$((10#${BUDDY_STATUSLINE_ROWS}))
elif _is_positive_int "$_INHERITED_ROWS"; then
    ROWS=$((10#$_INHERITED_ROWS))
fi

if _is_positive_int "${BUDDY_STATUSLINE_COLS:-}"; then
    COLS=$((10#${BUDDY_STATUSLINE_COLS}))
elif _is_positive_int "$_INHERITED_COLUMNS"; then
    COLS=$((10#$_INHERITED_COLUMNS))
fi

# If either dimension is still unknown, walk the process tree and read the
# PTY dimensions once. stty size returns "rows cols"; parse both from the same
# probe so rows and cols are consistent and no extra detection pass is needed.
if [ "$ROWS" -lt 1 ] 2>/dev/null || [ "$COLS" -lt 1 ] 2>/dev/null; then
    PID=$$
    for _ in 1 2 3 4 5; do
        PID=$(ps -o ppid= -p "$PID" 2>/dev/null | tr -d ' ')
        [ -z "$PID" ] || [ "$PID" = "1" ] && break

        # Linux: read PTY device from /proc
        PTY=$(readlink "/proc/${PID}/fd/0" 2>/dev/null)
        if [ -c "$PTY" ] 2>/dev/null; then
            _stty=$(stty size < "$PTY" 2>/dev/null)
            if [ -n "$_stty" ]; then
                _rows=${_stty%% *}
                _cols=${_stty##* }
                [ "$ROWS" -lt 1 ] 2>/dev/null && _is_positive_int "$_rows" && ROWS=$((10#$_rows))
                [ "$COLS" -lt 1 ] 2>/dev/null && _is_positive_int "$_cols" && COLS=$((10#$_cols))
                [ "$ROWS" -gt 0 ] 2>/dev/null && [ "$COLS" -gt 0 ] 2>/dev/null && break
            fi
        fi

        # macOS: /proc doesn't exist — get TTY name from process table
        TTY_NAME=$(ps -o tty= -p "$PID" 2>/dev/null | tr -d ' ')
        if [ -n "$TTY_NAME" ] && [ "$TTY_NAME" != "??" ] && [ "$TTY_NAME" != "?" ]; then
            TTY_DEV="/dev/$TTY_NAME"
            if [ -c "$TTY_DEV" ] 2>/dev/null; then
                _stty=$(stty size < "$TTY_DEV" 2>/dev/null)
                if [ -n "$_stty" ]; then
                    _rows=${_stty%% *}
                    _cols=${_stty##* }
                    [ "$ROWS" -lt 1 ] 2>/dev/null && _is_positive_int "$_rows" && ROWS=$((10#$_rows))
                    [ "$COLS" -lt 1 ] 2>/dev/null && _is_positive_int "$_cols" && COLS=$((10#$_cols))
                    [ "$ROWS" -gt 0 ] 2>/dev/null && [ "$COLS" -gt 0 ] 2>/dev/null && break
                fi
            fi
        fi
    done
fi

[ "${COLS:-0}" -lt 1 ] 2>/dev/null && COLS=0
# Windows: /proc and TTY device detection don't exist; use PowerShell as fallback
if [ "${COLS:-0}" -lt 1 ] 2>/dev/null; then
    _ps_cols=$(powershell.exe -NoProfile -Command "(Get-Host).UI.RawUI.WindowSize.Width" 2>/dev/null | tr -d '\r\n')
    if _is_positive_int "$_ps_cols"; then
        [ "$_ps_cols" -gt 40 ] 2>/dev/null && COLS=$((10#$_ps_cols))
    fi
fi
if [ "${ROWS:-0}" -lt 1 ] 2>/dev/null; then
    _ps_rows=$(powershell.exe -NoProfile -Command "(Get-Host).UI.RawUI.WindowSize.Height" 2>/dev/null | tr -d '\r\n')
    _is_positive_int "$_ps_rows" && ROWS=$((10#$_ps_rows))
fi

[ "${COLS:-0}" -lt 1 ] 2>/dev/null && COLS=125
[ "${ROWS:-0}" -lt 1 ] 2>/dev/null && ROWS=999

COLS=$((10#$COLS))
DETECTED_COLS="$COLS"
DETECTED_ROWS="$ROWS"

# ─── Reaction bubble (with TTL check) ────────────────────────────────────────
# The achievement banner is resolved further down, once REACTION_TTL is known —
# it expires on the same clock as a reaction. Without that it latches into the
# shared status.json and pins every session's bubble to the last trophy.
BUBBLE=""
REACTION_TTL=900
INNER_W=44
MARGIN=8
DENSITY="auto"
SUBSTATUS_INLINE=0
EXPANDED=0
CLICK_TO_EXPAND=0
if [ -f "$CONFIG_FILE" ]; then
    [ "$_cfg_inline" = "true" ] && SUBSTATUS_INLINE=1
    [ "$_cfg_expanded" = "true" ] && EXPANDED=1
    [ "$_cfg_click" = "true" ] && CLICK_TO_EXPAND=1
    case "$_ttl" in ''|*[!0-9]*) ;; *) REACTION_TTL="$_ttl" ;; esac
    case "$_bw" in ''|*[!0-9]*) ;; *) INNER_W="$_bw" ;; esac
    case "$_bm" in ''|*[!0-9]*) ;; *) MARGIN="$_bm" ;; esac
    if [[ "$_wa" =~ ^[+-]?[0-9]+$ ]]; then
        case "$_wa" in
            +*) STATUSLINE_WIDTH_ADJUST=$((10#${_wa#+})) ;;
            -*) STATUSLINE_WIDTH_ADJUST=$((-10#${_wa#-})) ;;
            *)  STATUSLINE_WIDTH_ADJUST=$((10#$_wa)) ;;
        esac
    fi
    case "$_density" in
        auto|full|compact|minimal) DENSITY="$_density" ;;
        *) DENSITY="auto" ;;
    esac
fi
# ─── Statusline density tier ─────────────────────────────────────────────────
# Explicit config/env density overrides pin the tier; otherwise rows drive it:
#   full >= 40, compact 20-39, minimal < 20. Very narrow terminals also force minimal.
if [ -n "${BUDDY_STATUSLINE_DENSITY:-}" ]; then
    DENSITY="${BUDDY_STATUSLINE_DENSITY}"
fi
case "$DENSITY" in
    full|compact|minimal) TIER="$DENSITY" ;;
    *)
        TIER="full"
        if [ "$DETECTED_ROWS" -lt 40 ] 2>/dev/null; then
            TIER="compact"
        fi
        if [ "$DETECTED_ROWS" -lt 20 ] 2>/dev/null; then
            TIER="minimal"
        fi
        if [ "$DETECTED_COLS" -lt 40 ] 2>/dev/null; then
            TIER="minimal"
        fi
        ;;
esac
[ "$EXPANDED" -eq 1 ] && TIER="full"

_sweep_expired_reactions() {
    [ "$REACTION_TTL" -gt 0 ] 2>/dev/null || return 0
    local now cutoff_ms cutoff_seconds file ts
    now=$(date +%s)
    cutoff_ms=$(( (now - REACTION_TTL) * 1000 ))
    cutoff_seconds=$(( now - REACTION_TTL ))

    for file in "$BUDDY_STATE_DIR"/reaction.*.json; do
        [ -f "$file" ] || continue
        ts=$(jq -r '.timestamp // 0' "$file" 2>/dev/null || echo 0)
        case "$ts" in
            ''|*[!0-9]*) rm -f "$file" 2>/dev/null ;;
            *) [ "$ts" -le "$cutoff_ms" ] 2>/dev/null && rm -f "$file" 2>/dev/null ;;
        esac
    done

    for file in "$BUDDY_STATE_DIR"/.last_comment.*; do
        [ -f "$file" ] || continue
        ts=$(cat "$file" 2>/dev/null)
        case "$ts" in
            ''|*[!0-9]*) rm -f "$file" 2>/dev/null ;;
            *) [ "$ts" -le "$cutoff_seconds" ] 2>/dev/null && rm -f "$file" 2>/dev/null ;;
        esac
    done
}

_sweep_expired_reactions

# Achievement banner: shown only while fresh. ACHIEVEMENT_AT is epoch ms, written
# alongside the name by writeStatusState. A legacy status.json without the field
# (pre-upgrade, or a snapshot fixture) is treated as fresh — the next write from
# the server backfills it.
#
# Validity and age are separate gates on purpose. A zeroed or malformed
# achievementAt means "nothing pending" and must never render, including under
# reactionTTL=0 — that opt-out disables *expiry*, not the field's meaning.
if [ -n "$ACHIEVEMENT" ] && [ "$ACHIEVEMENT" != "null" ]; then
    ACH_FRESH=1
    if [ "$ACHIEVEMENT_AT" != "absent" ]; then
        case "$ACHIEVEMENT_AT" in
            ''|0|*[!0-9]*) ACH_FRESH=0 ;;
            *)
                if [ "$REACTION_TTL" -gt 0 ] 2>/dev/null; then
                    ACH_AGE=$(( ($(date +%s) * 1000 - ACHIEVEMENT_AT) / 1000 ))
                    [ "$ACH_AGE" -ge "$REACTION_TTL" ] && ACH_FRESH=0
                fi
                ;;
        esac
    fi
    [ "$ACH_FRESH" -eq 1 ] && BUBBLE=$'\xf0\x9f\x8f\x86'" $ACHIEVEMENT"
fi

REACTION=""
REACTION_MOVE=""
REACTION_MOOD=""
[ -f "$REACTION_FILE" ] && read_fields REACTION TS REACTION_MOVE REACTION_MOOD < <(jq -j '
    (.reaction // ""), (.timestamp // 0), (.move // ""), (.mood // "") | tostring, "\u0000"' "$REACTION_FILE" 2>/dev/null)
if [ -n "$REACTION" ] && [ "$REACTION" != "null" ] && [ "$REACTION" != "" ]; then
    FRESH=0
    if [ "$REACTION_TTL" -eq 0 ]; then
        FRESH=1
    elif [ -f "$REACTION_FILE" ]; then
        if [ "$TS" != "0" ]; then
            NOW=$(date +%s)
            AGE=$(( (NOW * 1000 - TS) / 1000 ))
            [ "$AGE" -lt "$REACTION_TTL" ] && FRESH=1
        fi
    fi
    if [ "$FRESH" -eq 1 ]; then
        if [ -n "$BUBBLE" ]; then
            BUBBLE="$BUBBLE | \"${REACTION}\""
        else
            BUBBLE="\"${REACTION}\""
        fi
    else
        rm -f "$REACTION_FILE" 2>/dev/null
    fi
fi

# ─── Animation: pick current density frame from server-rendered frames ───────
NOW=${BUDDY_FAKE_NOW:-$(date +%s)}
SWEAT_AT_CONTEXT_PCT=40
TIRED_AT_5H_PCT=50
ASLEEP_AFTER_IDLE_SECONDS=300
REACTION_MOVE_SECONDS=30
SWEAT=false
[ "$CONTEXT_PCT" -ge "$SWEAT_AT_CONTEXT_PCT" ] 2>/dev/null && SWEAT=true
TIRED=false
[ "$USAGE_5H_PCT" -ge "$TIRED_AT_5H_PCT" ] 2>/dev/null && TIRED=true
# gemini-react reads this at the end of a turn so its reaction matches how the buddy is drawn.
_signals="sweat=$SWEAT tired=$TIRED"
_old_signals=""
[ -f "$BUDDY_STATE_DIR/.signals.$SID" ] && IFS= read -r _old_signals < "$BUDDY_STATE_DIR/.signals.$SID"
[ "$_signals" = "$_old_signals" ] || printf '%s\n' "$_signals" > "$BUDDY_STATE_DIR/.signals.$SID"
# The transcript grows with every message and tool call, so its age is how long the conversation has been quiet.
MOVE=pool
if [ -f "$TRANSCRIPT" ] && [ $(( NOW - $(_substatus_mtime "$TRANSCRIPT") )) -ge "$ASLEEP_AFTER_IDLE_SECONDS" ]; then
    MOVE=idle
elif [ "$TIRED" = true ]; then
    MOVE=tired
fi
# A frozen status line would keep the move's first frame, so only an animated one acts it out.
SINCE_REACTION=-1
case "$TS" in
    ''|*[!0-9]*) ;;
    *) [ "$ANIMATE" -eq 1 ] && [ -n "$REACTION_MOVE$REACTION_MOOD" ] && [ $(( NOW - TS / 1000 )) -lt "$REACTION_MOVE_SECONDS" ] \
        && SINCE_REACTION=$(( NOW - TS / 1000 )) ;;
esac
FRAME_OUT=$(jq -r --argjson now "$(( ANIMATE ? NOW : 0 ))" --arg tier "$TIER" --arg move "$MOVE" \
    --argjson sweat "$SWEAT" --arg reaction_move "$REACTION_MOVE" --arg reaction_mood "$REACTION_MOOD" \
    --argjson since_reaction "$SINCE_REACTION" '
    def at($sequence): $sequence[$now % ($sequence | length)];
    (if $sweat then (.sweat // {}) else {} end) as $sweat_set
    | (if $tier == "compact" then ($sweat_set.compactFrames // .compactFrames? // .frames)
     elif $tier == "minimal" then ($sweat_set.minimalFrames // .minimalFrames? // .frames)
     else ($sweat_set.frames // .frames) end) as $set
    | (if $since_reaction >= 0 and (.moveSequences[$reaction_move] | length) > 0
           then .moveSequences[$reaction_move][$since_reaction % (.moveSequences[$reaction_move] | length)]
       elif $move == "idle" and (.idleSequence | length) > 0 then at(.idleSequence)
       elif $move == "tired" and (.tiredSequence | length) > 0 then at(.tiredSequence)
       else at(.frameSequence) end) as $idx
    | ((.moodColors[$reaction_mood] // []) as $mood
       | if $since_reaction >= 0 and ($mood | length) > 0 then $mood[($since_reaction / 2 | floor) % ($mood | length)] else "" end) as $mood_color
    | ((($set[0] // .frames[0] // "") | split("\n")[0] | test("^\\s*$")) | if . then "trim" else "keep" end)
      + " " + $mood_color + "\n" + (($set[$idx] // .frames[$idx]) // "")
' "$STATE" 2>/dev/null)
_frame_head="${FRAME_OUT%%$'\n'*}"
TOP_LINE_MODE="${_frame_head%% *}"
MOOD_COLOR="${_frame_head#* }"
FRAME_BODY="${FRAME_OUT#*$'\n'}"
[ "$FRAME_BODY" = "$FRAME_OUT" ] && FRAME_BODY=""

# Fallback when status.json lacks .frames — e.g. server/bash version skew
# during install or while the MCP server hasn't rewritten the file yet. Keep
# the buddy visible in a degraded form instead of emitting an empty block.
if [ -z "$FRAME_BODY" ]; then
    FRAME_BODY=$'            \n    (°°)    \n    (  )    \n            \n            '
fi

ART_LINES=()
while IFS= read -r line; do
    ART_LINES+=("$line")
done <<< "$FRAME_BODY"
# A blank top line in the resting frame is headroom for a hat; dropping it in every frame keeps the
# panel one row shorter at a fixed height, at the cost of art drawn there only mid-animation.
if [ "$TOP_LINE_MODE" = "trim" ] && [ "$TIER" != "minimal" ] && [ "${#ART_LINES[@]}" -gt 1 ]; then
    ART_LINES=("${ART_LINES[@]:1}")
fi

# ─── Build all art lines ──────────────────────────────────────────────────────
# ART_LINES comes from the pre-rendered frame (already includes hat + blink).
# Center the name under the art. Frames are 12 cols wide (see server/art.ts),
# so the geometric center sits at col 6.
NAME_WITH_LEVEL="$NAME"
[ "$LEVEL" -gt 1 ] 2>/dev/null && NAME_WITH_LEVEL="${NAME} [L${LEVEL}]"
[ -n "$STARS" ] && NAME_WITH_LEVEL="${NAME_WITH_LEVEL} ${STARS}"
case "$MOOD" in
    happy)       MOOD_EMOJI="" ;;
    focused)     MOOD_EMOJI="" ;;
    excited)     MOOD_EMOJI="" ;;
    tired)       MOOD_EMOJI="" ;;
    melancholy)  MOOD_EMOJI="" ;;
    chaotic)     MOOD_EMOJI="" ;;
    *)           MOOD_EMOJI="" ;;
esac
NAME_WITH_LEVEL="${NAME_WITH_LEVEL}${MOOD_EMOJI}"
NAME_LEN=${#NAME_WITH_LEVEL}
ART_CENTER=6
NAME_PAD=$(( ART_CENTER - NAME_LEN / 2 ))
[ "$NAME_PAD" -lt 0 ] && NAME_PAD=0
NAME_LINE="$(printf '%*s%s' "$NAME_PAD" '' "$NAME_WITH_LEVEL")"

BC="${BC:-$C}"
# The mood repaints the buddy only; the bubble keeps its color so the reaction stays readable.
[[ "$MOOD_COLOR" =~ ^#[0-9A-Fa-f]{6}$ ]] && C=$(_hex_to_ansi "$MOOD_COLOR")
# Italic only: faint on top of italic made the bubble text hard to read.
ITALIC=$'\033[3m'
if [ "$COLOR_ENABLED" -eq 0 ]; then
    C=""
    BC=""
    NC=""
    NEUTRAL=""
    ITALIC=""
    for _rainbow_index in "${!RAINBOW[@]}"; do
        RAINBOW[$_rainbow_index]=""
    done
fi

ALL_LINES=()
ALL_COLORS=()
_arc=0
for line in "${ART_LINES[@]}"; do
    ALL_LINES+=("$line")
    if [ "$SHINY" = "true" ] && [ -z "$MOOD_COLOR" ]; then
        ALL_COLORS+=("${RAINBOW[$(( (_arc + RAINBOW_OFFSET) % RAINBOW_LEN ))]}")
    else
        ALL_COLORS+=("$C")
    fi
    _arc=$(( _arc + 1 ))
done
ALL_LINES+=("$NAME_LINE"); ALL_COLORS+=("$C")

ART_COUNT=${#ALL_LINES[@]}

# ─── Speech bubble (left of art, word-wrapped) ──────────────────────────────
# Strip the quotes we added earlier
BUBBLE_TEXT=""
if [ -n "$BUBBLE" ]; then
    BUBBLE_TEXT="${BUBBLE%\"}"
    BUBBLE_TEXT="${BUBBLE_TEXT#\"}"
fi

# ─── Display width (emojis count as 2 cols) ──────────────────────────────────
# iconv turns the string into a stream of UTF-32LE codepoints, then awk sums
# widths. Rules mirror server/art.ts:displayWidth; the generated data lists
# every Unicode Emoji_Presentation codepoint, while VS16 upgrades a previous
# narrow emoji to 2 cols (e.g. ❤ + VS16).
EMOJI_WIDTHS_DATA="$(dirname "${BASH_SOURCE[0]}")/emoji-widths.data"
EMOJI_PRES_2600="$(grep -v '^#' "$EMOJI_WIDTHS_DATA" 2>/dev/null | tr -d '\n')"
EMOJI_TEXT_DATA="$(dirname "${BASH_SOURCE[0]}")/emoji-text.data"
EMOJI_TEXT="$(grep -v '^#' "$EMOJI_TEXT_DATA" 2>/dev/null | tr -d '\n')"

dwidth() {
    printf '%s' "$1" | iconv -f UTF-8 -t UTF-32LE 2>/dev/null | od -An -tu4 -v | awk -v pres="$EMOJI_PRES_2600" -v text="$EMOJI_TEXT" '
    function load_ranges(value, target,    n, i, count, piece, bounds, start, end, cp) {
        n = split(value, ranges, ",")
        for (i = 1; i <= n; i++) {
            count = split(ranges[i], bounds, "-")
            start = bounds[1] + 0
            end = (count == 2) ? bounds[2] + 0 : start
            for (cp = start; cp <= end; cp++) target[cp] = 1
        }
    }
    BEGIN {
        load_ranges(pres, wide)
        load_ranges(text, text_default)
    }
    # Precondition: cp is neither a variation selector (65024-65039) nor ZWJ
    # (8205); the main loop filters those before calling in.
    function char_width(cp) {
        if (cp in wide) return 2
        if (cp >= 9472 && cp <= 9631) return 1
        if (cp >= 12288 && cp <= 40959) return 2
        if (cp >= 65281 && cp <= 65376) return 2
        return 1
    }
    { for (i = 1; i <= NF; i++) {
        cp = $i + 0
        if (cp == 65039) {
            if (upgradable) { w += 1; upgradable = 0 }
            continue
        }
        if ((cp >= 65024 && cp <= 65038) || cp == 8205) { upgradable = 0; continue }
        cw = char_width(cp)
        w += cw
        upgradable = 0
        if (cw == 1 && (cp in text_default)) upgradable = 1
    } }
    END { print w+0 }'
}
# Prints the total display width, then one width per UTF-8 codepoint, on one line. ANSI-aware
# truncation uses this profile to make one Unicode-width pass over the complete output row.
dwidth_profile() {
    printf '%s' "$1" | iconv -f UTF-8 -t UTF-32LE 2>/dev/null | od -An -tu4 -v | awk -v pres="$EMOJI_PRES_2600" -v text="$EMOJI_TEXT" '
    function load_ranges(value, target,    n, i, count, piece, bounds, start, end, cp) {
        n = split(value, ranges, ",")
        for (i = 1; i <= n; i++) {
            count = split(ranges[i], bounds, "-")
            start = bounds[1] + 0
            end = (count == 2) ? bounds[2] + 0 : start
            for (cp = start; cp <= end; cp++) target[cp] = 1
        }
    }
    BEGIN {
        load_ranges(pres, wide)
        load_ranges(text, text_default)
    }
    function char_width(cp) {
        if (cp in wide) return 2
        if (cp >= 9472 && cp <= 9631) return 1
        if (cp >= 12288 && cp <= 40959) return 2
        if (cp >= 65281 && cp <= 65376) return 2
        return 1
    }
    {
        for (j = 1; j <= NF; j++) {
            cp = $j + 0
            idx++
            if (cp == 65039) {
                if (upgradable && idx > 1) widths[idx - 1] += 1
                widths[idx] = 0
                upgradable = 0
                continue
            }
            if ((cp >= 65024 && cp <= 65038) || cp == 8205) {
                widths[idx] = 0
                upgradable = 0
                continue
            }
            cw = char_width(cp)
            widths[idx] = cw
            upgradable = 0
            if (cw == 1 && (cp in text_default)) upgradable = 1
        }
    }
    END {
        line = ""
        for (j = 1; j <= idx; j++) { total += widths[j]; line = line " " (widths[j] + 0) }
        print (total + 0) line
    }'
}
ART_W=0
for line in "${ART_LINES[@]}"; do
    line_w=$(dwidth "$line")
    [ "$line_w" -gt "$ART_W" ] && ART_W="$line_w"
done

# Keep the label inside the same sprite column as the art. The exact Unicode
# width rules live in dwidth(), so the shell and TS renderers agree on bounds.
LABEL_W=$(dwidth "$NAME_WITH_LEVEL")
if [ "$LABEL_W" -gt "$ART_W" ] 2>/dev/null; then
    ART_W="$LABEL_W"
    NAME_PAD=$(( (ART_W - LABEL_W) / 2 ))
    NAME_LINE="$(printf '%*s%s' "$NAME_PAD" '' "$NAME_WITH_LEVEL")"
    ALL_LINES[$(( ART_COUNT - 1 ))]="$NAME_LINE"
fi
NAME_LINE_W=$(dwidth "$NAME_LINE")
# Centering the name against a short fixture frame can make the label wider
# than every art row; include that width before sizing the card.
[ "$NAME_LINE_W" -gt "$ART_W" ] && ART_W="$NAME_LINE_W"

STATUSLINE_BUDGET=$(( DETECTED_COLS - CHROME_RESERVE + STATUSLINE_WIDTH_ADJUST ))
# Preserve the existing compact-card behavior at the smallest supported
# terminal size; the reserve applies once there is enough room for chrome.
if [ "$DETECTED_COLS" -ge 40 ] 2>/dev/null && [ "$STATUSLINE_BUDGET" -lt 40 ]; then
    STATUSLINE_BUDGET=40
fi
[ "$STATUSLINE_BUDGET" -gt "$DETECTED_COLS" ] && STATUSLINE_BUDGET="$DETECTED_COLS"

# The sprite and its identifying name are the irreducible minimum of the card.
# Never let the chrome reserve push the usable budget below the sprite's own
# width; if it does, fall back to the raw terminal width. If the terminal
# itself is narrower than the sprite, use the historical default rather than
# slicing art or name.
if [ "$STATUSLINE_BUDGET" -lt "$ART_W" ]; then
    STATUSLINE_BUDGET="$DETECTED_COLS"
fi
if [ "$STATUSLINE_BUDGET" -lt "$ART_W" ]; then
    STATUSLINE_BUDGET=125
fi
COLS="$STATUSLINE_BUDGET"

# ─── Density branch: compact drops the bubble; minimal is a single line. ─────
if [ "$TIER" = "minimal" ]; then
    _face_plain="${ART_LINES[0]:-}"
    if [ -z "$_face_plain" ]; then
        for _fline in "${ART_LINES[@]}"; do
            [ -n "$_fline" ] && _face_plain="$_fline" && break
        done
    fi
    [ -z "$_face_plain" ] && _face_plain=$'    (°°)    '
    _min_plain="${_face_plain} ${NAME_WITH_LEVEL}"
    _min_w=$(dwidth "$_min_plain")
    if [ -n "$REACTION" ]; then
        _react_plain=" │ \"${REACTION}\""
        _react_w=$(dwidth "$_react_plain")
        if [ $((_min_w + _react_w)) -le "$STATUSLINE_BUDGET" ]; then
            _min_plain="${_min_plain}${_react_plain}"
            _min_w=$(dwidth "$_min_plain")
        fi
    fi
    if [ "$STATUSLINE_BUDGET" -lt "$_min_w" ]; then
        STATUSLINE_BUDGET="$DETECTED_COLS"
    fi
    # Never widen past the real terminal: a hard-coded fallback here would
    # defeat ansi_truncate below and emit rows wider than the pane, wrapping
    # and clobbering the prompt on genuinely narrow terminals.
    if [ "$STATUSLINE_BUDGET" -lt "$_min_w" ]; then
        STATUSLINE_BUDGET="$DETECTED_COLS"
    fi
    COLS="$STATUSLINE_BUDGET"
    ART_LINES=("$_min_plain")
    ALL_COLORS=("$C")
    ALL_LINES=("$_min_plain")
    ART_COUNT=1
    ART_W="$_min_w"
    BUBBLE=""
    BUBBLE_TEXT=""
elif [ "$TIER" = "compact" ]; then
    BUBBLE=""
    BUBBLE_TEXT=""
fi

# The bubble, tail, and sprite are one unit. At narrow widths, drop the
# bubble rather than allowing a partial border or tail to escape the panel.
MIN_BUBBLE_INNER=12
TAIL_W=3
MAX_INNER=$(( COLS - ART_W - TAIL_W - 4 - MARGIN ))
if [ -n "$BUBBLE" ] && [ "$MAX_INNER" -ge "$MIN_BUBBLE_INNER" ] 2>/dev/null; then
    [ "$INNER_W" -gt "$MAX_INNER" ] && INNER_W="$MAX_INNER"
else
    BUBBLE=""
    BUBBLE_TEXT=""
fi

# ─── Word-wrap bubble text ────────────────────────────────────────────────────
TEXT_LINES=()
if [ -n "$BUBBLE_TEXT" ]; then
    read -r -a WORDS <<< "$BUBBLE_TEXT"
    CUR_LINE=""
    CUR_W=0
    for word in "${WORDS[@]}"; do
        word_w=$(dwidth "$word")
        if [ -z "$CUR_LINE" ]; then
            CUR_LINE="$word"; CUR_W=$word_w
        elif [ $(( CUR_W + 1 + word_w )) -le $INNER_W ]; then
            CUR_LINE="$CUR_LINE $word"; CUR_W=$(( CUR_W + 1 + word_w ))
        else
            TEXT_LINES+=("$CUR_LINE")
            CUR_LINE="$word"; CUR_W=$word_w
        fi
    done
    [ -n "$CUR_LINE" ] && TEXT_LINES+=("$CUR_LINE")
fi

TEXT_COUNT=${#TEXT_LINES[@]}

# Build box as plain strings (no ANSI). Color applied at output time.
# Box display width = INNER_W + 4:  "| " + text(INNER_W) + " |"
BOX_W=$(( INNER_W + 4 ))
BUBBLE_LINES=()
BUBBLE_TYPES=()  # "border" or "text" — determines coloring
if [ $TEXT_COUNT -gt 0 ]; then
    # Top border
    BORDER=$(printf '%*s' "$(( BOX_W - 2 ))" '' | tr ' ' '-')
    BUBBLE_LINES+=(".${BORDER}.")
    BUBBLE_TYPES+=("border")
    # Text rows: "| text padded |"
    for tl in "${TEXT_LINES[@]}"; do
        tpad=$(( INNER_W - $(dwidth "$tl") ))
        [ "$tpad" -lt 0 ] && tpad=0
        padding=$(printf '%*s' "$tpad" '')
        BUBBLE_LINES+=("| ${tl}${padding} |")
        BUBBLE_TYPES+=("text")
    done
    # Bottom border
    BUBBLE_LINES+=("\`${BORDER}'")
    BUBBLE_TYPES+=("border")
fi

BUBBLE_COUNT=${#BUBBLE_LINES[@]}

# ─── Right-align with bubble box to the left ─────────────────────────────────
GAP=3
if [ $BUBBLE_COUNT -gt 0 ]; then
    TOTAL_W=$(( BOX_W + GAP + ART_W ))
else
    TOTAL_W=$ART_W
fi
# COLS already includes the Claude Code chrome reserve. The spacer starts with
# one Braille Blank cell, so account for that cell but don't subtract MARGIN
# again; doing so leaves the card visibly short of the pane's right edge.
PAD=$(( COLS - TOTAL_W - 1 ))
[ "$PAD" -lt 0 ] && PAD=0

# On Windows (Git Bash / MSYS2), Braille Blank (U+2800) renders as double-width,
# which doubles the spacer and pushes content off-screen. Use regular spaces instead.
case "$(uname -s)" in
    MINGW*|CYGWIN*|MSYS*) SPACER=$(printf '%*s' "$PAD" '') ;;
    *)                     SPACER=$(printf "${B}%${PAD}s" "") ;;
esac

# Minimal tier uses plain spaces so the one-line sprite + name fits without
# sacrificing a Braille Blank column on narrow terminals.
if [ "$TIER" = "minimal" ]; then
    PAD=$(( COLS - ART_W ))
    [ "$PAD" -lt 0 ] && PAD=0
    SPACER=$(printf '%*s' "$PAD" '')
fi

# Vertically center bubble box on the art
BUBBLE_START=0
if [ $BUBBLE_COUNT -gt 0 ] && [ $BUBBLE_COUNT -lt $ART_COUNT ]; then
    BUBBLE_START=$(( (ART_COUNT - BUBBLE_COUNT) / 2 ))
fi

# An inline sub-status shares the name row, so the name must be the last row with
# no bubble beside it: the art drops below a bubble taller than the art above the name.
ART_START=0
if [ "$TIER" != "minimal" ] && [ "$SUBSTATUS_INLINE" -eq 1 ]; then
    _body=$(( ART_COUNT - 1 ))
    if [ "$BUBBLE_COUNT" -gt "$_body" ]; then
        ART_START=$(( BUBBLE_COUNT - _body ))
        BUBBLE_START=0
    else
        BUBBLE_START=$(( (_body - BUBBLE_COUNT) / 2 ))
    fi
fi

# ─── Find the connector line (middle text line → points to buddy's mouth) ─────
# The connector goes on the middle text row of the bubble
CONNECTOR_BI=-1
if [ $BUBBLE_COUNT -gt 2 ]; then
    # text rows are indices 1..(BUBBLE_COUNT-2), pick the middle one
    FIRST_TEXT=1
    LAST_TEXT=$(( BUBBLE_COUNT - 2 ))
    CONNECTOR_BI=$(( (FIRST_TEXT + LAST_TEXT) / 2 ))
fi

# ─── Output: merged bubble box + art per line ──────────────────────────────────
TOTAL_BUBBLE=$(( BUBBLE_START + BUBBLE_COUNT ))
TOTAL_ART=$(( ART_START + ART_COUNT ))
MAX_LINES=$(( TOTAL_ART > TOTAL_BUBBLE ? TOTAL_ART : TOTAL_BUBBLE ))
OUTPUT_LINES=()
for (( i=0; i<MAX_LINES; i++ )); do
    # Art part: actual art line or blank filler
    ai=$(( i - ART_START ))
    if [ $ai -ge 0 ] && [ $ai -lt $ART_COUNT ]; then
        art_part="${ALL_COLORS[$ai]}${ALL_LINES[$ai]}${NC}"
    else
        art_part=$(printf '%*s' "$ART_W" '')
    fi

    if [ $BUBBLE_COUNT -gt 0 ]; then
        bi=$(( i - BUBBLE_START ))
        if [ $bi -ge 0 ] && [ $bi -lt $BUBBLE_COUNT ]; then
            bline="${BUBBLE_LINES[$bi]}"
            btype="${BUBBLE_TYPES[$bi]}"

            # Connector: "-- " on the middle text line, spaces otherwise.
            if [ $bi -eq $CONNECTOR_BI ]; then
                gap="${BC}--${NC} "
            else
                gap="   "
            fi

            if [ "$btype" = "border" ]; then
                OUTPUT_LINES+=("${SPACER}${BC}${bline}${NC}${gap}${art_part}")
            else
                pipe_l="${bline:0:1}"
                pipe_r="${bline: -1}"
                inner="${bline:1:$(( ${#bline} - 2 ))}"
                OUTPUT_LINES+=("${SPACER}${BC}${pipe_l}${ITALIC}${inner}${NC}${BC}${pipe_r}${NC}${gap}${art_part}")
            fi
        else
            empty=$(printf '%*s' "$BOX_W" '')
            OUTPUT_LINES+=("${SPACER}${empty}   ${art_part}")
        fi
    else
        OUTPUT_LINES+=("${SPACER}${art_part}")
    fi
done

# Sets ANSI_SEQ_END past the escape sequence at index $2. An OSC (hyperlink)
# ends at ST or BEL, never at an "m": its URL can contain one.
ansi_seq_end() {
    local text="$1" len=${#1} i=$(( $2 + 1 )) char
    if [ "${text:$i:1}" = "]" ]; then
        while [ "$i" -lt "$len" ]; do
            char="${text:$i:1}"
            if [ "$char" = $'\a' ]; then ANSI_SEQ_END=$(( i + 1 )); return; fi
            if [ "$char" = $'\033' ] && [ "${text:$(( i + 1 )):1}" = "\\" ]; then ANSI_SEQ_END=$(( i + 2 )); return; fi
            i=$(( i + 1 ))
        done
        ANSI_SEQ_END=$len
        return
    fi
    while [ "$i" -lt "$len" ]; do
        char="${text:$i:1}"
        i=$(( i + 1 ))
        [ "$char" = "m" ] && break
    done
    ANSI_SEQ_END=$i
}

# Sets ANSI_PLAIN to $1 without escape sequences, with the same ends as ansi_seq_end. It jumps from
# escape to escape: bash finds the Nth character of a UTF-8 string by walking from its start.
ansi_strip() {
    local rest="$1" st=$'\033\\' to_bel to_st
    ANSI_PLAIN=""
    while [[ "$rest" == *$'\033'* ]]; do
        ANSI_PLAIN="${ANSI_PLAIN}${rest%%$'\033'*}"
        rest="${rest#*$'\033'}"
        if [ "${rest:0:1}" = "]" ]; then
            to_bel="${rest%%$'\a'*}"
            to_st="${rest%%"$st"*}"
            if [ "${#to_bel}" -lt "${#to_st}" ]; then
                rest="${rest:$(( ${#to_bel} + 1 ))}"
            elif [ "$to_st" != "$rest" ]; then
                rest="${rest:$(( ${#to_st} + 2 ))}"
            else
                rest=""
            fi
        else
            case "$rest" in *m*) rest="${rest#*m}" ;; *) rest="" ;; esac
        fi
    done
    ANSI_PLAIN="${ANSI_PLAIN}${rest}"
}

ansi_truncate() {
    local text="$1"
    local max_width="$2"
    local out=""
    local plain=""
    local i=0
    local text_len=${#text}
    local char seq char_width truncated=0 saw_sgr=0 link_open=0
    local visible_width=0
    local -a widths profile
    local visible_index=0

    [ "$max_width" -lt 0 ] && max_width=0

    # Strip SGR while building the one string sent to dwidth_profile. The
    # profile uses one iconv/od/awk pass for the whole row; never spawn a
    # subprocess for each Unicode character.
    ansi_strip "$text"
    plain="$ANSI_PLAIN"
    [ "$plain" != "$text" ] && saw_sgr=1

    profile=(0)
    [ -n "$plain" ] && read -r -a profile < <(dwidth_profile "$plain")
    widths=("${profile[@]:1}")
    # A row that fits comes out unchanged, so skip the per-character walk. A profile that does not
    # cover every character (iconv refused the text) falls through to the walk's 1-column default.
    if [ "${#widths[@]}" -eq "${#plain}" ] && [ "${profile[0]}" -le "$max_width" ]; then
        printf '%s' "$text"
        return
    fi

    i=0
    while [ "$i" -lt "$text_len" ]; do
        char="${text:$i:1}"
        if [ "$char" = $'\033' ]; then
            ansi_seq_end "$text" "$i"
            seq="${text:$i:$(( ANSI_SEQ_END - i ))}"
            case "$seq" in
                $'\033]8;'*";"$'\033\\'|$'\033]8;'*";"$'\a') link_open=0 ;;
                $'\033]8;'*) link_open=1 ;;
            esac
            out="${out}${seq}"
            i=$ANSI_SEQ_END
            continue
        fi

        char_width="${widths[$visible_index]:-1}"
        if [ $(( visible_width + char_width )) -gt "$max_width" ]; then
            truncated=1
            break
        fi
        out="${out}${char}"
        visible_width=$(( visible_width + char_width ))
        visible_index=$(( visible_index + 1 ))
        i=$(( i + 1 ))
    done

    [ "$truncated" -eq 1 ] && [ "$link_open" -eq 1 ] && out="${out}"$'\033]8;;\033\\'
    [ "$truncated" -eq 1 ] && [ "$saw_sgr" -eq 1 ] && out="${out}${NC}"
    printf '%s' "$out"
}

statusline_output_line() {
    ansi_truncate "$1" "$STATUSLINE_BUDGET"
    printf '\n'
}

# Sets SUBSTATUS_LEFT and its width from a one-line sub-status cache; fails otherwise.
read_single_substatus() {
    local cache="$BUDDY_STATE_DIR/.substatus.$SID"
    [ -f "$cache" ] && [ "$(wc -l < "$cache")" -le 1 ] || return 1
    IFS= read -r SUBSTATUS_LEFT < "$cache" || [ -n "$SUBSTATUS_LEFT" ] || return 1
    ansi_strip "$SUBSTATUS_LEFT"
    SUBSTATUS_LEFT_W=$(dwidth "$ANSI_PLAIN")
}

# Puts the buddy at the right end of the cached one-line sub-status, trimming the
# reaction to the room left. Prints nothing when even the face and name do not fit.
inline_substatus_row() {
    local buddy buddy_w room text_room text reaction_part=""
    read_single_substatus || return 0
    local left="$SUBSTATUS_LEFT"
    room=$(( STATUSLINE_BUDGET - SUBSTATUS_LEFT_W - 2 ))
    buddy="${_face_plain} ${NAME_WITH_LEVEL}"
    buddy_w=$(dwidth "$buddy")
    [ "$buddy_w" -le "$room" ] || return 0
    text_room=$(( room - buddy_w - 5 ))
    if [ -n "$REACTION" ] && [ "$text_room" -ge 8 ]; then
        text="$REACTION"
        [ "$(dwidth "$text")" -le "$text_room" ] || text="$(ansi_truncate "$text" $(( text_room - 1 )))…"
        reaction_part=" │ \"${text}\""
        buddy_w=$(dwidth "${buddy}${reaction_part}")
    fi
    printf '%s%*s%s%s%s%s%s' "$left" $(( room - buddy_w + 2 )) '' "$C" "$buddy" "$BC" "$reaction_part" "$NC"
}

# Keeps the name in its column of the panel's last row, with the sub-status on its left.
inline_name_row() {
    read_single_substatus || return 0
    local pad=$(( COLS - ART_W - SUBSTATUS_LEFT_W ))
    [ "$pad" -ge 2 ] || return 0
    printf '%s%*s%s' "$SUBSTATUS_LEFT" "$pad" '' "${ALL_COLORS[$(( ART_COUNT - 1 ))]}${ALL_LINES[$(( ART_COUNT - 1 ))]}${NC}"
}

if [ "$SUBSTATUS_INLINE" -eq 1 ]; then
    if [ "$TIER" = "minimal" ]; then
        INLINE_ROW=$(inline_substatus_row)
    else
        INLINE_ROW=$(inline_name_row)
    fi
    if [ -n "$INLINE_ROW" ]; then
        OUTPUT_LINES[$(( ${#OUTPUT_LINES[@]} - 1 ))]="$INLINE_ROW"
        SUBSTATUS_PRINTED=1
    fi
fi

# cmd+click on the name opens coding-buddy://toggle, which the URL handler from
# scripts/macos/install-click-toggle.sh routes to toggle-expanded.sh.
if [ "$CLICK_TO_EXPAND" -eq 1 ]; then
    _name_link=$'\033]8;;coding-buddy://toggle\033\\'"${NAME_WITH_LEVEL}"$'\033]8;;\033\\'
    for _i in "${!OUTPUT_LINES[@]}"; do
        _row="${OUTPUT_LINES[$_i]}"
        case "$_row" in
            *"$NAME_WITH_LEVEL"*)
                OUTPUT_LINES[$_i]="${_row%%"$NAME_WITH_LEVEL"*}${_name_link}${_row#*"$NAME_WITH_LEVEL"}" ;;
        esac
    done
fi

render_output() {
    for line in "${OUTPUT_LINES[@]}"; do
        statusline_output_line "$line"
    done

    # Append the last cached sub-status result below the buddy panel and refresh
    # it asynchronously when stale. The statusline itself never waits on it.
    append_substatus
}

if [ -n "$RENDER_CACHE" ]; then
    RENDERED=$(render_output)
    printf '%s\n' "$RENDERED"
    printf '%s\n' "$RENDERED" > "$RENDER_CACHE.tmp.$$" && mv "$RENDER_CACHE.tmp.$$" "$RENDER_CACHE"
else
    render_output
fi

exit 0
