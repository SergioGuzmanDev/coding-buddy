import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import type { Companion } from "../core/engine.ts";
import { reactWithGemini } from "./gemini-react.ts";
import { saveCompanion } from "./state.ts";

const companion: Companion = {
  bones: {
    rarity: "common",
    species: "duck",
    eye: "°",
    hat: "none",
    shiny: false,
    stats: { DEBUGGING: 50, PATIENCE: 50, CHAOS: 50, WISDOM: 50, SNARK: 50 },
    peak: "SNARK",
    dump: "PATIENCE",
  },
  name: "Daffodil",
  personality: "dry wit",
  hatchedAt: 1,
  userId: "u",
};

let root: string;
let stateDir: string;
const savedEnv = { ...process.env };

function fakeGemini(body: string): string {
  const bin = join(root, "fake-gemini");
  writeFileSync(
    bin,
    `#!/bin/sh\necho call >> "${root}/calls.log"\nprintf '%s\\n' "$@" > "${root}/args.log"\n${body}\n`,
  );
  chmodSync(bin, 0o755);
  return bin;
}

function callCount(): number {
  try {
    return readFileSync(join(root, "calls.log"), "utf8").trim().split("\n").length;
  } catch {
    return 0;
  }
}

function bubble(): { reaction: string; reason: string; source: string } {
  return JSON.parse(readFileSync(join(stateDir, "reaction.sessionA.json"), "utf8"));
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "coding-buddy-gemini-"));
  process.env.CLAUDE_CONFIG_DIR = root;
  process.env.CLAUDE_CODE_SESSION_ID = "sessionABCDEF";
  delete process.env.CODING_BUDDY_USER_ID;
  stateDir = join(root, "buddy-state");
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(stateDir, "config.json"), JSON.stringify({ geminiModel: "gemini-test" }));
  saveCompanion(companion);
});

afterEach(() => {
  process.env = { ...savedEnv };
  rmSync(root, { force: true, recursive: true });
});

describe("gemini-react", () => {
  test("writes Gemini's first line as the turn bubble, asked read-only with the configured model", () => {
    writeFileSync(
      join(root, "out.json"),
      JSON.stringify({ response: '"*quacks* you dropped the null check"\nsecond line' }),
    );
    const bin = fakeGemini(`cat "${root}/out.json"`);

    const reaction = reactWithGemini("I removed the null check in parse()", "clean this up", { bin });

    expect(reaction).toBe("*quacks* you dropped the null check");
    expect(bubble()).toMatchObject({ reaction, reason: "turn", source: "gemini" });
    const args = readFileSync(join(root, "args.log"), "utf8");
    expect(args).toContain("--mode\nplan\n");
    expect(args).toContain("--disable-slash-commands\n");
    expect(args).toContain("--model\ngemini-test\n");
    expect(args).toContain("I removed the null check in parse()");
  });

  test("says it is sleeping with Gemini's error and stops calling Gemini for ten minutes", () => {
    const bin = fakeGemini(
      "echo 'stack trace noise' >&2; printf '\\033[31mManual authorization is required but the session is non-interactive. Please log in.\\033[0m\\n' >&2; exit 41",
    );
    const start = 1_700_000_000_000;
    const sleeping = "Sleeping, brain not responding. Manual authorization is required but the session is non-interactive.";

    expect(reactWithGemini("reply", "ask", { bin, now: () => start })).toBe(sleeping);
    expect(bubble()).toMatchObject({ reaction: sleeping, source: "gemini-error" });
    reactWithGemini("reply", "ask", { bin, now: () => start + 9 * 60_000 });
    expect(bubble().reaction).toBe(sleeping);
    expect(callCount()).toBe(1);

    reactWithGemini("reply", "ask", { bin, now: () => start + 11 * 60_000 });
    expect(callCount()).toBe(2);
  });

  test("gives Gemini the earlier spoken turns, without tool output, injected text or the latest exchange twice", () => {
    writeFileSync(join(root, "out.json"), JSON.stringify({ response: "*quacks*" }));
    const bin = fakeGemini(`cat "${root}/out.json"`);
    const transcript = join(root, "session.jsonl");
    const entries = [
      { type: "user", message: { content: "EARLY-QUESTION about the parser" } },
      { type: "assistant", message: { content: [{ type: "text", text: "EARLY-ANSWER it is fine" }, { type: "tool_use", name: "Bash" }] } },
      { type: "user", message: { content: [{ type: "tool_result", content: "TOOL-OUTPUT" }] } },
      { type: "user", isMeta: true, message: { content: [{ type: "text", text: "INJECTED-SKILL" }] } },
      { type: "user", message: { content: [{ type: "text", text: "LATEST-ASK<system-reminder>REMINDER-TEXT</system-reminder>" }] } },
    ];
    writeFileSync(transcript, `cut-off line\n${entries.map((e) => JSON.stringify(e)).join("\n")}\n`);

    reactWithGemini("LATEST-REPLY", "LATEST-ASK", { bin, transcriptPath: transcript });

    const prompt = readFileSync(join(root, "args.log"), "utf8");
    expect(prompt).toContain("Developer: EARLY-QUESTION about the parser");
    expect(prompt).toContain("Assistant: EARLY-ANSWER it is fine");
    for (const hidden of ["TOOL-OUTPUT", "INJECTED-SKILL", "REMINDER-TEXT"]) expect(prompt).not.toContain(hidden);
    expect(prompt.split("LATEST-ASK")).toHaveLength(2);
  });

  test("says it is sleeping when the agy CLI is missing", () => {
    reactWithGemini("reply", "ask", { bin: join(root, "no-such-agy") });

    expect(bubble().reaction).toBe("Sleeping, brain not responding. agy CLI not found");
  });

  test("shows the first line of an error agy reports in its JSON reply", () => {
    writeFileSync(join(root, "out.json"), JSON.stringify({
      status: "ERROR",
      error: "invalid model selection: model flash is not recognized\nAvailable models:\n  Gemini 3.8 Flash (High)",
    }));
    const bin = fakeGemini(`cat "${root}/out.json"; exit 1`);

    reactWithGemini("reply", "ask", { bin });

    expect(bubble().reaction).toBe("Sleeping, brain not responding. invalid model selection: model flash is not recognized");
  });

  test("deletes the conversation agy stored for the call and nothing else", () => {
    const id = "7cc3f07a-428a-4241-b904-1538fd46a1de";
    const mine = "11111111-2222-3333-4444-555555555555";
    const agyDir = join(root, "agy");
    for (const dir of ["conversations", "presence", `brain/${id}`]) mkdirSync(join(agyDir, dir), { recursive: true });
    for (const conv of [id, mine]) writeFileSync(join(agyDir, "conversations", `${conv}.db`), "");
    writeFileSync(join(agyDir, "presence", `${id}.lock`), "");
    const index = new Database(join(agyDir, "conversation_summaries.db"));
    index.run("CREATE TABLE conversation_summaries (conversation_id text PRIMARY KEY)");
    index.run("INSERT INTO conversation_summaries VALUES (?), (?)", [id, mine]);
    index.close();
    writeFileSync(join(root, "out.json"), JSON.stringify({ status: "SUCCESS", response: "*quacks*", conversation_id: id }));
    const bin = fakeGemini(`cat "${root}/out.json"`);

    reactWithGemini("reply", "ask", { bin, agyDir });

    expect(readdirSync(join(agyDir, "conversations"))).toEqual([`${mine}.db`]);
    expect(existsSync(join(agyDir, "brain", id))).toBe(false);
    expect(existsSync(join(agyDir, "presence", `${id}.lock`))).toBe(false);
    const rows = new Database(join(agyDir, "conversation_summaries.db")).query("SELECT conversation_id FROM conversation_summaries").all();
    expect(rows).toEqual([{ conversation_id: mine }]);
  });

  test("ignores a conversation id that is not a plain UUID", () => {
    const agyDir = join(root, "agy");
    mkdirSync(join(agyDir, "conversations"), { recursive: true });
    writeFileSync(join(root, "victim.db"), "keep me");
    writeFileSync(join(root, "out.json"), JSON.stringify({ response: "*quacks*", conversation_id: "../../victim" }));

    reactWithGemini("reply", "ask", { bin: fakeGemini(`cat "${root}/out.json"`), agyDir });

    expect(existsSync(join(root, "victim.db"))).toBe(true);
  });
});
