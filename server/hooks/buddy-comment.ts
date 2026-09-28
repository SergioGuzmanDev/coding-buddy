#!/usr/bin/env bun

import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "fs";
import { join } from "path";
import {
  defaultSpawnDetached,
  fileExists,
  isOnCooldown,
  nonNegativeInteger,
  parseHookInput,
  readJsonFile,
  readStdin,
  resolveHookSessionId,
  resolveHookStateDir,
  stringField,
  type HookRuntime,
} from "./common.ts";

interface BuddyConfig {
  commentCooldown?: unknown;
}

interface Events {
  turns?: number;
  [key: string]: unknown;
}

interface ReactionFile {
  source?: string;
  timestamp?: number;
  [key: string]: unknown;
}

const BUDDY_COMMENT_PATTERN = /<!--\s*buddy:\s*([\s\S]*?)\s*-->/g;

/**
 * Provenance of the reaction the hook wrote. Mirrors server/state.ts
 * `ReactionSource`; loaded as `none` on legacy files without the field.
 */
// "tool" is returned when a buddy_react reaction was adopted rather than
// written by this hook; it mirrors server/state.ts's ReactionSource.
export type ReactionSource = "tool" | "comment" | "gemini" | "gemini-error" | "fallback" | "none";

export interface BuddyCommentResult {
  comment?: string;
  /** What produced the bubble. `"none"` means the hook ran but wrote nothing. */
  source: ReactionSource;
  updated: boolean;
}

export function extractBuddyComment(message: string): string {
  let comment = "";
  for (const match of message.matchAll(BUDDY_COMMENT_PATTERN)) {
    const candidate = match[1]?.trim();
    if (candidate) comment = candidate;
  }
  return comment;
}

/**
 * Tolerate tool-stamped timestamps that are slightly in the future (NTP
 * step, container/host skew, network-mounted state dir). Larger drifts
 * are treated as clock-skewed garbage and the hook falls through to
 * the comment / pool branch.
 */
const FUTURE_TIMESTAMP_TOLERANCE_MS = 60_000;

/** Atomic write — tmp + rename. */
function atomicWriteJson(path: string, value: unknown): void {
  const tmp = `${path}.tmp.${process.pid}.${Date.now()}`;
  writeFileSync(tmp, JSON.stringify(value, null, 2));
  renameSync(tmp, path);
}

function atomicWriteTimestamp(path: string, nowMs: number): void {
  const tmp = `${path}.tmp.${process.pid}.${Date.now()}`;
  writeFileSync(tmp, String(Math.floor(nowMs / 1000)));
  renameSync(tmp, path);
}

function readTimestampSeconds(path: string): number {
  try {
    const v = Number.parseInt(readFileSync(path, "utf8").trim(), 10);
    return Number.isFinite(v) ? v : 0;
  } catch {
    return 0;
  }
}

/**
 * Did `buddy_react` fire during the current turn?
 *
 * The Stop hook is the only place that knows turn boundaries. After each
 * Stop hook run, we stamp the wall-clock time into
 * `.last_stop_hook.<sid>` (seconds). A tool-author ed reaction whose
 * timestamp is more recent than the LAST Stop hook run is by definition
 * from this turn; leave it alone.
 *
 * Wall-clock 60 s freshness windows lose tool reactions on agentic
 * turns of 90 s–5 min, which are ordinary. This sentinel scales with
 * turn length, not elapsed time.
 *
 * Clock-skew guard: a tool timestamp implausibly in the future (beyond
 * `FUTURE_TIMESTAMP_TOLERANCE_MS`) is treated as garbage and we fall
 * through to the comment / pool branch. A future-dated `lastStopRun`
 * is clamped to `now` so a skewed clock on a prior run does not poison
 * the comparison.
 */
/**
 * How long after a stop marker a tool reaction still counts as "this turn".
 *
 * The Stop hook can legitimately fire more than once per turn — duplicate
 * registrations accumulate in settings.json, and one dogfooding machine was
 * observed with EIGHT Stop entries. Without this grace window the first
 * invocation adopts the buddy_react reaction and stamps the marker, and every
 * subsequent invocation then judges that same reaction stale and overwrites
 * the bubble with a canned pool line. The user only ever sees the last write.
 */
const SAME_TURN_GRACE_MS = 10_000;

/**
 * Hard ceiling on how old an adopted tool reaction may be.
 *
 * A brand-new session has no stop marker, so `readTimestampSeconds` returns 0
 * and every positive timestamp would otherwise look "fresh" — letting a
 * leftover reaction from an unrelated session surface on the first turn.
 * Bounded to the statusline's default reactionTTL: never adopt something the
 * statusline would already treat as expired.
 */
const MAX_ADOPTION_AGE_MS = 900_000;

function isFreshToolReaction(
  candidate: ReactionFile | null,
  stopMarkerPath: string,
  nowMs: number,
): boolean {
  if (!candidate || candidate.source !== "tool") return false;
  const ts = typeof candidate.timestamp === "number" ? candidate.timestamp : 0;
  if (ts <= 0) return false;
  if (ts > nowMs + FUTURE_TIMESTAMP_TOLERANCE_MS) return false;
  if (nowMs - ts > MAX_ADOPTION_AGE_MS) return false;
  const lastStopSec = readTimestampSeconds(stopMarkerPath);
  const effectiveLastStopMs = Math.min(lastStopSec * 1000, nowMs);
  return ts > effectiveLastStopMs - SAME_TURN_GRACE_MS;
}

/**
 * The MCP server and this hook do not always agree on the session id: the
 * server is long-lived and resolves BUDDY_SID once at launch, while the hook
 * and the statusline resolve it per invocation. When they diverge,
 * `buddy_react` writes a real model-authored reaction into a file nothing
 * renders, this hook sees an empty file for *its* session, and overwrites the
 * bubble with a canned pool line — which looks exactly like the reactions
 * being fake.
 *
 * So look for a fresh tool reaction across every session file, not just ours,
 * and adopt it. Ours still wins when both are fresh.
 */
function findFreshToolReaction(
  stateDir: string,
  ownReactionPath: string,
  stopMarkerPath: string,
  nowMs: number,
): ReactionFile | null {
  const own = readJsonFile<ReactionFile>(ownReactionPath);
  if (isFreshToolReaction(own, stopMarkerPath, nowMs)) return own;

  let best: ReactionFile | null = null;
  let entries: string[] = [];
  try {
    entries = readdirSync(stateDir);
  } catch {
    return null;
  }
  for (const entry of entries) {
    if (!entry.startsWith("reaction.") || !entry.endsWith(".json")) continue;
    const path = join(stateDir, entry);
    if (path === ownReactionPath) continue;
    const candidate = readJsonFile<ReactionFile>(path);
    if (!isFreshToolReaction(candidate, stopMarkerPath, nowMs)) continue;
    const bestTs = typeof best?.timestamp === "number" ? best.timestamp : 0;
    const candidateTs = typeof candidate?.timestamp === "number" ? candidate.timestamp : 0;
    if (!best || candidateTs > bestTs) best = candidate;
  }
  return best;
}

// reaction.<sid>.json and .last_comment.<sid> are absent: the status line sweeps those itself.
const SESSION_FILE =
  /^\.(substatus|substatus-sweep|render|signals|move_gate|worry_told|last_stop_hook|last_reaction|last_mood|last_bad|error_streak|session_start)\.([^.]+)(\.lock)?$/;
const TMP_LEFTOVER = /^(\.[a-z_-]+\.[^.]+|reaction\.[^.]+\.json)\.tmp(\.|$)/;
const TMP_LEFTOVER_AGE_MS = 60 * 60_000;
// A day would also catch an unfocused tab left overnight, whose rebuilt render cache then lacks the sub-status row.
const IDLE_SESSION_AGE_MS = 7 * 24 * 60 * 60_000;

/** Deletes tmp files a killed writer left behind, and every file of a session none of whose files changed in a week. */
export function sweepStaleSessionFiles(stateDir: string, nowMs: number): void {
  const sessions = new Map<string, { newest: number; paths: string[] }>();
  for (const name of readdirSync(stateDir)) {
    const tmp = TMP_LEFTOVER.test(name);
    const session = tmp ? null : SESSION_FILE.exec(name);
    if (!tmp && !session) continue;
    const path = join(stateDir, name);
    let mtime: number;
    try {
      mtime = statSync(path).mtimeMs;
    } catch {
      continue;
    }
    if (tmp) {
      if (nowMs - mtime > TMP_LEFTOVER_AGE_MS) rmSync(path, { force: true });
      continue;
    }
    const files = sessions.get(session![2]) ?? { newest: 0, paths: [] };
    files.newest = Math.max(files.newest, mtime);
    files.paths.push(path);
    sessions.set(session![2], files);
  }
  for (const { newest, paths } of sessions.values()) {
    if (nowMs - newest > IDLE_SESSION_AGE_MS) for (const path of paths) rmSync(path, { force: true, recursive: true });
  }
}

export function handleBuddyComment(
  rawInput: string,
  runtime: HookRuntime = {},
): BuddyCommentResult {
  const stateDir = resolveHookStateDir(runtime);
  if (!fileExists(join(stateDir, "status.json"))) {
    return { source: "none", updated: false };
  }

  const input = parseHookInput(rawInput);
  if (!input) return { source: "none", updated: false };

  const assistantMessage = stringField(input, "last_assistant_message");
  if (!assistantMessage) return { source: "none", updated: false };

  const now = runtime.now?.() ?? Date.now();
  const sid = resolveHookSessionId(runtime);
  const reactionPath = join(stateDir, `reaction.${sid}.json`);
  const cooldownFile = join(stateDir, `.last_comment.${sid}`);
  const stopMarkerFile = join(stateDir, `.last_stop_hook.${sid}`);
  const config = readJsonFile<BuddyConfig>(join(stateDir, "config.json")) ?? {};
  const cooldown = nonNegativeInteger(config.commentCooldown, 30);

  // ─── Don't clobber a buddy_react tool reaction from this turn ───────────
  // Checked across all session files: see findFreshToolReaction for why.
  const freshTool = findFreshToolReaction(stateDir, reactionPath, stopMarkerFile, now);
  if (freshTool) {
    // Adopt it into this session's file so the statusline — which reads only
    // its own session — actually renders the model-authored line.
    const own = readJsonFile<ReactionFile>(reactionPath);
    let wrote = false;
    if (own?.reaction !== freshTool.reaction || own?.source !== "tool") {
      mkdirSync(stateDir, { recursive: true });
      atomicWriteJson(reactionPath, freshTool);
      wrote = true;
    }
    atomicWriteTimestamp(stopMarkerFile, now);
    // `updated` reports whether this invocation wrote the bubble, so adoption
    // counts — a consumer using it to trigger a re-render must see the write.
    return { source: "tool", updated: wrote };
  }

  // ─── Cooldown: rate-limit the reaction write AND bookkeeping ──────────
  // Main ran the turn counter / XP / memory hooks only inside the
  // "reaction written" branch. Running them unconditionally makes the
  // XP economy and spawn counts scale with Stop event frequency, which
  // is wrong.
  if (isOnCooldown(cooldownFile, cooldown, now)) {
    atomicWriteTimestamp(stopMarkerFile, now);
    return { source: "none", updated: false };
  }

  const comment = extractBuddyComment(assistantMessage);
  const userMessage = stringField(input, "last_user_message");
  mkdirSync(stateDir, { recursive: true });

  // Bookkeeping fires only when a reaction is actually written (main).
  const eventsFile = join(stateDir, "events.json");
  const events = readJsonFile<Events>(eventsFile) ?? {};
  events.turns = (typeof events.turns === "number" ? events.turns : 0) + 1;
  atomicWriteJson(eventsFile, events);

  atomicWriteTimestamp(cooldownFile, now);

  const spawnDetached = runtime.spawnDetached ?? defaultSpawnDetached(runtime);
  if (comment) {
    atomicWriteJson(reactionPath, { reaction: comment, timestamp: now, reason: "turn", source: "comment" });
  } else {
    // Gemini takes seconds, so it writes the bubble from its own process instead of holding up the turn.
    spawnDetached("server/gemini-react.ts", [assistantMessage, userMessage, stringField(input, "transcript_path")]);
  }
  spawnDetached("server/award-xp.ts", ["turn"]);
  spawnDetached("server/consolidate.ts", [assistantMessage, userMessage]);
  atomicWriteTimestamp(stopMarkerFile, now);

  return comment ? { comment, source: "comment", updated: true } : { source: "gemini", updated: false };
}

if (import.meta.main) {
  try {
    handleBuddyComment(await readStdin());
    sweepStaleSessionFiles(resolveHookStateDir(), Date.now());
  } catch {
    // Claude Code hooks must never fail the turn.
  }
  process.exit(0);
}
