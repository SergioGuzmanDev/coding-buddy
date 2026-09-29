# Resource budget

The buddy is decoration. It must never make the machine or Claude Code feel slower. This file is the home for that rule; other documents point here instead of repeating it.

## Ask first

Before you implement a feature that needs any of the following, stop and ask Sergio. Say what it costs, what cheaper version you considered, and wait for a yes.

- The status line running more often (a lower `refreshInterval` in `buddyStatusLineEntry`, `server/state.ts`) or doing more per tick: a new process start, a network call, a `bun`, `node` or `python` start.
- A new LLM or network call, or more than one per turn and session. Today the only one is `server/brain-react.ts`, started detached from the Stop hook.
- A new process that stays alive: a daemon, a launch agent, an iTerm2 AutoLaunch script, a `setInterval` loop, a file watcher.
- A new hook event or matcher. Each one starts `bun` on every matching event, and `PostToolUse` fires on every tool call.
- Reading a whole transcript, walking a directory tree, or reading every session's files on a hot path.
- A new dependency with native code or an install script.
- A new file per session or per turn with nothing that deletes it.

If you are not sure whether something counts, ask. A short question costs less than a revert.

## Where the cost is

| Path | Runs | Multiplied by |
|------|------|---------------|
| `statusline/buddy-status.sh` | every refresh tick and every message | open sessions |
| `hooks/*.sh`, which run `server/hooks/*.ts` | every Bash, Write and Edit call, every prompt, every turn end | open sessions and tool calls |
| Detached scripts started by hooks (`brain-react.ts`, `award-xp.ts`, `consolidate.ts`, `shift-mood.ts`, `check-suggestions.ts`) | turn ends and matching tool calls | open sessions and turns |
| MCP server, `server/index.ts` | the whole session | open sessions |
| `scripts/macos/buddy_focus.py` | while iTerm2 runs | once |

Process starts dominate. Starting `jq`, `awk`, `iconv`, `date` or `bun` costs more than the logic it runs, so count process starts before you count anything else.

## Status line

1. No network, no LLM, no `bun`, `node` or `python`. Bash builtins plus a fixed, small number of `jq` and `awk` calls.
2. One `jq` per file, not one per field (`read_fields`).
3. The server pre-bakes what it can: `writeStatusState` renders every frame into `status.json`, and the status line only picks one.
4. Never start a subprocess inside a loop over characters, words or rows. Measure every string a tick needs in one call, as `dwidths` does.
5. Skip work whose result would not change. A row that already fits skips the truncation walk. Under `animate: "focused"`, unfocused iTerm2 sessions reprint `.render.<sid>`. A cache key holds only what changes the output, never Claude Code's input, which differs on every tick.
6. Write a file only when its content changes, as with `.signals.<sid>`.
7. Slow work goes to a detached child with a lock and a cache, like `append_substatus` in `statusline/substatus.sh`. The status line prints the last cached result and never waits for the child.
8. Claude Code kills a slow status line and the buddy disappears. The time budget is `TIME_BUDGET_MS` in `scripts/ci/check-statusline.sh`; check it with `bun run ci:statusline`.

## Hooks

1. A hook holds up Claude Code until it exits. Read and write a few small files, then exit 0. Never let an error escape.
2. Work that takes seconds (LLM, network) goes through `spawnDetached` in `server/hooks/common.ts`, and the child writes its own result.
3. Once per turn, not once per tool call. When an event can repeat, gate it with a cooldown file (`isOnCooldown`, `commentCooldown`).
4. Put new logic in an existing hook script before you register a new hook. Every registered hook is one more `bun` start per event.
5. When the config leaves a hook nothing to do, its shell wrapper exits before `bun` starts, as `hooks/name-react.sh` does when canned reactions are off.
6. Read bounded input: the transcript tail (`TRANSCRIPT_TAIL_BYTES`), never the whole file.

## LLM calls

The reaction in `server/brain-react.ts` is the most expensive thing the buddy does: a `claude` or `agy` process, a network round trip and quota. Any other call follows the same pattern.

1. It runs detached from the Stop hook, at most once per turn.
2. It has a hard timeout (`BRAIN_TIMEOUT_MS`) and backs off after a failure (`FAILURE_BACKOFF_MS`), so a broken CLI is not retried every turn.
3. The prompt has a size limit (`EARLIER_CONTEXT_CHARS`, `MESSAGE_CHARS`).
4. It runs in an empty working directory, so the CLI loads no project.
5. It leaves nothing on disk: `claude` runs with `--no-session-persistence`, and what `agy` stores is deleted (`forgetConversation`).

## Long-lived processes

1. React to events, never poll. `buddy_focus.py` waits on iTerm2's `FocusMonitor`; do the same.
2. No `setInterval` or file watcher in the MCP server. There is one per open session, and each lives as long as its session.
3. No in-memory cache without a size limit.

## Disk

1. Every file named per session or per turn needs a sweep that deletes it once expired: `_sweep_expired_reactions` in the status line, or `sweepStaleSessionFiles` in `server/hooks/buddy-comment.ts`. Otherwise the state directory grows forever.
2. Sweeps read the state directory only, never a tree.
3. Write through a temp file and `rename`, so a killed process never leaves a half-written file.

## Review questions

These need judgement, so no test covers them. Ask them of every change:

- Does it start a process on a hot path that did not start one before?
- Does its cost grow with open sessions, tool calls or transcript size?
- When it fails, does it retry on every tick or every turn?
- What deletes the files it writes?
- Is there a cached or pre-baked way to get the same result?
