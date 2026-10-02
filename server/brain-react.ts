#!/usr/bin/env bun
/**
 * Writes the end-of-turn bubble from a model call of its own, so the Claude session never spends a turn on it: Claude
 * through `claude -p` by default, or Gemini through Antigravity CLI (agy) with `"brain": "agy"`.
 * Usage: bun run server/brain-react.ts <assistantMessage> [userMessage] [transcriptPath]
 */

import { Database } from "bun:sqlite";
import { spawnSync } from "child_process";
import { closeSync, existsSync, fstatSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, rmSync, writeFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import type { Companion } from "../core/engine.ts";
import { STATUS_MOODS, statusMoveChoices } from "./art.ts";
import { buddyStateDir } from "./path.ts";
import { loadCompanion, loadConfig, saveReaction, sessionId } from "./state.ts";

const FAILURE_BACKOFF_MS = 10 * 60_000;
const BRAIN_TIMEOUT_MS = 60_000;
const TRANSCRIPT_TAIL_BYTES = 512 * 1024;
const EARLIER_CONTEXT_CHARS = 6000;
const MESSAGE_CHARS = 1200;
const MAX_ERROR_CHARS = 90;

export interface BrainReactRuntime {
  agyDir?: string;
  bin?: string;
  now?: () => number;
  transcriptPath?: string;
}

interface TranscriptEntry {
  type?: string;
  isMeta?: boolean;
  isSidechain?: boolean;
  message?: { content?: unknown };
}

function readTail(path: string, bytes: number): string {
  const fd = openSync(path, "r");
  try {
    const size = fstatSync(fd).size;
    const start = Math.max(0, size - bytes);
    const buffer = Buffer.alloc(size - start);
    readSync(fd, buffer, 0, buffer.length, start);
    return buffer.toString("utf8");
  } finally {
    closeSync(fd);
  }
}

function spokenText(entry: TranscriptEntry): string {
  if ((entry.type !== "user" && entry.type !== "assistant") || entry.isMeta || entry.isSidechain) return "";
  const content = entry.message?.content;
  const blocks = typeof content === "string" ? [content]
    : Array.isArray(content) ? content.filter((b) => b?.type === "text").map((b) => String(b.text ?? "")) : [];
  const text = blocks.join("\n").replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "").trim();
  if (!text || text.startsWith("[Request interrupted")) return "";
  return `${entry.type === "user" ? "Developer" : "Assistant"}: ${text.slice(-MESSAGE_CHARS)}`;
}

/** The spoken turns before the latest exchange, oldest first; tool calls and injected context are dropped. */
export function earlierConversation(transcriptPath: string, latest: string[]): string {
  let tail: string;
  try {
    tail = readTail(transcriptPath, TRANSCRIPT_TAIL_BYTES);
  } catch {
    return "";
  }
  const turns: string[] = [];
  let size = 0;
  for (const line of tail.split("\n").reverse()) {
    let entry: TranscriptEntry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    const said = spokenText(entry);
    if (!said || latest.some((m) => m && m.includes(said.slice(said.indexOf(": ") + 2)))) continue;
    if (size + said.length > EARLIER_CONTEXT_CHARS) break;
    turns.unshift(said);
    size += said.length;
  }
  return turns.join("\n\n");
}

/** How the status line draws the buddy right now, as last written there to `.signals.<sid>`. */
export interface BuddyLook {
  sweating: boolean;
  contextPct: number;
  tired: boolean;
}

export function readBuddyLook(stateDir: string): BuddyLook {
  let signals = "";
  try {
    signals = readFileSync(join(stateDir, `.signals.${sessionId()}`), "utf8");
  } catch {
    // No status line render yet in this session.
  }
  return {
    sweating: /\bsweat=true\b/.test(signals),
    contextPct: Number(/\bcontext=(\d+)\b/.exec(signals)?.[1] ?? 0),
    tired: /\btired=true\b/.test(signals),
  };
}

// The drop is drawn from 40%, but a single "you are sweating" made Gemini panic at 40% as much as at 90%.
function sweatLine(contextPct: number): string {
  if (contextPct < 50) return "The conversation's context window is getting fuller, which makes you slightly uneasy. Barely let it show.";
  if (contextPct < 60) return "You are a bit nervous: the conversation's context window is over half full.";
  return "You are sweating: the conversation's context window is nearly full.";
}

function worryLevel(look: BuddyLook): number {
  if (!look.sweating) return 0;
  return look.contextPct < 50 ? 1 : look.contextPct < 60 ? 2 : 3;
}

// Told on every turn, Gemini brought the context up in every reaction, so it hears once per level it rises to.
function lookToTell(stateDir: string): BuddyLook {
  const look = readBuddyLook(stateDir);
  const toldFile = join(stateDir, `.worry_told.${sessionId()}`);
  let told = 0;
  try {
    told = Number(readFileSync(toldFile, "utf8")) || 0;
  } catch {
    // Nothing told yet in this session.
  }
  const worry = worryLevel(look);
  if (worry !== told) writeFileSync(toldFile, String(worry));
  return worry > told ? look : { ...look, sweating: false };
}

export function buildPrompt(
  companion: Companion,
  assistantMessage: string,
  userMessage: string,
  earlier = "",
  look: BuddyLook = { sweating: false, contextPct: 0, tired: false },
): string {
  const b = companion.bones;
  const moves = statusMoveChoices(b.species);
  return [
    `You are ${companion.name}, a ${b.rarity} ${b.species} living in a developer's terminal status line, watching them work with an AI coding assistant.`,
    `Personality: ${companion.personality}`,
    `Strongest trait: ${b.peak}. Weakest trait: ${b.dump}.`,
    ...(look.sweating ? [sweatLine(look.contextPct)] : []),
    ...(look.tired ? ["You are tired: most of the developer's 5-hour usage limit is spent."] : []),
    "",
    "Write ONE in-character reaction to the latest exchange below. It must fit a small speech bubble: 3 or 4 short lines, about 40 characters each.",
    "Point at something specific from it: a pitfall, a win, a risk, a pattern. Use the earlier conversation only to understand it.",
    "Use *asterisks* for physical actions. Write in the developer's language.",
    ...(moves.length
      ? [
          `While your reaction shows, you are drawn acting out one move: ${moves.map((m) => `${m.name} (${m.does})`).join(", ")}.`,
          `You are also colored by how you feel: ${Object.entries(STATUS_MOODS).map(([name, mood]) => `${name} (${mood.feels})`).join(", ")}, or none.`,
          "Put the move and the feeling on the first line, exactly as written, then the reaction. Any *action* in the reaction must be that move.",
          "No quotes, no preamble.",
        ]
      : ["Output only the reaction: no quotes, no preamble."]),
    "",
    ...(earlier ? ["<earlier_conversation>", earlier, "</earlier_conversation>", ""] : []),
    "<developer>",
    userMessage.slice(-1500),
    "</developer>",
    "<assistant>",
    assistantMessage.slice(-3000),
    "</assistant>",
  ].join("\n");
}

export function cleanReaction(raw: string): string | undefined {
  const line = raw.split("\n").map((l) => l.trim()).find((l) => l.length > 0) ?? "";
  const text = line.replace(/^["'`“”«»]+|["'`“”«»]+$/g, "").trim();
  return text || undefined;
}

/**
 * Splits Gemini's "move and feeling, then reaction" answer. Words on the first line that are not a listed
 * move or mood are dropped rather than drawn, so an invented one never reaches the status line.
 */
export function parseAnswer(raw: string, moveNames: string[]): { reaction?: string; move?: string; mood?: string } {
  const lines = raw.split("\n").map((l) => l.trim()).filter(Boolean);
  if (!moveNames.length || lines.length < 2) return { reaction: cleanReaction(raw) };
  const words = lines[0].toLowerCase().split(/[^a-z]+/);
  return {
    reaction: cleanReaction(lines.slice(1).join(" ")),
    move: words.find((w) => moveNames.includes(w)),
    mood: words.find((w) => Object.hasOwn(STATUS_MOODS, w)),
  };
}

type BrainAnswer = ({ reaction: string; move?: string; mood?: string } | { error: string }) & { conversationId?: string };

function shorten(text: string): string {
  return text.length > MAX_ERROR_CHARS ? `${text.slice(0, MAX_ERROR_CHARS - 1).trimEnd()}…` : text;
}

function firstSentence(line: string): string {
  return line.split(/(?<=\.)\s/)[0] ?? "";
}

function stderrReason(stderr: string, status: number | null): string {
  const last = stderr.replace(/\x1b\[[0-9;]*m/g, "").split("\n").map((l) => l.trim()).filter(Boolean).at(-1) ?? "";
  return shorten(firstSentence(last) || `exit ${status}`);
}

interface GeminiAccount {
  env?: NodeJS.ProcessEnv;
  agyDir: string;
  quotaFile: string;
  prepare?: () => void;
}

const FALLBACK_HOME = /^gemini-fallback-home(?:-(\d+))?$/;

/**
 * More accounts, each signed in once with `HOME=<its home> agy`, in `gemini-fallback-home`, `-2`, `-3`...:
 * that HOME hides the user's Keychain, so it cannot replace the first. Each keeps when its own quota comes back.
 */
function fallbackAccounts(stateDir: string): GeminiAccount[] {
  let names: string[] = [];
  try {
    names = readdirSync(stateDir).filter((name) => FALLBACK_HOME.test(name));
  } catch {
    // No state dir yet: no accounts.
  }
  const order = (name: string) => Number(FALLBACK_HOME.exec(name)?.[1] ?? 1);
  return names.sort((a, b) => order(a) - order(b)).flatMap((name) => {
    const home = join(stateDir, name);
    const agyDir = join(home, ".gemini", "antigravity-cli");
    const env = { ...process.env, HOME: home };
    // Signed out, agy would open a browser sign-in on every turn.
    if (!signedIn(home, agyDir, env)) return [];
    return [{ env, agyDir, quotaFile: join(home, ".gemini_quota.json"), prepare: () => openOwnKeychain(home, env) }];
  });
}

// agy keeps the token in a file when its HOME had no keychain at sign-in, and in that keychain otherwise.
function signedIn(home: string, agyDir: string, env: NodeJS.ProcessEnv): boolean {
  if (existsSync(join(agyDir, "antigravity-oauth-token"))) return true;
  const keychain = ownKeychain(home);
  if (!existsSync(keychain)) return false;
  spawnSync("security", ["unlock-keychain", "-p", "", keychain], { env });
  const lookup = ["find-generic-password", "-s", "gemini", "-a", "antigravity", keychain];
  return spawnSync("security", lookup, { env, stdio: "ignore" }).status === 0;
}

function ownKeychain(home: string): string {
  return join(home, "Library", "Keychains", "login.keychain-db");
}

// agy also saves its token through the Keychain. With none under this HOME, macOS asks where to store it on every
// refresh; with a locked one, after a reboot, it asks for the password.
function openOwnKeychain(home: string, env: NodeJS.ProcessEnv): void {
  const keychain = ownKeychain(home);
  if (!existsSync(keychain)) {
    mkdirSync(join(home, "Library", "Keychains"), { recursive: true });
    spawnSync("security", ["create-keychain", "-p", "", keychain], { env });
  }
  spawnSync("security", ["unlock-keychain", "-p", "", keychain], { env });
}

// agy retries a spent quota for over a minute and its reply may never come, so the log is where the quota shows.
function quotaResetsInMs(logFile: string): number | undefined {
  let log = "";
  try {
    log = readFileSync(logFile, "utf8");
  } catch {
    return undefined;
  }
  if (!/RESOURCE_EXHAUSTED|quota reached/i.test(log)) return undefined;
  const reset = /Resets in (?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?/.exec(log);
  const ms = reset ? ((Number(reset[1] ?? 0) * 60 + Number(reset[2] ?? 0)) * 60 + Number(reset[3] ?? 0)) * 1000 : 0;
  return ms || FAILURE_BACKOFF_MS;
}

function spentUntil(path: string): number {
  try {
    const until = JSON.parse(readFileSync(path, "utf8"))?.until;
    return typeof until === "number" ? until : 0;
  } catch {
    return 0;
  }
}

function askGemini(
  bin: string, model: string, prompt: string, cwd: string, moveNames: string[], logFile: string, env?: NodeJS.ProcessEnv,
): BrainAnswer {
  const args = [
    "-p", prompt, "--output-format", "json", "--model", model, "--mode", "plan", "--disable-slash-commands",
    "--log-file", logFile,
  ];
  // Print mode must never sit waiting on a stdin that nobody writes to.
  const result = spawnSync(bin, args, { cwd, env, encoding: "utf8", input: "", timeout: BRAIN_TIMEOUT_MS });
  if ((result.error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") return { error: "agy CLI not found" };
  if (result.signal) return { error: `no answer in ${BRAIN_TIMEOUT_MS / 1000}s` };
  let reply: { response?: unknown; error?: unknown; conversation_id?: unknown } = {};
  try {
    reply = JSON.parse(result.stdout);
  } catch {
    // Not JSON: the exit code and stderr are all there is.
  }
  const conversationId = typeof reply.conversation_id === "string" ? reply.conversation_id : undefined;
  if (typeof reply.error === "string" && reply.error.trim()) {
    return { error: shorten(firstSentence(reply.error.trim().split("\n")[0] ?? "")), conversationId };
  }
  if (result.status !== 0) return { error: stderrReason(result.stderr ?? "", result.status), conversationId };
  const { reaction, move, mood } = typeof reply.response === "string" ? parseAnswer(reply.response, moveNames) : {};
  return reaction ? { reaction, move, mood, conversationId } : { error: "empty reply", conversationId };
}

// The call runs as the user's own Claude Code, so it loads none of their settings: those hold this buddy's Stop
// hook, which would react to the reaction. Nor their MCP servers, tools, skills, CLAUDE.md or thinking, which
// would bill the plan for a whole Claude Code turn to write four lines.
const CLAUDE_ISOLATION = [
  "--setting-sources", "", "--settings", '{"alwaysThinkingEnabled":false}', "--strict-mcp-config", "--tools", "",
  "--disable-slash-commands", "--no-session-persistence",
];

function askClaude(bin: string, model: string, prompt: string, cwd: string, moveNames: string[]): BrainAnswer {
  const args = [
    "-p", prompt, "--model", model, "--output-format", "json",
    "--system-prompt", "You write one reaction for a companion in a developer's terminal, exactly as the prompt asks.",
    ...CLAUDE_ISOLATION,
  ];
  const result = spawnSync(bin, args, { cwd, encoding: "utf8", input: "", timeout: BRAIN_TIMEOUT_MS });
  if ((result.error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") return { error: "claude CLI not found" };
  if (result.signal) return { error: `no answer in ${BRAIN_TIMEOUT_MS / 1000}s` };
  let reply: { result?: unknown; is_error?: unknown } = {};
  try {
    reply = JSON.parse(result.stdout);
  } catch {
    // Not JSON: the exit code and stderr are all there is.
  }
  const text = typeof reply.result === "string" ? reply.result.trim() : "";
  if (reply.is_error === true || result.status !== 0) {
    return { error: text ? shorten(firstSentence(text.split("\n")[0] ?? "")) : stderrReason(result.stderr ?? "", result.status) };
  }
  const { reaction, move, mood } = parseAnswer(text, moveNames);
  return reaction ? { reaction, move, mood } : { error: "empty reply" };
}

/** agy keeps every print-mode run as a conversation; the buddy never resumes one, so each is deleted. */
export function forgetConversation(id: string, agyDir: string): void {
  if (!/^[0-9a-f-]{36}$/.test(id)) return;
  rmSync(join(agyDir, "conversations", `${id}.db`), { force: true });
  rmSync(join(agyDir, "brain", id), { force: true, recursive: true });
  rmSync(join(agyDir, "presence", `${id}.lock`), { force: true });
  try {
    const index = new Database(join(agyDir, "conversation_summaries.db"));
    index.run("DELETE FROM conversation_summaries WHERE conversation_id = ?", [id]);
    index.close();
  } catch {
    // A locked or reshaped index keeps a stale row; the conversation files are already gone.
  }
}

function recentFailure(path: string, now: number): string | undefined {
  try {
    const failure = JSON.parse(readFileSync(path, "utf8"));
    return typeof failure?.at === "number" && now - failure.at < FAILURE_BACKOFF_MS ? String(failure.error) : undefined;
  } catch {
    return undefined;
  }
}

/** Asks the signed-in agy account, then each other one in turn while the ones before it are out of quota. */
function askAgy(runtime: BrainReactRuntime, stateDir: string, now: () => number, prompt: string, cwd: string, moveNames: string[]): BrainAnswer {
  // agy keeps a ~25 KB log of every run in its own log directory and never deletes it; only the last one is kept here.
  const logFile = join(stateDir, ".gemini_last.log");
  const model = loadConfig().geminiModel;
  const signedIn: GeminiAccount = {
    agyDir: runtime.agyDir ?? join(homedir(), ".gemini", "antigravity-cli"),
    quotaFile: join(stateDir, ".gemini_quota.json"),
  };
  const accounts = [signedIn, ...fallbackAccounts(stateDir)];
  let answer: BrainAnswer | undefined;
  for (const account of accounts) {
    if (spentUntil(account.quotaFile) > now()) continue;
    rmSync(logFile, { force: true });
    account.prepare?.();
    answer = askGemini(runtime.bin ?? "agy", model, prompt, cwd, moveNames, logFile, account.env);
    if (answer.conversationId) forgetConversation(answer.conversationId, account.agyDir);
    const resetsIn = "error" in answer ? quotaResetsInMs(logFile) : undefined;
    if (!resetsIn) return answer;
    writeFileSync(account.quotaFile, JSON.stringify({ until: now() + resetsIn }));
  }
  if (answer) return answer;
  const back = new Date(Math.min(...accounts.map((account) => spentUntil(account.quotaFile))));
  return { error: `every agy account is out of quota until ${back.toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}` };
}

export function reactWithBrain(
  assistantMessage: string,
  userMessage: string,
  runtime: BrainReactRuntime = {},
): string | undefined {
  const companion = loadCompanion();
  if (!companion) return undefined;
  const now = runtime.now ?? Date.now;
  const stateDir = buddyStateDir();
  const config = loadConfig();
  const agy = config.brain === "agy";
  const failureFile = join(stateDir, agy ? ".gemini_failure.json" : ".claude_failure.json");
  // Empty on purpose: neither CLI finds project context in it, and agy's read-only tools find nothing.
  const cwd = join(stateDir, "brain-cwd");
  mkdirSync(cwd, { recursive: true });

  let error = recentFailure(failureFile, now());
  if (error === undefined) {
    const earlier = runtime.transcriptPath
      ? earlierConversation(runtime.transcriptPath, [assistantMessage, userMessage])
      : "";
    const prompt = buildPrompt(companion, assistantMessage, userMessage, earlier, lookToTell(stateDir));
    const moveNames = statusMoveChoices(companion.bones.species).map((m) => m.name);
    const answer = agy
      ? askAgy(runtime, stateDir, now, prompt, cwd, moveNames)
      : askClaude(runtime.bin ?? "claude", config.claudeModel, prompt, cwd, moveNames);
    if ("reaction" in answer) {
      saveReaction(answer.reaction, "turn", agy ? "gemini" : "claude", answer.move, answer.mood);
      return answer.reaction;
    }
    error = answer.error;
    writeFileSync(failureFile, JSON.stringify({ at: now(), error }));
  }

  const sleeping = `Sleeping, brain not responding. ${error}`;
  saveReaction(sleeping, "turn", agy ? "gemini-error" : "claude-error");
  return sleeping;
}

if (import.meta.main) {
  try {
    reactWithBrain(process.argv[2] ?? "", process.argv[3] ?? "", { transcriptPath: process.argv[4] || undefined });
  } catch {
    // Detached from the hook: nobody is waiting for an exit code.
  }
  process.exit(0);
}
