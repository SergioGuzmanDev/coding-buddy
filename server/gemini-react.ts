#!/usr/bin/env bun
/**
 * Writes the end-of-turn bubble with Gemini through Antigravity CLI (agy), so the Claude session never spends a call on it.
 * Usage: bun run server/gemini-react.ts <assistantMessage> [userMessage] [transcriptPath]
 */

import { Database } from "bun:sqlite";
import { spawnSync } from "child_process";
import { closeSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, rmSync, writeFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import type { Companion } from "../core/engine.ts";
import { buddyStateDir } from "./path.ts";
import { loadCompanion, loadConfig, saveReaction } from "./state.ts";

const MAX_REACTION_CHARS = 150;
const FAILURE_BACKOFF_MS = 10 * 60_000;
const GEMINI_TIMEOUT_MS = 60_000;
const TRANSCRIPT_TAIL_BYTES = 512 * 1024;
const EARLIER_CONTEXT_CHARS = 6000;
const MESSAGE_CHARS = 1200;
const MAX_ERROR_CHARS = 90;

export interface GeminiReactRuntime {
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

export function buildPrompt(
  companion: Companion,
  assistantMessage: string,
  userMessage: string,
  earlier = "",
): string {
  const b = companion.bones;
  return [
    `You are ${companion.name}, a ${b.rarity} ${b.species} living in a developer's terminal status line, watching them work with an AI coding assistant.`,
    `Personality: ${companion.personality}`,
    `Strongest trait: ${b.peak}. Weakest trait: ${b.dump}.`,
    "",
    "Write ONE in-character reaction to the latest exchange below, under 120 characters.",
    "Point at something specific from it: a pitfall, a win, a risk, a pattern. Use the earlier conversation only to understand it.",
    "Use *asterisks* for physical actions. Write in the developer's language.",
    "Output only the reaction: no quotes, no preamble.",
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
  if (!text) return undefined;
  return text.length > MAX_REACTION_CHARS ? `${text.slice(0, MAX_REACTION_CHARS - 1).trimEnd()}…` : text;
}

type GeminiAnswer = ({ reaction: string } | { error: string }) & { conversationId?: string };

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

function askGemini(bin: string, model: string, prompt: string, cwd: string): GeminiAnswer {
  const args = ["-p", prompt, "--output-format", "json", "--model", model, "--mode", "plan", "--disable-slash-commands"];
  // Print mode must never sit waiting on a stdin that nobody writes to.
  const result = spawnSync(bin, args, { cwd, encoding: "utf8", input: "", timeout: GEMINI_TIMEOUT_MS });
  if ((result.error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") return { error: "agy CLI not found" };
  if (result.signal) return { error: `no answer in ${GEMINI_TIMEOUT_MS / 1000}s` };
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
  const reaction = typeof reply.response === "string" ? cleanReaction(reply.response) : undefined;
  return reaction ? { reaction, conversationId } : { error: "empty reply", conversationId };
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

export function reactWithGemini(
  assistantMessage: string,
  userMessage: string,
  runtime: GeminiReactRuntime = {},
): string | undefined {
  const companion = loadCompanion();
  if (!companion) return undefined;
  const now = runtime.now ?? Date.now;
  const stateDir = buddyStateDir();
  const failureFile = join(stateDir, ".gemini_failure.json");
  // Empty on purpose: agy loads no project context and its read-only tools find nothing.
  const cwd = join(stateDir, "gemini-cwd");
  mkdirSync(cwd, { recursive: true });

  let error = recentFailure(failureFile, now());
  if (error === undefined) {
    const earlier = runtime.transcriptPath
      ? earlierConversation(runtime.transcriptPath, [assistantMessage, userMessage])
      : "";
    const prompt = buildPrompt(companion, assistantMessage, userMessage, earlier);
    const answer = askGemini(runtime.bin ?? "agy", loadConfig().geminiModel, prompt, cwd);
    if (answer.conversationId) {
      forgetConversation(answer.conversationId, runtime.agyDir ?? join(homedir(), ".gemini", "antigravity-cli"));
    }
    if ("reaction" in answer) {
      saveReaction(answer.reaction, "turn", "gemini");
      return answer.reaction;
    }
    error = answer.error;
    writeFileSync(failureFile, JSON.stringify({ at: now(), error }));
  }

  const sleeping = `Sleeping, brain not responding. ${error}`;
  saveReaction(sleeping, "turn", "gemini-error");
  return sleeping;
}

if (import.meta.main) {
  try {
    reactWithGemini(process.argv[2] ?? "", process.argv[3] ?? "", { transcriptPath: process.argv[4] || undefined });
  } catch {
    // Detached from the hook: nobody is waiting for an exit code.
  }
  process.exit(0);
}
