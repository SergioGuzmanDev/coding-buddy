import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import type { Companion } from "../core/engine.ts";
import { reactWithBrain } from "./brain-react.ts";
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

function fakeCli(body: string): string {
  const bin = join(root, "fake-cli");
  writeFileSync(
    bin,
    `#!/bin/sh\necho call >> "${root}/calls.log"\nprintf '%s\\n' "$@" > "${root}/args.log"\n${body}\n`,
  );
  chmodSync(bin, 0o755);
  return bin;
}

/** agy that reports a spent quota, as it logs it, unless it runs under the given HOME. */
function spentUnlessHome(answeringHome: string): string {
  return `
    log=""; prev=""; for a in "$@"; do [ "$prev" = "--log-file" ] && log="$a"; prev="$a"; done
    if [ "$HOME" != "${answeringHome}" ]; then
      echo 'attempt 1 failed (RESOURCE_EXHAUSTED (code 429): Individual quota reached. Resets in 2h0m5s.)' > "$log"
      echo '{"error":"RESOURCE_EXHAUSTED (code 429): Individual quota reached."}'; exit 1
    fi
    cat "${root}/out.json"`;
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
  root = mkdtempSync(join(tmpdir(), "coding-buddy-brain-"));
  process.env.CLAUDE_CONFIG_DIR = root;
  process.env.CLAUDE_CODE_SESSION_ID = "sessionABCDEF";
  delete process.env.CODING_BUDDY_USER_ID;
  stateDir = join(root, "buddy-state");
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(stateDir, "config.json"), JSON.stringify({ brain: "agy", geminiModel: "gemini-test" }));
  saveCompanion(companion);
  // The real security would add each test's keychain to the user's own keychain search list.
  mkdirSync(join(root, "bin"));
  writeFileSync(join(root, "bin", "security"), "#!/bin/sh\nexit 0\n");
  chmodSync(join(root, "bin", "security"), 0o755);
  process.env.PATH = `${join(root, "bin")}:${process.env.PATH}`;
});

afterEach(() => {
  process.env = { ...savedEnv };
  rmSync(root, { force: true, recursive: true });
});

describe("brain-react with brain agy", () => {
  test("writes Gemini's first line as the turn bubble, asked read-only with the configured model", () => {
    writeFileSync(
      join(root, "out.json"),
      JSON.stringify({ response: '"*quacks* you dropped the null check"\nsecond line' }),
    );
    const bin = fakeCli(`cat "${root}/out.json"`);

    const reaction = reactWithBrain("I removed the null check in parse()", "clean this up", { bin });

    expect(reaction).toBe("*quacks* you dropped the null check");
    expect(bubble()).toMatchObject({ reaction, reason: "turn", source: "gemini" });
    const args = readFileSync(join(root, "args.log"), "utf8");
    expect(args).toContain("--mode\nplan\n");
    expect(args).toContain("--disable-slash-commands\n");
    expect(args).toContain("--model\ngemini-test\n");
    expect(args).toContain("I removed the null check in parse()");
  });

  test("says it is sleeping with Gemini's error and stops calling Gemini for ten minutes", () => {
    const bin = fakeCli(
      "echo 'stack trace noise' >&2; printf '\\033[31mManual authorization is required but the session is non-interactive. Please log in.\\033[0m\\n' >&2; exit 41",
    );
    const start = 1_700_000_000_000;
    const sleeping = "Sleeping, brain not responding. Manual authorization is required but the session is non-interactive.";

    expect(reactWithBrain("reply", "ask", { bin, now: () => start })).toBe(sleeping);
    expect(bubble()).toMatchObject({ reaction: sleeping, source: "gemini-error" });
    reactWithBrain("reply", "ask", { bin, now: () => start + 9 * 60_000 });
    expect(bubble().reaction).toBe(sleeping);
    expect(callCount()).toBe(1);

    reactWithBrain("reply", "ask", { bin, now: () => start + 11 * 60_000 });
    expect(callCount()).toBe(2);
  });

  test("gives Gemini the earlier spoken turns, without tool output, injected text or the latest exchange twice", () => {
    writeFileSync(join(root, "out.json"), JSON.stringify({ response: "*quacks*" }));
    const bin = fakeCli(`cat "${root}/out.json"`);
    const transcript = join(root, "session.jsonl");
    const entries = [
      { type: "user", message: { content: "EARLY-QUESTION about the parser" } },
      { type: "assistant", message: { content: [{ type: "text", text: "EARLY-ANSWER it is fine" }, { type: "tool_use", name: "Bash" }] } },
      { type: "user", message: { content: [{ type: "tool_result", content: "TOOL-OUTPUT" }] } },
      { type: "user", isMeta: true, message: { content: [{ type: "text", text: "INJECTED-SKILL" }] } },
      { type: "user", message: { content: [{ type: "text", text: "LATEST-ASK<system-reminder>REMINDER-TEXT</system-reminder>" }] } },
    ];
    writeFileSync(transcript, `cut-off line\n${entries.map((e) => JSON.stringify(e)).join("\n")}\n`);

    reactWithBrain("LATEST-REPLY", "LATEST-ASK", { bin, transcriptPath: transcript });

    const prompt = readFileSync(join(root, "args.log"), "utf8");
    expect(prompt).toContain("Developer: EARLY-QUESTION about the parser");
    expect(prompt).toContain("Assistant: EARLY-ANSWER it is fine");
    for (const hidden of ["TOOL-OUTPUT", "INJECTED-SKILL", "REMINDER-TEXT"]) expect(prompt).not.toContain(hidden);
    expect(prompt.split("LATEST-ASK")).toHaveLength(2);
  });

  test("stores the move and mood Gemini picks with its reaction, only when they are on the lists", () => {
    saveCompanion({ ...companion, bones: { ...companion.bones, species: "octopus" } });
    const answer = (response: string) => {
      writeFileSync(join(root, "out.json"), JSON.stringify({ response }));
      reactWithBrain("reply", "ask", { bin: fakeCli(`cat "${root}/out.json"`) });
      return JSON.parse(readFileSync(join(stateDir, "reaction.sessionA.json"), "utf8"));
    };

    expect(answer("coffee happy\n*sorbe su café* bien visto")).toMatchObject({ reaction: "*sorbe su café* bien visto", move: "coffee", mood: "happy" });
    const prompt = readFileSync(join(root, "args.log"), "utf8");
    expect(prompt).toContain("coffee (sips a coffee)");
    expect(prompt).toContain("angry (angry)");

    const invented = answer("moonwalk furious\n*hace moonwalk* genial");
    expect(invented.reaction).toBe("*hace moonwalk* genial");
    expect(invented.move).toBeUndefined();
    expect(invented.mood).toBeUndefined();
  });

  test("each mood it answers with adds to the mood it has been in lately, which the next prompt tells it", () => {
    saveCompanion({ ...companion, bones: { ...companion.bones, species: "octopus" } });
    writeFileSync(join(root, "out.json"), JSON.stringify({ response: "tap angry\n*tamborilea* otra vez lo mismo" }));
    const bin = fakeCli(`cat "${root}/out.json"`);
    const prompt = () => readFileSync(join(root, "args.log"), "utf8");

    reactWithBrain("reply", "ask", { bin });
    expect(prompt()).not.toContain("Lately you have been feeling");
    reactWithBrain("reply", "ask", { bin });
    expect(prompt()).not.toContain("Lately you have been feeling");
    reactWithBrain("reply", "ask", { bin });

    expect(prompt()).toContain("Lately you have been feeling angry.");
    expect(JSON.parse(readFileSync(join(stateDir, "background-mood.json"), "utf8")).mood).toBe("angry");
  });

  test("asks for a bubble of 3 or 4 short lines and keeps whatever comes back whole", () => {
    saveCompanion({ ...companion, bones: { ...companion.bones, species: "octopus" } });
    const first = `*sorbe su café* ${"muy bien visto, ".repeat(12).trim()}`;
    const second = "y el refresh a dos segundos se respeta.";
    writeFileSync(join(root, "out.json"), JSON.stringify({ response: `coffee happy\n${first}\n${second}` }));

    reactWithBrain("reply", "ask", { bin: fakeCli(`cat "${root}/out.json"`) });

    expect(bubble().reaction).toBe(`${first} ${second}`);
    expect(readFileSync(join(root, "args.log"), "utf8")).toContain("3 or 4 short lines, about 40 characters each");
  });

  test("tells Gemini the buddy is sweating or tired when the status line draws it that way", () => {
    writeFileSync(join(root, "out.json"), JSON.stringify({ response: "*quacks*" }));
    const bin = fakeCli(`cat "${root}/out.json"`);
    const prompt = (signals: string) => {
      writeFileSync(join(stateDir, ".signals.sessionA"), signals);
      reactWithBrain("reply", "ask", { bin });
      return readFileSync(join(root, "args.log"), "utf8");
    };

    expect(prompt("sweat=true context=80 tired=true\n")).toContain("You are sweating");
    expect(prompt("sweat=true context=80 tired=true\n")).toContain("You are tired");
    expect(prompt("sweat=false context=10 tired=false\n")).not.toMatch(/You are (sweating|tired)|context window/);
  });

  test("worries about the context window only a little until it is half full", () => {
    writeFileSync(join(root, "out.json"), JSON.stringify({ response: "*quacks*" }));
    const bin = fakeCli(`cat "${root}/out.json"`);
    const prompt = (context: number) => {
      writeFileSync(join(stateDir, ".signals.sessionA"), `sweat=true context=${context} tired=false\n`);
      reactWithBrain("reply", "ask", { bin });
      return readFileSync(join(root, "args.log"), "utf8");
    };

    const uneasy = prompt(45);
    expect(uneasy).toContain("slightly uneasy");
    expect(uneasy).not.toMatch(/nervous|sweating/);
    const nervous = prompt(59);
    expect(nervous).toContain("a bit nervous");
    expect(nervous).not.toContain("You are sweating");
    expect(prompt(60)).toContain("You are sweating");
  });

  test("brings up the context once per worry level it rises to, not on every reaction", () => {
    writeFileSync(join(root, "out.json"), JSON.stringify({ response: "*quacks*" }));
    const bin = fakeCli(`cat "${root}/out.json"`);
    const prompt = (signals: string) => {
      writeFileSync(join(stateDir, ".signals.sessionA"), signals);
      reactWithBrain("reply", "ask", { bin });
      return readFileSync(join(root, "args.log"), "utf8");
    };

    expect(prompt("sweat=true context=45 tired=false\n")).toContain("context window");
    expect(prompt("sweat=true context=47 tired=false\n")).not.toContain("context window");
    expect(prompt("sweat=true context=55 tired=false\n")).toContain("context window");
    expect(prompt("sweat=true context=58 tired=false\n")).not.toContain("context window");
    expect(prompt("sweat=false context=10 tired=false\n")).not.toContain("context window");
    expect(prompt("sweat=true context=45 tired=false\n")).toContain("context window");
  });

  test("asks the second account in its own home once the first one's quota is spent, until that quota resets", () => {
    const home = join(stateDir, "gemini-fallback-home");
    mkdirSync(join(home, ".gemini", "antigravity-cli"), { recursive: true });
    writeFileSync(join(home, ".gemini", "antigravity-cli", "antigravity-oauth-token"), "{}");
    writeFileSync(join(root, "out.json"), JSON.stringify({ response: "*quacks* from the second account" }));
    const bin = fakeCli(spentUnlessHome(home));
    let clock = 1_000_000;
    const react = () => reactWithBrain("reply", "ask", { bin, now: () => clock });

    react();
    expect(bubble().reaction).toBe("*quacks* from the second account");
    expect(callCount()).toBe(2);

    clock += (2 * 3600 + 4) * 1000;
    react();
    expect(callCount()).toBe(3);

    clock += 2000;
    react();
    expect(callCount()).toBe(5);
  });

  test("moves on to a third account while the first two are out of quota, and asks no spent one again", () => {
    const signIn = (name: string) => {
      const home = join(stateDir, name);
      mkdirSync(join(home, ".gemini", "antigravity-cli"), { recursive: true });
      writeFileSync(join(home, ".gemini", "antigravity-cli", "antigravity-oauth-token"), "{}");
      return home;
    };
    signIn("gemini-fallback-home");
    const third = signIn("gemini-fallback-home-2");
    writeFileSync(join(root, "out.json"), JSON.stringify({ response: "*quacks* from the third account" }));
    const bin = fakeCli(spentUnlessHome(third));
    let clock = 1_000_000;
    const react = () => reactWithBrain("reply", "ask", { bin, now: () => clock });

    react();
    expect(bubble().reaction).toBe("*quacks* from the third account");
    expect(callCount()).toBe(3);

    clock += 60_000;
    react();
    expect(callCount()).toBe(4);
  });

  test("asks no account while all are out of quota, and says when the first one comes back", () => {
    const home = join(stateDir, "gemini-fallback-home");
    mkdirSync(join(home, ".gemini", "antigravity-cli"), { recursive: true });
    writeFileSync(join(home, ".gemini", "antigravity-cli", "antigravity-oauth-token"), "{}");
    const bin = fakeCli(spentUnlessHome(join(root, "nobody")));
    let clock = 1_000_000;
    const react = () => reactWithBrain("reply", "ask", { bin, now: () => clock });

    react();
    expect(callCount()).toBe(2);

    clock += 11 * 60_000;
    react();
    expect(callCount()).toBe(2);
    expect(bubble().reaction).toStartWith("Sleeping, brain not responding. every agy account is out of quota until ");
  });

  test("gives the second account its own unlocked keychain before each call, so macOS never asks where to keep the token", () => {
    const home = join(stateDir, "gemini-fallback-home");
    mkdirSync(join(home, ".gemini", "antigravity-cli"), { recursive: true });
    writeFileSync(join(home, ".gemini", "antigravity-cli", "antigravity-oauth-token"), "{}");
    writeFileSync(join(root, "out.json"), JSON.stringify({ response: "*quacks*" }));
    const security = join(root, "bin", "security");
    writeFileSync(security, `#!/bin/sh\necho "$HOME $*" >> "${root}/security.log"\n[ "$1" = create-keychain ] && touch "$4"\nexit 0\n`);
    chmodSync(security, 0o755);
    const bin = fakeCli(spentUnlessHome(home));
    const keychain = join(home, "Library", "Keychains", "login.keychain-db");
    const securityCalls = () => readFileSync(join(root, "security.log"), "utf8").trim().split("\n");

    reactWithBrain("reply", "ask", { bin });
    expect(securityCalls()).toEqual([`${home} create-keychain -p  ${keychain}`, `${home} unlock-keychain -p  ${keychain}`]);

    reactWithBrain("reply", "ask", { bin });
    expect(securityCalls().slice(2)).toEqual([`${home} unlock-keychain -p  ${keychain}`]);
  });

  test("asks an account whose token agy keeps in its own keychain, and skips one whose keychain holds none", () => {
    const keychainAccount = (name: string, signedIn: boolean) => {
      const home = join(stateDir, name);
      mkdirSync(join(home, ".gemini", "antigravity-cli"), { recursive: true });
      mkdirSync(join(home, "Library", "Keychains"), { recursive: true });
      writeFileSync(join(home, "Library", "Keychains", "login.keychain-db"), "");
      if (signedIn) writeFileSync(join(home, "token-in-keychain"), "");
      return home;
    };
    keychainAccount("gemini-fallback-home", false);
    const third = keychainAccount("gemini-fallback-home-2", true);
    writeFileSync(join(root, "bin", "security"), `#!/bin/sh
if [ "$1" = find-generic-password ]; then
  [ "$2 $3 $4 $5" = "-s gemini -a antigravity" ] && [ "$6" = "$HOME/Library/Keychains/login.keychain-db" ] && [ -f "$HOME/token-in-keychain" ] && exit 0
  exit 44
fi
exit 0
`);
    writeFileSync(join(root, "out.json"), JSON.stringify({ response: "*quacks* from the keychain account" }));

    reactWithBrain("reply", "ask", { bin: fakeCli(spentUnlessHome(third)) });

    expect(bubble().reaction).toBe("*quacks* from the keychain account");
    expect(callCount()).toBe(2);
  });

  test("never runs a second account that is not signed in", () => {
    const home = join(stateDir, "gemini-fallback-home");
    mkdirSync(join(home, ".gemini", "antigravity-cli"), { recursive: true });

    reactWithBrain("reply", "ask", { bin: fakeCli(spentUnlessHome(home)) });

    expect(callCount()).toBe(1);
    expect(bubble().reaction).toContain("RESOURCE_EXHAUSTED");
  });

  test("says it is sleeping when the agy CLI is missing", () => {
    reactWithBrain("reply", "ask", { bin: join(root, "no-such-agy") });

    expect(bubble().reaction).toBe("Sleeping, brain not responding. agy CLI not found");
  });

  test("shows the first line of an error agy reports in its JSON reply", () => {
    writeFileSync(join(root, "out.json"), JSON.stringify({
      status: "ERROR",
      error: "invalid model selection: model flash is not recognized\nAvailable models:\n  Gemini 3.8 Flash (High)",
    }));
    const bin = fakeCli(`cat "${root}/out.json"; exit 1`);

    reactWithBrain("reply", "ask", { bin });

    expect(bubble().reaction).toBe("Sleeping, brain not responding. invalid model selection: model flash is not recognized");
  });

  test("points agy's log at one file in the state dir, replaced on every call", () => {
    const logFile = join(stateDir, ".gemini_last.log");
    writeFileSync(logFile, "PREVIOUS-RUN");
    writeFileSync(join(root, "out.json"), JSON.stringify({ response: "*quacks*" }));

    reactWithBrain("reply", "ask", { bin: fakeCli(`cat "${root}/out.json"`) });

    expect(readFileSync(join(root, "args.log"), "utf8")).toContain(`--log-file\n${logFile}\n`);
    expect(existsSync(logFile)).toBe(false);
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
    const bin = fakeCli(`cat "${root}/out.json"`);

    reactWithBrain("reply", "ask", { bin, agyDir });

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

    reactWithBrain("reply", "ask", { bin: fakeCli(`cat "${root}/out.json"`), agyDir });

    expect(existsSync(join(root, "victim.db"))).toBe(true);
  });
});

describe("brain-react with the default brain", () => {
  beforeEach(() => writeFileSync(join(stateDir, "config.json"), JSON.stringify({})));

  test("asks Claude with haiku, loading none of the user's settings, hooks, tools, MCP servers or thinking", () => {
    writeFileSync(join(root, "out.json"), JSON.stringify({ result: "*quacks* you dropped the null check", is_error: false }));

    const reaction = reactWithBrain("I removed the null check in parse()", "clean this up", { bin: fakeCli(`cat "${root}/out.json"`) });

    expect(reaction).toBe("*quacks* you dropped the null check");
    expect(bubble()).toMatchObject({ reaction, reason: "turn", source: "claude" });
    const args = readFileSync(join(root, "args.log"), "utf8");
    expect(args).toStartWith("-p\n");
    expect(args).toContain("I removed the null check in parse()");
    expect(args).toContain("--model\nhaiku\n");
    expect(args).toContain("--setting-sources\n\n");
    expect(args).toContain('--settings\n{"alwaysThinkingEnabled":false}\n');
    expect(args).toContain("--strict-mcp-config\n");
    expect(args).toContain("--tools\n\n");
    expect(args).toContain("--disable-slash-commands\n");
    expect(args).toContain("--no-session-persistence\n");
  });

  test("uses the configured Claude model", () => {
    writeFileSync(join(stateDir, "config.json"), JSON.stringify({ claudeModel: "sonnet" }));
    writeFileSync(join(root, "out.json"), JSON.stringify({ result: "*quacks*", is_error: false }));

    reactWithBrain("reply", "ask", { bin: fakeCli(`cat "${root}/out.json"`) });

    expect(readFileSync(join(root, "args.log"), "utf8")).toContain("--model\nsonnet\n");
  });

  test("says it is sleeping with Claude's error and stops calling it for ten minutes", () => {
    const bin = fakeCli(`echo '{"result":"Not logged in. Please run /login","is_error":true}'; exit 1`);
    const start = 1_700_000_000_000;
    const sleeping = "Sleeping, brain not responding. Not logged in.";

    expect(reactWithBrain("reply", "ask", { bin, now: () => start })).toBe(sleeping);
    expect(bubble()).toMatchObject({ reaction: sleeping, source: "claude-error" });
    reactWithBrain("reply", "ask", { bin, now: () => start + 9 * 60_000 });
    expect(callCount()).toBe(1);
  });

  test("says it is sleeping when the claude CLI is missing", () => {
    reactWithBrain("reply", "ask", { bin: join(root, "no-such-claude") });

    expect(bubble()).toMatchObject({ reaction: "Sleeping, brain not responding. claude CLI not found", source: "claude-error" });
  });
});
