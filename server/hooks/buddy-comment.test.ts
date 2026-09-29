import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { spawnSync } from "child_process";
import { handleBuddyComment, sweepStaleSessionFiles } from "./buddy-comment.ts";

function makeStateDir(): string {
  return mkdtempSync(join(tmpdir(), "coding-buddy-comment-"));
}

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { force: true, recursive: true });
});

describe("buddy comment Stop hook", () => {
  test("writes the latest hidden comment, records a turn, and spawns slow work", () => {
    const stateDir = makeStateDir();
    dirs.push(stateDir);
    writeFileSync(join(stateDir, "status.json"), "{}");
    writeFileSync(join(stateDir, "events.json"), JSON.stringify({ turns: 2, kept: true }));

    const spawned: Array<{ script: string; args: string[] }> = [];
    const result = handleBuddyComment(
      JSON.stringify({
        last_assistant_message: "first <!-- buddy: old --> second <!-- buddy: ship it -->",
        last_user_message: "please finish",
      }),
      {
        now: () => 1_700_000_000_123,
        sessionId: "session1",
        spawnDetached: (script, args) => spawned.push({ script, args }),
        stateDir,
      },
    );

    expect(result).toEqual({ comment: "ship it", source: "comment", updated: true });
    expect(JSON.parse(readFileSync(join(stateDir, "reaction.session1.json"), "utf8"))).toEqual({
      reaction: "ship it",
      timestamp: 1_700_000_000_123,
      reason: "turn",
      source: "comment",
    });
    expect(JSON.parse(readFileSync(join(stateDir, "events.json"), "utf8"))).toMatchObject({
      turns: 3,
      kept: true,
    });
    expect(spawned).toEqual([
      { script: "server/award-xp.ts", args: ["turn"] },
      { script: "server/consolidate.ts", args: ["first <!-- buddy: old --> second <!-- buddy: ship it -->", "please finish"] },
    ]);
  });

  test("ignores malformed stdin", () => {
    const stateDir = makeStateDir();
    dirs.push(stateDir);
    writeFileSync(join(stateDir, "status.json"), "{}");

    const result = handleBuddyComment("{nope", {
      spawnDetached: () => {
        throw new Error("should not spawn");
      },
      stateDir,
    });

    expect(result).toEqual({ source: "none", updated: false });
    expect(existsSync(join(stateDir, "reaction.default.json"))).toBe(false);
  });

  test("exits silently when the state directory is missing", () => {
    const stateDir = join(tmpdir(), `coding-buddy-missing-${Date.now()}`);

    const result = handleBuddyComment(
      JSON.stringify({ last_assistant_message: "<!-- buddy: hidden -->" }),
      { stateDir },
    );

    expect(result).toEqual({ source: "none", updated: false });
    expect(existsSync(stateDir)).toBe(false);
  });

  test("F1: a fresh buddy_react tool reaction is not clobbered", () => {
    const stateDir = makeStateDir();
    dirs.push(stateDir);
    writeFileSync(join(stateDir, "status.json"), "{}");
    writeFileSync(join(stateDir, "events.json"), "{}");
    const toolTs = 1_700_000_000_000;
    writeFileSync(
      join(stateDir, "reaction.session1.json"),
      JSON.stringify({
        reaction: "*tool wrote this*",
        timestamp: toolTs,
        reason: "turn",
        source: "tool",
      }),
    );
    const originalFile = readFileSync(join(stateDir, "reaction.session1.json"), "utf8");

    const spawned: Array<{ script: string; args: string[] }> = [];
    const result = handleBuddyComment(
      JSON.stringify({
        last_assistant_message: "no comment here, just an empty reply",
        last_user_message: "go",
      }),
      {
        now: () => toolTs + 5_000,
        sessionId: "session1",
        spawnDetached: (script, args) => spawned.push({ script, args }),
        stateDir,
      },
    );

    // F5: bookkeeping does NOT run when the tool already wrote a reaction
    // this turn. Main never credited a turn without a comment, and we
    // do not silently change that economy.
    expect(result.updated).toBe(false);
    expect(spawned).toEqual([]);
    // File is byte-for-byte unchanged.
    expect(readFileSync(join(stateDir, "reaction.session1.json"), "utf8")).toBe(originalFile);
  });

  test("hands the bubble to the detached brain script when no comment is emitted", () => {
    const stateDir = makeStateDir();
    dirs.push(stateDir);
    writeFileSync(join(stateDir, "status.json"), JSON.stringify({ species: "blob" }));
    writeFileSync(join(stateDir, "events.json"), "{}");

    const spawned: Array<{ script: string; args: string[] }> = [];
    const result = handleBuddyComment(
      JSON.stringify({
        last_assistant_message: "a perfectly ordinary reply with no comment",
        last_user_message: "go",
        transcript_path: "/tmp/session.jsonl",
      }),
      {
        now: () => 1_700_000_000_000,
        random: () => 0,
        sessionId: "session1",
        spawnDetached: (script, args) => spawned.push({ script, args }),
        stateDir,
      },
    );

    expect(result).toEqual({ source: "claude", updated: false });
    expect(spawned[0]).toEqual({
      script: "server/brain-react.ts",
      args: ["a perfectly ordinary reply with no comment", "go", "/tmp/session.jsonl"],
    });
    expect(existsSync(join(stateDir, "reaction.session1.json"))).toBe(false);
    expect(JSON.parse(readFileSync(join(stateDir, "events.json"), "utf8")).turns).toBe(1);
  });

  test("reports Gemini as the bubble's source when the brain is agy", () => {
    const stateDir = makeStateDir();
    dirs.push(stateDir);
    writeFileSync(join(stateDir, "status.json"), JSON.stringify({ species: "blob" }));
    writeFileSync(join(stateDir, "config.json"), JSON.stringify({ brain: "agy" }));

    const result = handleBuddyComment(
      JSON.stringify({ last_assistant_message: "no comment", last_user_message: "go" }),
      { now: () => 1_700_000_000_000, random: () => 0, sessionId: "session1", spawnDetached: () => {}, stateDir },
    );

    expect(result).toEqual({ source: "gemini", updated: false });
  });

  // F1: a tool reaction from a LONG turn (>5min) survives the stop hook.
  // Old wall-clock freshness design clobbered this; the per-turn sentinel
  // design does not.
  test("F1 long-turn: tool reaction from t=0 still on disk at t=5min", () => {
    const stateDir = makeStateDir();
    dirs.push(stateDir);
    writeFileSync(join(stateDir, "status.json"), JSON.stringify({ species: "blob" }));
    const toolTs = 1_700_000_000_000;
    writeFileSync(
      join(stateDir, "reaction.session1.json"),
      JSON.stringify({
        reaction: "*tool wrote this on a long turn*",
        timestamp: toolTs,
        reason: "turn",
        source: "tool",
      }),
    );
    const original = readFileSync(join(stateDir, "reaction.session1.json"), "utf8");

    const result = handleBuddyComment(
      JSON.stringify({
        last_assistant_message: "no comment here",
        last_user_message: "go",
      }),
      {
        now: () => toolTs + 5 * 60_000,
        sessionId: "session1",
        spawnDetached: () => {},
        stateDir,
      },
    );

    expect(result.updated).toBe(false);
    expect(readFileSync(join(stateDir, "reaction.session1.json"), "utf8")).toBe(original);
  });

  // F2: a future-dated tool timestamp is treated as untrusted (clock-skewed
  // garbage) and the brain is asked for a new line.
  test("F2 future-clock: 5-min future tool timestamp is not adopted", () => {
    const stateDir = makeStateDir();
    dirs.push(stateDir);
    writeFileSync(join(stateDir, "status.json"), JSON.stringify({ species: "blob" }));
    const now = 1_700_000_000_000;
    const future = now + 5 * 60_000;
    writeFileSync(
      join(stateDir, "reaction.session1.json"),
      JSON.stringify({
        reaction: "*future-dated tool*",
        timestamp: future,
        reason: "turn",
        source: "tool",
      }),
    );

    const result = handleBuddyComment(
      JSON.stringify({
        last_assistant_message: "no comment",
        last_user_message: "go",
      }),
      {
        now: () => now,
        random: () => 0,
        sessionId: "session1",
        spawnDetached: () => {},
        stateDir,
      },
    );

    expect(result).toEqual({ source: "claude", updated: false });
  });

  // F5: 10 short turns inside a 30s cooldown window produce ONE
  // turn-counter increment, not 10. Main's contract.
  test("F5 cooldown: 10 rapid-fire turns yield events.turns === 1", () => {
    const stateDir = makeStateDir();
    dirs.push(stateDir);
    writeFileSync(join(stateDir, "status.json"), JSON.stringify({ species: "blob" }));
    writeFileSync(join(stateDir, "events.json"), JSON.stringify({ turns: 0 }));

    const base = 1_700_000_000_000;
    for (let i = 0; i < 10; i++) {
      handleBuddyComment(
        JSON.stringify({
          last_assistant_message: "turn " + i + " no comment",
          last_user_message: "go",
        }),
        {
          now: () => base + i * 1_000,
          random: () => 0,
          sessionId: "session1",
          spawnDetached: () => {},
          stateDir,
        },
      );
    }
    const events = JSON.parse(readFileSync(join(stateDir, "events.json"), "utf8"));
    expect(events.turns).toBe(1);
  });
});

describe("cross-session buddy_react adoption", () => {
  test("adopts a fresh tool reaction written under a different session id", () => {
    const stateDir = mkdtempSync(join(tmpdir(), "buddy-xsession-"));
    dirs.push(stateDir);
    writeFileSync(join(stateDir, "status.json"), JSON.stringify({ name: "Cobalt", species: "pikachu" }));
    // buddy_react wrote here (MCP server's session id)
    writeFileSync(
      join(stateDir, "reaction.OTHERSID.json"),
      JSON.stringify({ reaction: "*ears twitch*", timestamp: Date.now(), reason: "turn", source: "tool" }),
    );

    const result = handleBuddyComment(
      JSON.stringify({ last_assistant_message: "hello", session_id: "MYSID" }),
      { stateDir, sessionId: "MYSID", now: () => Date.now(), spawnDetached: () => {} } as never,
    );

    // The pool must NOT have clobbered it...
    expect(result.source).toBe("tool");
    // ...and it must be readable from THIS session's file, which the
    // statusline is the only thing that reads.
    const own = JSON.parse(readFileSync(join(stateDir, "reaction.MYSID.json"), "utf8"));
    expect(own.reaction).toBe("*ears twitch*");
    expect(own.source).toBe("tool");
  });
});

describe("duplicate Stop hook invocations", () => {
  test("a second invocation in the same turn does not clobber the adopted reaction", () => {
    const stateDir = mkdtempSync(join(tmpdir(), "buddy-dup-"));
    dirs.push(stateDir);
    writeFileSync(join(stateDir, "status.json"), JSON.stringify({ name: "Cobalt", species: "pikachu" }));
    writeFileSync(
      join(stateDir, "reaction.MYSID.json"),
      JSON.stringify({ reaction: "*ears flick*", timestamp: Date.now(), reason: "turn", source: "tool" }),
    );

    const input = JSON.stringify({ last_assistant_message: "hi", session_id: "MYSID" });
    const runtime = { stateDir, sessionId: "MYSID", now: () => Date.now(), spawnDetached: () => {} } as never;

    // Duplicate registrations mean the hook runs several times per turn.
    handleBuddyComment(input, runtime);
    handleBuddyComment(input, runtime);
    const third = handleBuddyComment(input, runtime);

    expect(third.source).toBe("tool");
    const own = JSON.parse(readFileSync(join(stateDir, "reaction.MYSID.json"), "utf8"));
    expect(own.reaction).toBe("*ears flick*");
    expect(own.source).toBe("tool");
  });
});

describe("adoption age ceiling", () => {
  test("does not adopt a stale cross-session tool reaction on a fresh session", () => {
    const stateDir = mkdtempSync(join(tmpdir(), "buddy-stale-"));
    dirs.push(stateDir);
    writeFileSync(join(stateDir, "status.json"), JSON.stringify({ name: "Cobalt", species: "pikachu" }));
    // Older than the statusline would ever render, and from another session.
    writeFileSync(
      join(stateDir, "reaction.OTHERSID.json"),
      JSON.stringify({
        reaction: "*from an ancient turn*",
        timestamp: Date.now() - 3_600_000,
        reason: "turn",
        source: "tool",
      }),
    );

    // Brand-new session: no .last_stop_hook marker exists yet.
    const result = handleBuddyComment(
      JSON.stringify({ last_assistant_message: "hi", session_id: "NEWSID" }),
      { stateDir, sessionId: "NEWSID", now: () => Date.now(), spawnDetached: () => {} } as never,
    );

    expect(result.source).not.toBe("tool");
    expect(existsSync(join(stateDir, "reaction.NEWSID.json")) &&
      JSON.parse(readFileSync(join(stateDir, "reaction.NEWSID.json"), "utf8")).reaction)
      .not.toBe("*from an ancient turn*");
  });
});

describe("stale session file sweep", () => {
  const NOW = 1_800_000_000_000;
  const DAY = 24 * 60 * 60_000;

  function file(dir: string, name: string, ageMs: number, isDir = false): string {
    const path = join(dir, name);
    if (isDir) mkdirSync(path);
    else writeFileSync(path, "x");
    utimesSync(path, (NOW - ageMs) / 1000, (NOW - ageMs) / 1000);
    return path;
  }

  test("drops a session idle for a week and tmp leftovers, keeps live sessions and status line reactions", () => {
    const dir = makeStateDir();
    dirs.push(dir);
    const kept = [
      file(dir, "status.json", 30 * DAY),
      file(dir, ".session_start.live1234", 30 * DAY),
      file(dir, ".render.live1234", 8 * DAY),
      file(dir, ".last_stop_hook.live1234", 60_000),
      file(dir, ".render.live1234.tmp.99", 5 * 60_000),
      file(dir, "reaction.gone5678.json", 30 * DAY),
      file(dir, ".last_comment.gone5678", 30 * DAY),
    ];
    const dropped = [
      file(dir, ".session_start.gone5678", 30 * DAY),
      file(dir, ".substatus.gone5678", 8 * DAY),
      file(dir, ".substatus.gone5678.lock", 8 * DAY, true),
      file(dir, ".signals.gone5678", 8 * DAY),
      file(dir, ".move_gate.gone5678", 8 * DAY),
      file(dir, ".worry_told.gone5678", 8 * DAY),
      file(dir, ".shown_reaction.gone5678", 8 * DAY),
      file(dir, ".substatus.live1234.tmp", 2 * 60 * 60_000),
      file(dir, "reaction.live1234.json.tmp.1.2", 2 * 60 * 60_000),
    ];

    sweepStaleSessionFiles(dir, NOW);

    expect(kept.filter((path) => !existsSync(path))).toEqual([]);
    expect(dropped.filter((path) => existsSync(path))).toEqual([]);
  });

  test("the Stop hook runs the sweep", () => {
    const root = makeStateDir();
    dirs.push(root);
    const dir = join(root, "buddy-state");
    mkdirSync(dir);
    const stale = join(dir, ".render.gone5678");
    writeFileSync(stale, "x");
    utimesSync(stale, (Date.now() - 8 * DAY) / 1000, (Date.now() - 8 * DAY) / 1000);

    const result = spawnSync(process.execPath, [join(import.meta.dir, "buddy-comment.ts")], {
      env: { CLAUDE_CONFIG_DIR: root, HOME: root, PATH: process.env.PATH ?? "" },
      input: "{}",
    });

    expect(result.status).toBe(0);
    expect(existsSync(stale)).toBe(false);
  });
});
