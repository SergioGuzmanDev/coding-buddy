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

_HERE="${BASH_SOURCE[0]%/*}"
[ "$_HERE" = "${BASH_SOURCE[0]}" ] && _HERE=.
# shellcheck source=../scripts/paths.sh
source "$_HERE/../scripts/paths.sh"
source "$_HERE/substatus.sh"

STATE="$BUDDY_STATE_DIR/status.json"
CONFIG_FILE="$BUDDY_STATE_DIR/config.json"
# Per-session ID resolved by paths.sh (CLAUDE_CODE_SESSION_ID > TMUX_PANE > default)
SID="$BUDDY_SID"
REACTION_FILE="$BUDDY_STATE_DIR/reaction.$SID.json"
IFS= read -r -d '' BUDDY_STATUSLINE_INPUT
BUDDY_STATUSLINE_INPUT="${BUDDY_STATUSLINE_INPUT%$'\n'}"

# Unfocused iTerm2 sessions under animate "focused" reprint their last render until their reaction or
# the config changes. Claude Code's input differs on every tick, so it cannot be part of that check.
RENDER_CACHE=""
_config_text=""
_focused=""
[ -f "$CONFIG_FILE" ] && IFS= read -r -d '' _config_text < "$CONFIG_FILE"
[ -f "$BUDDY_STATE_DIR/focused-session" ] && IFS= read -r _focused < "$BUDDY_STATE_DIR/focused-session"
_animate_focused_re='"animate": *"focused"'
if [ -n "${ITERM_SESSION_ID:-}" ] && [ -f "$BUDDY_STATE_DIR/focused-session" ] \
    && [[ "$_config_text" =~ $_animate_focused_re ]]; then
    _render_cache="$BUDDY_STATE_DIR/.render.$SID"
    if [ "$_focused" = "${ITERM_SESSION_ID#*:}" ]; then
        # Reprinting a render from before this focus would undo everything shown while focused.
        [ -f "$_render_cache" ] && rm -f "$_render_cache"
    elif [ "$_render_cache" -nt "$CONFIG_FILE" ] && [ "$_render_cache" -nt "$REACTION_FILE" ] \
        && [ "$_render_cache" -nt "$BUDDY_STATE_DIR/.move_gate.$SID" ]; then
        IFS= read -r -d '' _rendered < "$_render_cache"
        printf '%s' "$_rendered"
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
# The same jq reads config.json and this session's reaction, each parsed on its own so a damaged one
# only falls back to its defaults; try keeps a malformed rainbowColors from blanking the other settings.
_xp_file="$BUDDY_STATE_DIR/xp.json"
[ -f "$_xp_file" ] || _xp_file=/dev/null
_config_path="$CONFIG_FILE"
[ -f "$_config_path" ] || _config_path=/dev/null
_reaction_path="$REACTION_FILE"
[ -f "$_reaction_path" ] || _reaction_path=/dev/null
read_fields EPOCH_NOW MUTED NAME RARITY STARS SHINY ACHIEVEMENT ACHIEVEMENT_AT LEVEL MOOD \
    TRANSCRIPT CONTEXT_PCT USAGE_5H_PCT \
    _cfg_theme _cfg_animate _color _bubble_color _cfg_hide_rarity _custom _cfg_inline _cfg_expanded \
    _cfg_click _ttl _bw _bm _wa _density _cfg_slim SUBSTATUS_COMMAND SUBSTATUS_REFRESH_SECONDS \
    REACTION TS REACTION_MOVE REACTION_MOOD < <(jq -j --arg input "$BUDDY_STATUSLINE_INPUT" --rawfile xp "$_xp_file" \
        --rawfile config "$_config_path" --rawfile reaction "$_reaction_path" '
    def pct: if type == "number" then floor else 0 end;
    def object($raw): (try ($raw | fromjson) catch null) | if type == "object" then . else null end;
    object($config) as $c | object($reaction) as $r
    | (now | floor), (.muted // false), (.name // ""), (.rarity // "common"), (.stars // ""), (.shiny // false),
    (.achievement // ""), (if has("achievementAt") then (.achievementAt // 0) else "absent" end),
    ((try ($xp | fromjson | .level) catch null) // .level // 1), (.mood // "focused"),
    (try ($input | fromjson | [(.transcript_path // ""), (.context_window.used_percentage | pct),
        (.rate_limits.five_hour.used_percentage | pct)]) catch ["", 0, 0])[],
    ($c.theme // "auto"), (if $c.animate == null then "true" else ($c.animate | tostring) end),
    ($c.color // ""), ($c.bubbleColor // ""), ($c.showRarity == false), (try (($c.rainbowColors // []) | @tsv) catch ""),
    ($c.subStatusInline // false), ($c.expanded // false), ($c.clickToExpand // false), ($c.reactionTTL // 900),
    ($c.bubbleWidth // 44), ($c.bubbleMargin // 8), ($c.statuslineWidthAdjust // 0), ($c.statuslineDensity // "auto"),
    ($c.slim // false), ($c.subStatusCommand // ""), ($c.subStatusRefreshSeconds // ""),
    ($r.reaction // ""), ($r.timestamp // 0), ($r.move // ""), ($r.mood // "")
    | tostring, "\u0000"' "$STATE" 2>/dev/null)
[ "$MUTED" = "true" ] && exit 0
[ -z "$NAME" ] && exit 0

# ─── Animation timing ───────────────────────────────────────────────────────
# EPOCH_NOW comes from the jq above, so no date runs: real-time checks (expiry, freshness) use it, the
# animation uses NOW.
NOW=${BUDDY_FAKE_NOW:-$EPOCH_NOW}
# The actual frame body is selected later once density/rows are known.

# ─── Rarity color (theme-aware) ─────────────────────────────────────────────
_THEME="dark"
if [ -f "$CONFIG_FILE" ]; then
    SUBSTATUS_SETTINGS_READ=1
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
# Sets the variable named $1 to the truecolor escape for the #RRGGBB in $2.
_hex_to_ansi() {
    local hex="${2#\#}"
    printf -v "$1" '\033[38;2;%d;%d;%dm' "$(( 16#${hex:0:2} ))" "$(( 16#${hex:2:2} ))" "$(( 16#${hex:4:2} ))"
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
                [ "$_focused" = "${ITERM_SESSION_ID#*:}" ] || ANIMATE=0
            fi
            ;;
    esac
    [[ "$_color" =~ ^#?[0-9A-Fa-f]{6}$ ]] && _hex_to_ansi C "$_color"
    [[ "$_bubble_color" =~ ^#?[0-9A-Fa-f]{6}$ ]] && _hex_to_ansi BC "$_bubble_color"
    # "// true" would turn an explicit false into true.
    [ "$_cfg_hide_rarity" = "true" ] && STARS=""
    if [ -n "$_custom" ]; then
        RAINBOW=()
        for _hex in $_custom; do
            _hex_to_ansi _rainbow_color "$_hex"
            RAINBOW+=("$_rainbow_color")
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
SLIM=""
if [ -f "$CONFIG_FILE" ]; then
    [ "$_cfg_inline" = "true" ] && SUBSTATUS_INLINE=1
    [ "$_cfg_expanded" = "true" ] && EXPANDED=1
    [ "$_cfg_click" = "true" ] && CLICK_TO_EXPAND=1
    case "$_cfg_slim" in tight|bubble) SLIM="$_cfg_slim" ;; esac
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

# A week, as long as sweepStaleSessionFiles in server/hooks/buddy-comment.ts waits before calling a session gone.
GONE_SESSION_SECONDS=604800

_sweep_expired_reactions() {
    [ "$REACTION_TTL" -gt 0 ] 2>/dev/null || return 0
    local cutoff_seconds=$(( EPOCH_NOW - REACTION_TTL ))
    local cutoff_ms=$(( cutoff_seconds * 1000 )) file ts content timestamp_re='"timestamp":[[:space:]]*([0-9]+)'
    # Under "focused" a closed bubble stays reopenable past the TTL, and an unfocused tab renders nothing
    # new that would tell a live session from a gone one.
    [ "$_cfg_animate" = focused ] && [ "$GONE_SESSION_SECONDS" -gt "$REACTION_TTL" ] \
        && cutoff_ms=$(( (EPOCH_NOW - GONE_SESSION_SECONDS) * 1000 ))

    # Builtins only: this runs every tick over every session's files.
    for file in "$BUDDY_STATE_DIR"/reaction.*.json; do
        [ -f "$file" ] || continue
        content=""
        IFS= read -r -d '' content < "$file"
        ts=0
        [[ "$content" =~ $timestamp_re ]] && ts="${BASH_REMATCH[1]}"
        [ "$ts" -le "$cutoff_ms" ] 2>/dev/null && rm -f "$file" 2>/dev/null
    done

    for file in "$BUDDY_STATE_DIR"/.last_comment.*; do
        [ -f "$file" ] || continue
        ts=""
        IFS= read -r ts < "$file"
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
                    ACH_AGE=$(( (EPOCH_NOW * 1000 - ACHIEVEMENT_AT) / 1000 ))
                    [ "$ACH_AGE" -ge "$REACTION_TTL" ] && ACH_FRESH=0
                fi
                ;;
        esac
    fi
    [ "$ACH_FRESH" -eq 1 ] && BUBBLE=$'\xf0\x9f\x8f\x86'" $ACHIEVEMENT"
fi

REACTION_MOVE_SECONDS=30
MOVE_AFTER_FOCUS_SECONDS=3
BUBBLE_FOCUSED_SECONDS=15
# Under animate "focused" in iTerm2 a reaction waits to be looked at: its bubble, move and mood last
# BUBBLE_FOCUSED_SECONDS from 3 s of focus, then the bubble closes, reopenable until the next reaction.
GATED=0
[ "$_cfg_animate" = focused ] && [ -n "${ITERM_SESSION_ID:-}" ] && [ -f "$BUDDY_STATE_DIR/focused-session" ] \
    && [ -n "$REACTION" ] && [ "$REACTION" != "null" ] && [[ "$TS" =~ ^[0-9]+$ ]] && GATED=1

# Sets _move_from to when the reaction's bubble, move and mood started counting BUBBLE_FOCUSED_SECONDS,
# or -1 while it waits for MOVE_AFTER_FOCUS_SECONDS of focus. The gate file holds the reaction, the second
# it counts from (focus start while waiting, window start once open) and the state; bubble-click.sh
# writes it open. focused-session is rewritten on every focus change, so a copy newer than the gate file
# means focus went away since the gate last recorded where it started. Only a focused session advances it.
_reaction_gate() {
    local gate_file="$BUDDY_STATE_DIR/.move_gate.$SID" focus_file="$BUDDY_STATE_DIR/focused-session"
    local gate_ts="" gate_at="" gate_state="" since at state=wait
    [ -f "$gate_file" ] && { IFS= read -r gate_ts; IFS= read -r gate_at; IFS= read -r gate_state; } < "$gate_file"
    case "$gate_at" in ''|*[!0-9]*) gate_ts="" ;; esac
    _move_from=-1
    if [ "$gate_ts" = "$TS" ] && { [ "$gate_state" = open ] || [ "$gate_state" = replay ]; }; then
        _move_from=$gate_at
        [ "$gate_state" = replay ] && REPLAY=true
        return
    fi
    [ "$ANIMATE" -eq 1 ] || return 0
    if [ "$gate_ts" = "$TS" ] && ! [ "$focus_file" -nt "$gate_file" ]; then
        since=$gate_at
    elif [ "$focus_file" -nt "$REACTION_FILE" ]; then
        since=$NOW
    else
        since=$(( TS / 1000 ))
    fi
    at=$since
    if [ $(( NOW - since )) -ge "$MOVE_AFTER_FOCUS_SECONDS" ]; then
        state=open
        at=$(( since + MOVE_AFTER_FOCUS_SECONDS ))
        _move_from=$at
    fi
    [ "$gate_ts $gate_at $gate_state" = "$TS $at $state" ] || printf '%s\n%s\n%s\n' "$TS" "$at" "$state" > "$gate_file"
}

BUBBLE_CLOSED=0
BUBBLE_COUNTDOWN=0
REPLAY=false
if [ -n "$REACTION" ] && [ "$REACTION" != "null" ] && [ "$REACTION" != "" ]; then
    FRESH=0
    if [ "$GATED" -eq 1 ]; then
        _reaction_gate
        FRESH=1
        if [ "$_move_from" -ge 0 ] && [ $(( NOW - _move_from )) -ge "$BUBBLE_FOCUSED_SECONDS" ]; then
            FRESH=0
            BUBBLE_CLOSED=1
        elif [ "$_move_from" -ge 0 ]; then
            BUBBLE_COUNTDOWN=1
        fi
    elif [ "$REACTION_TTL" -eq 0 ]; then
        FRESH=1
    elif [ -f "$REACTION_FILE" ]; then
        if [ "$TS" != "0" ]; then
            AGE=$(( (EPOCH_NOW * 1000 - TS) / 1000 ))
            [ "$AGE" -lt "$REACTION_TTL" ] && FRESH=1
        fi
    fi
    if [ "$FRESH" -eq 1 ]; then
        if [ -n "$BUBBLE" ]; then
            BUBBLE="$BUBBLE | \"${REACTION}\""
        else
            BUBBLE="\"${REACTION}\""
        fi
    elif [ "$BUBBLE_CLOSED" -eq 0 ]; then
        rm -f "$REACTION_FILE" 2>/dev/null
    fi
fi
[ "$BUBBLE_CLOSED" -eq 1 ] && REACTION=""
# The name closes the bubble or reopens it, so its link carries a session id that must be safe inside a URL.
BUBBLE_URL=""
if [ "$GATED" -eq 1 ] && [ "$CLICK_TO_EXPAND" -eq 1 ] && [[ "$SID" =~ ^[A-Za-z0-9_-]{1,64}$ ]]; then
    BUBBLE_URL="coding-buddy://close/$SID"
    [ "$BUBBLE_CLOSED" -eq 1 ] && BUBBLE_URL="coding-buddy://reopen/$SID"
fi

# ─── Animation: pick current density frame from server-rendered frames ───────
SWEAT_AT_CONTEXT_PCT=40
SWEAT_EVERY_SECONDS=20
SWEAT_SHOWN_SECONDS=4
TIRED_AT_5H_PCT=50
ASLEEP_AFTER_IDLE_SECONDS=300
SWEAT=false
[ "$CONTEXT_PCT" -ge "$SWEAT_AT_CONTEXT_PCT" ] 2>/dev/null && SWEAT=true
TIRED=false
[ "$USAGE_5H_PCT" -ge "$TIRED_AT_5H_PCT" ] 2>/dev/null && TIRED=true
# gemini-react reads this at the end of a turn so its reaction matches how the buddy is drawn and how full the context is.
_signals="sweat=$SWEAT context=$CONTEXT_PCT tired=$TIRED"
_old_signals=""
[ -f "$BUDDY_STATE_DIR/.signals.$SID" ] && IFS= read -r _old_signals < "$BUDDY_STATE_DIR/.signals.$SID"
[ "$_signals" = "$_old_signals" ] || printf '%s\n' "$_signals" > "$BUDDY_STATE_DIR/.signals.$SID"
# The transcript grows with every message and tool call, so its age is how long the conversation has been quiet.
MOVE=pool
[ -f "$TRANSCRIPT" ] && _substatus_mtime "$TRANSCRIPT"
if [ -f "$TRANSCRIPT" ] && [ $(( NOW - SUBSTATUS_MTIME )) -ge "$ASLEEP_AFTER_IDLE_SECONDS" ]; then
    MOVE=idle
elif [ "$TIRED" = true ]; then
    MOVE=tired
fi
# A frozen status line would keep the move's first frame, so only an animated one acts it out.
# The move and its mood color share SINCE_REACTION, so both wait for focus together.
SINCE_REACTION=-1
_move_seconds=$REACTION_MOVE_SECONDS
if [ "$GATED" -eq 1 ]; then
    _move_seconds=$BUBBLE_FOCUSED_SECONDS
elif [[ "$TS" =~ ^[0-9]+$ ]]; then
    _move_from=$(( TS / 1000 ))
else
    _move_from=-1
fi
[ "$ANIMATE" -eq 1 ] && [ -n "$REACTION_MOVE$REACTION_MOOD" ] && [ "$_move_from" -ge 0 ] \
    && [ $(( NOW - _move_from )) -lt "$_move_seconds" ] && SINCE_REACTION=$(( NOW - _move_from ))
# The drop comes and goes while sweating. A frozen status line has no clock to blink by, so it keeps it.
SWEAT_DRAWN=false
[ "$SWEAT" = true ] && [ $(( (ANIMATE ? NOW : 0) % SWEAT_EVERY_SECONDS )) -lt "$SWEAT_SHOWN_SECONDS" ] && SWEAT_DRAWN=true
# A reopened bubble replays its move only between the moves the loop has scheduled; a first play holds them off.
FRAME_OUT=$(jq -r --argjson now "$(( ANIMATE ? NOW : 0 ))" --arg tier "$TIER" --arg move "$MOVE" \
    --argjson sweat "$SWEAT_DRAWN" --arg reaction_move "$REACTION_MOVE" --arg reaction_mood "$REACTION_MOOD" \
    --argjson since_reaction "$SINCE_REACTION" --argjson replay "$REPLAY" '
    def at($sequence): $sequence[$now % ($sequence | length)];
    (if $sweat then (.sweat // {}) else {} end) as $sweat_set
    | (if $tier == "compact" then ($sweat_set.compactFrames // .compactFrames? // .frames)
     elif $tier == "minimal" then ($sweat_set.minimalFrames // .minimalFrames? // .frames)
     else ($sweat_set.frames // .frames) end) as $set
    | (if $move == "idle" and (.idleSequence | length) > 0 then at(.idleSequence)
       elif $move == "tired" and (.tiredSequence | length) > 0 then at(.tiredSequence)
       else at(.frameSequence) end) as $scheduled
    | (if $since_reaction >= 0 and (.moveSequences[$reaction_move] | length) > 0
          and (($replay and ([.moveSequences[][]] | index($scheduled))) | not)
           then .moveSequences[$reaction_move][$since_reaction % (.moveSequences[$reaction_move] | length)]
       else $scheduled end) as $idx
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
[ -n "$SLIM" ] && NAME_WITH_LEVEL=""
NAME_LEN=${#NAME_WITH_LEVEL}
ART_CENTER=6
NAME_PAD=$(( ART_CENTER - NAME_LEN / 2 ))
[ "$NAME_PAD" -lt 0 ] && NAME_PAD=0
printf -v NAME_LINE '%*s%s' "$NAME_PAD" '' "$NAME_WITH_LEVEL"

BC="${BC:-$C}"
# The mood repaints the buddy only; the bubble keeps its color so the reaction stays readable.
[[ "$MOOD_COLOR" =~ ^#[0-9A-Fa-f]{6}$ ]] && _hex_to_ansi C "$MOOD_COLOR"
# Italic only: faint on top of italic made the bubble text hard to read.
ITALIC=$'\033[3m'
FAINT=$'\033[2m'
if [ "$COLOR_ENABLED" -eq 0 ]; then
    C=""
    BC=""
    NC=""
    NEUTRAL=""
    ITALIC=""
    FAINT=""
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
[ -n "$SLIM" ] || { ALL_LINES+=("$NAME_LINE"); ALL_COLORS+=("$C"); }

ART_COUNT=${#ALL_LINES[@]}

# ─── Speech bubble (left of art, word-wrapped) ──────────────────────────────
# Strip the quotes we added earlier
BUBBLE_TEXT=""
if [ -n "$BUBBLE" ]; then
    BUBBLE_TEXT="${BUBBLE%\"}"
    BUBBLE_TEXT="${BUBBLE_TEXT#\"}"
fi

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

# ─── Display width (emojis count as 2 cols) ──────────────────────────────────
# Prints one width per argument, so a tick measures its strings in one process. awk reads UTF-8
# byte by byte: a byte that is not part of valid UTF-8 counts as one column, as bash counts it.
# Rules mirror server/art.ts:displayWidth; the generated data lists every Unicode
# Emoji_Presentation codepoint, while VS16 upgrades a previous narrow emoji to 2 cols (e.g. ❤ + VS16).
# With "profile" first, each line holds the total and then the width of every character.
EMOJI_WIDTHS_DATA="$_HERE/emoji-widths.data"
EMOJI_TEXT_DATA="$_HERE/emoji-text.data"
dwidths() {
    local mode=width
    [ "$1" = "profile" ] && mode=profile && shift
    printf '%s\n' "$@" | LC_ALL=C awk -v mode="$mode" -v pres_file="$EMOJI_WIDTHS_DATA" -v text_file="$EMOJI_TEXT_DATA" '
    function load_ranges(path, target,    line, data, n, i, count, bounds, start, end, cp) {
        while ((getline line < path) > 0) if (line !~ /^#/) data = data line
        close(path)
        n = split(data, ranges, ",")
        for (i = 1; i <= n; i++) {
            count = split(ranges[i], bounds, "-")
            start = bounds[1] + 0
            end = (count == 2) ? bounds[2] + 0 : start
            for (cp = start; cp <= end; cp++) target[cp] = 1
        }
    }
    BEGIN {
        for (i = 1; i < 256; i++) ord[sprintf("%c", i)] = i
        load_ranges(pres_file, wide)
        load_ranges(text_file, text_default)
    }
    function tail(k) { return ord[substr($0, k, 1)] - 128 }
    function is_tail(k,    b) { b = ord[substr($0, k, 1)]; return b >= 128 && b < 192 }
    function char_width(cp) {
        if (cp in wide) return 2
        if (cp >= 9472 && cp <= 9631) return 1
        if (cp >= 12288 && cp <= 40959) return 2
        if (cp >= 65281 && cp <= 65376) return 2
        return 1
    }
    {
        len = length($0); total = 0; count = 0; upgradable = 0
        for (i = 1; i <= len; ) {
            b = ord[substr($0, i, 1)]
            if (b >= 240 && b < 245 && is_tail(i + 1) && is_tail(i + 2) && is_tail(i + 3)) {
                cp = (b - 240) * 262144 + tail(i + 1) * 4096 + tail(i + 2) * 64 + tail(i + 3); i += 4
            } else if (b >= 224 && b < 240 && is_tail(i + 1) && is_tail(i + 2)) {
                cp = (b - 224) * 4096 + tail(i + 1) * 64 + tail(i + 2); i += 3
            } else if (b >= 194 && b < 224 && is_tail(i + 1)) {
                cp = (b - 192) * 64 + tail(i + 1); i += 2
            } else {
                cp = (b < 128) ? b : -1; i++
            }
            count++
            if (cp == 65039) {
                if (upgradable && count > 1) { widths[count - 1]++; total++ }
                widths[count] = 0
                upgradable = 0
                continue
            }
            if ((cp >= 65024 && cp <= 65038) || cp == 8205) {
                widths[count] = 0
                upgradable = 0
                continue
            }
            cw = char_width(cp)
            widths[count] = cw
            total += cw
            upgradable = (cw == 1 && (cp in text_default))
        }
        if (mode != "profile") { print total; next }
        out = total
        for (j = 1; j <= count; j++) out = out " " widths[j]
        print out
    }'
}
dwidth() { dwidths "$1"; }

# Sets SUBSTATUS_LEFT, its plain text and SUBSTATUS_SINGLE=1 when the sub-status cache is one line.
load_single_substatus() {
    local cache="$BUDDY_STATE_DIR/.substatus.$SID" line lines=0
    [ -f "$cache" ] || return 0
    while IFS= read -r line || [ -n "$line" ]; do
        lines=$(( lines + 1 ))
        [ "$lines" -eq 1 ] && SUBSTATUS_LEFT="$line"
    done < "$cache"
    [ "$lines" -eq 1 ] || return 0
    ansi_strip "$SUBSTATUS_LEFT"
    SUBSTATUS_PLAIN="$ANSI_PLAIN"
    SUBSTATUS_SINGLE=1
}
SUBSTATUS_LEFT=""
SUBSTATUS_PLAIN=""
SUBSTATUS_SINGLE=0
[ "$SUBSTATUS_INLINE" -eq 1 ] && load_single_substatus

WORDS=()
[ -n "$BUBBLE_TEXT" ] && read -r -a WORDS <<< "$BUBBLE_TEXT"
_widths=()
IFS=$'\n' read -r -d '' -a _widths < <(dwidths "$NAME_WITH_LEVEL" "$NAME_LINE" "$SUBSTATUS_PLAIN" "$NAME" \
    "${ART_LINES[@]}" ${WORDS[@]+"${WORDS[@]}"})
LABEL_W="${_widths[0]}"
NAME_LINE_W="${_widths[1]}"
SUBSTATUS_LEFT_W="${_widths[2]}"
NAME_W="${_widths[3]}"
WORD_WIDTHS=(${_widths[@]:$(( 4 + ${#ART_LINES[@]} ))})
ART_W=0
for line_w in "${_widths[@]:4:${#ART_LINES[@]}}"; do
    [ "$line_w" -gt "$ART_W" ] && ART_W="$line_w"
done

# Keep the label inside the same sprite column as the art. The exact Unicode
# width rules live in dwidths(), so the shell and TS renderers agree on bounds.
if [ "$LABEL_W" -gt "$ART_W" ] 2>/dev/null; then
    ART_W="$LABEL_W"
    NAME_PAD=$(( (ART_W - LABEL_W) / 2 ))
    printf -v NAME_LINE '%*s%s' "$NAME_PAD" '' "$NAME_WITH_LEVEL"
    ALL_LINES[$(( ART_COUNT - 1 ))]="$NAME_LINE"
    NAME_LINE_W="$LABEL_W"
fi
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
    _face_name="${_face_plain}${NAME_WITH_LEVEL:+ $NAME_WITH_LEVEL}"
    _min_plain="$_face_name"
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
[ -n "$BUBBLE_TEXT" ] || { WORDS=(); WORD_WIDTHS=(); }

# Sets TEXT_LINES to WORDS wrapped at $1 columns, and TEXT_WIDTHS to their widths.
wrap_words() {
    local width="$1" i line="" line_w=0
    TEXT_LINES=()
    TEXT_WIDTHS=()
    for i in "${!WORDS[@]}"; do
        if [ -z "$line" ]; then
            line="${WORDS[$i]}"; line_w=${WORD_WIDTHS[$i]}
        elif [ $(( line_w + 1 + WORD_WIDTHS[i] )) -le "$width" ]; then
            line="$line ${WORDS[$i]}"; line_w=$(( line_w + 1 + WORD_WIDTHS[i] ))
        else
            TEXT_LINES+=("$line"); TEXT_WIDTHS+=("$line_w")
            line="${WORDS[$i]}"; line_w=${WORD_WIDTHS[$i]}
        fi
    done
    [ -n "$line" ] && TEXT_LINES+=("$line") && TEXT_WIDTHS+=("$line_w")
}
wrap_words "$INNER_W"

# Widens INNER_W, up to MAX_INNER, until the text wraps into at most $1 lines. It starts from the
# narrowest width that could fit, since each step re-wraps every word.
widen_to_lines() {
    local lines="$1" one_line_w=$(( ${#WORDS[@]} - 1 )) word_w fit_w
    [ "$lines" -gt 0 ] && [ "${#TEXT_LINES[@]}" -gt "$lines" ] || return 0
    for word_w in "${WORD_WIDTHS[@]}"; do one_line_w=$(( one_line_w + word_w )); done
    fit_w=$(( one_line_w / lines ))
    [ "$fit_w" -gt "$MAX_INNER" ] && fit_w="$MAX_INNER"
    [ "$fit_w" -gt "$INNER_W" ] && INNER_W="$fit_w" && wrap_words "$INNER_W"
    while [ "${#TEXT_LINES[@]}" -gt "$lines" ] && [ "$INNER_W" -lt "$MAX_INNER" ]; do
        INNER_W=$(( INNER_W + 1 ))
        wrap_words "$INNER_W"
    done
}

# Slim fits the bubble in the art's rows above an inline sub-status: "tight" drops the borders of a
# bubble too tall for them, "bubble" keeps them and takes one row more.
BUBBLE_ROUND=0
if [ -n "$SLIM" ] && [ "${#TEXT_LINES[@]}" -gt 0 ]; then
    _bubble_rows=$(( ART_COUNT - SUBSTATUS_INLINE ))
    if [ "$SLIM" = "bubble" ]; then
        widen_to_lines $(( _bubble_rows - 1 ))
    elif [ $(( ${#TEXT_LINES[@]} + 2 )) -gt "$_bubble_rows" ]; then
        BUBBLE_ROUND=1
        widen_to_lines "$_bubble_rows"
    fi
fi

TEXT_COUNT=${#TEXT_LINES[@]}

# Build box as plain strings (no ANSI). Color applied at output time.
# Box display width = INNER_W + 4:  "| " + text(INNER_W) + " |"
BOX_W=$(( INNER_W + 4 ))
BUBBLE_LINES=()
BUBBLE_TYPES=()  # "border" or "text" — determines coloring
if [ $TEXT_COUNT -gt 0 ]; then
    printf -v BORDER '%*s' "$(( BOX_W - 2 ))" ''
    BORDER="${BORDER// /-}"
    _top=".${BORDER}."
    _bottom="\`${BORDER}'"
    [ "$SLIM" = "bubble" ] && _bottom="'${BORDER}'"
    if [ "$BUBBLE_ROUND" -eq 0 ]; then
        BUBBLE_LINES+=("$_top")
        BUBBLE_TYPES+=("border")
    fi
    # Text rows: "| text padded |", or rounded ends "/ ... \" to "\ ... /" without borders.
    _last_text=$(( TEXT_COUNT - 1 ))
    for _ti in "${!TEXT_LINES[@]}"; do
        tl="${TEXT_LINES[$_ti]}"
        tpad=$(( INNER_W - TEXT_WIDTHS[_ti] ))
        [ "$tpad" -lt 0 ] && tpad=0
        printf -v padding '%*s' "$tpad" ''
        edges="||"
        if [ "$BUBBLE_ROUND" -eq 1 ]; then
            case "$_ti" in
                "$_last_text") [ "$TEXT_COUNT" -eq 1 ] && edges="()" || edges='\/' ;;
                0) edges='/\' ;;
            esac
        fi
        BUBBLE_LINES+=("${edges:0:1} ${tl}${padding} ${edges:1:1}")
        BUBBLE_TYPES+=("text")
    done
    if [ "$BUBBLE_ROUND" -eq 0 ]; then
        BUBBLE_LINES+=("$_bottom")
        BUBBLE_TYPES+=("border")
    fi
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
case "${OSTYPE:-}" in
    msys*|cygwin*|win32*) printf -v SPACER '%*s' "$PAD" '' ;;
    *)                    printf -v SPACER "${B}%${PAD}s" "" ;;
esac

# Minimal tier uses plain spaces so the one-line sprite + name fits without
# sacrificing a Braille Blank column on narrow terminals.
if [ "$TIER" = "minimal" ]; then
    PAD=$(( COLS - ART_W ))
    [ "$PAD" -lt 0 ] && PAD=0
    printf -v SPACER '%*s' "$PAD" ''
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
if [ "$BUBBLE_ROUND" -eq 1 ]; then
    CONNECTOR_BI=$(( BUBBLE_COUNT / 2 ))
elif [ $BUBBLE_COUNT -gt 2 ]; then
    # text rows are indices 1..(BUBBLE_COUNT-2), pick the middle one
    FIRST_TEXT=1
    LAST_TEXT=$(( BUBBLE_COUNT - 2 ))
    CONNECTOR_BI=$(( (FIRST_TEXT + LAST_TEXT) / 2 ))
    # The extra row "bubble" takes pushes the art down, so the face sits by the lower middle line.
    [ "$SLIM" = "bubble" ] && CONNECTOR_BI=$(( (FIRST_TEXT + LAST_TEXT + 1) / 2 ))
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
        printf -v art_part '%*s' "$ART_W" ''
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
            printf -v empty '%*s' "$BOX_W" ''
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

    # Strip SGR while building the one string sent to dwidths. The
    # profile uses one iconv/od/awk pass for the whole row; never spawn a
    # subprocess for each Unicode character.
    ansi_strip "$text"
    plain="$ANSI_PLAIN"
    [ "$plain" != "$text" ] && saw_sgr=1

    profile=(0)
    if [ -n "${3:-}" ]; then
        profile=($3)
    elif [ -n "$plain" ]; then
        read -r -a profile < <(dwidths profile "$plain")
    fi
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

# Puts the buddy at the right end of the cached one-line sub-status, trimming the
# reaction to the room left. Prints nothing when even the face and name do not fit.
inline_substatus_row() {
    local buddy buddy_w room text_room text reaction_part=""
    [ "$SUBSTATUS_SINGLE" -eq 1 ] || return 0
    local left="$SUBSTATUS_LEFT"
    room=$(( STATUSLINE_BUDGET - SUBSTATUS_LEFT_W - 2 ))
    buddy="$_face_name"
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

# Keeps the name in its column of the panel's last row, with the sub-status on its left. The slim layouts have
# no name row, so the name stands at a fixed column before the feet, in room the sub-status does not need.
inline_name_row() {
    [ "$SUBSTATUS_SINGLE" -eq 1 ] || return 0
    local pad=$(( COLS - ART_W - SUBSTATUS_LEFT_W )) name=""
    [ "$pad" -ge 2 ] || return 0
    if [ -n "$SLIM" ] && [ -n "$NAME" ] && [ "$pad" -ge $(( NAME_W + 3 )) ]; then
        name="${FAINT}${NAME}${NC}"
        [ -n "$BUBBLE_URL" ] && name=$'\033]8;;'"$BUBBLE_URL"$'\033\\'"$name"$'\033]8;;\033\\'
        name="$name "
        pad=$(( pad - NAME_W - 1 ))
    fi
    printf '%s%*s%s%s' "$SUBSTATUS_LEFT" "$pad" '' "$name" "${ALL_COLORS[$(( ART_COUNT - 1 ))]}${ALL_LINES[$(( ART_COUNT - 1 ))]}${NC}"
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

# cmd+click on the name opens coding-buddy://toggle, or closes or reopens the bubble; the URL handler from
# scripts/macos/install-click-toggle.sh routes both.
if [ "$CLICK_TO_EXPAND" -eq 1 ] && [ -n "$NAME_WITH_LEVEL" ]; then
    _name_link=$'\033]8;;'"${BUBBLE_URL:-coding-buddy://toggle}"$'\033\\'"${NAME_WITH_LEVEL}"$'\033]8;;\033\\'
    for _i in "${!OUTPUT_LINES[@]}"; do
        _row="${OUTPUT_LINES[$_i]}"
        case "$_row" in
            *"$NAME_WITH_LEVEL"*)
                OUTPUT_LINES[$_i]="${_row%%"$NAME_WITH_LEVEL"*}${_name_link}${_row#*"$NAME_WITH_LEVEL"}" ;;
        esac
    done
fi

render_output() {
    local i plains=() profiles=()
    for i in "${!OUTPUT_LINES[@]}"; do
        ansi_strip "${OUTPUT_LINES[$i]}"
        plains+=("$ANSI_PLAIN")
    done
    IFS=$'\n' read -r -d '' -a profiles < <(dwidths profile "${plains[@]}")
    for i in "${!OUTPUT_LINES[@]}"; do
        ansi_truncate "${OUTPUT_LINES[$i]}" "$STATUSLINE_BUDGET" "${profiles[$i]}"
        printf '\n'
    done

    # Append the last cached sub-status result below the buddy panel and refresh
    # it asynchronously when stale. The statusline itself never waits on it.
    append_substatus
}

if [ -n "$RENDER_CACHE" ]; then
    RENDERED=$(render_output)
    printf '%s\n' "$RENDERED"
    # Kept before the first sub-status refresh lands, the render would reprint without it until focused.
    # A bubble counting down would stay open in an unfocused tab until the next reaction.
    if [ "$BUBBLE_COUNTDOWN" -eq 0 ] && { [ -z "$SUBSTATUS_COMMAND" ] || [ -f "$BUDDY_STATE_DIR/.substatus.$SID" ]; }; then
        printf '%s\n' "$RENDERED" > "$RENDER_CACHE.tmp.$$" && mv "$RENDER_CACHE.tmp.$$" "$RENDER_CACHE"
    fi
else
    render_output
fi

exit 0
