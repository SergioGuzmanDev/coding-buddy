import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { handleFileTypeReact } from "./file-type-react.ts";
import { handleMoodReact } from "./mood-react.ts";
import { handleNameReact } from "./name-react.ts";
import { handleReact } from "./react.ts";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { force: true, recursive: true });
});

function cannedOffState(status: Record<string, unknown>): string {
  const stateDir = mkdtempSync(join(tmpdir(), "coding-buddy-canned-"));
  dirs.push(stateDir);
  writeFileSync(join(stateDir, "status.json"), JSON.stringify(status));
  writeFileSync(join(stateDir, "config.json"), JSON.stringify({ cannedReactions: false }));
  return stateDir;
}

const runtime = (stateDir: string) => ({
  now: () => 1_700_000_000_123,
  random: () => 0,
  sessionId: "session1",
  spawnDetached: () => {},
  stateDir,
});

function bubbleWritten(stateDir: string): boolean {
  const status = JSON.parse(readFileSync(join(stateDir, "status.json"), "utf8"));
  return existsSync(join(stateDir, "reaction.session1.json")) || status.reaction !== undefined;
}

describe("cannedReactions false", () => {
  test("react still awards XP and shifts mood but writes no pool line", () => {
    const stateDir = cannedOffState({ species: "robot", name: "buddy" });
    const spawned: string[] = [];

    const result = handleReact(JSON.stringify({ tool_response: "exception: cannot compile" }), {
      ...runtime(stateDir),
      clock: () => ({ day: 25, dayOfWeek: 3, hour: 12, month: 7, nowSeconds: 1_700_000_000 }),
      spawnDetached: (script) => spawned.push(script),
    });

    expect(result.updated).toBe(false);
    expect(bubbleWritten(stateDir)).toBe(false);
    expect(spawned).toEqual(["server/award-xp.ts", "server/shift-mood.ts"]);
  });

  test("file-type-react writes no pool line", () => {
    const stateDir = cannedOffState({ species: "blob" });

    handleFileTypeReact(JSON.stringify({ file_path: "src/widget.js" }), runtime(stateDir));

    expect(bubbleWritten(stateDir)).toBe(false);
  });

  test("name-react writes no pool line", () => {
    const stateDir = cannedOffState({ name: "buddy", species: "dragon" });

    handleNameReact(JSON.stringify({ prompt: "hey BUDDY, help" }), runtime(stateDir));

    expect(bubbleWritten(stateDir)).toBe(false);
  });

  test("mood-react still counts the mood but writes no pool line", () => {
    const stateDir = cannedOffState({ species: "cat" });

    handleMoodReact(JSON.stringify({ prompt: "why is this broken" }), runtime(stateDir));

    expect(bubbleWritten(stateDir)).toBe(false);
    expect(JSON.parse(readFileSync(join(stateDir, "events.json"), "utf8"))).toEqual({ mood_frustrated: 1 });
  });
});
