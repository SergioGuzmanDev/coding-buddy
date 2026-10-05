import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { STATUS_MOODS } from "./art.ts";
import { currentBackgroundMood, describeMoods, feelMood, HALF_LIFE_MS, readBackgroundMood, soothe } from "./background-mood.ts";

const minute = 60_000;
let stateDir: string;

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), "coding-buddy-mood-"));
});

afterEach(() => {
  rmSync(stateDir, { force: true, recursive: true });
});

describe("background mood", () => {
  test("one reaction's mood leaves the buddy calm, a second in a row colors it until the feeling fades", () => {
    feelMood(stateDir, "angry", 0);
    expect(currentBackgroundMood(stateDir, 0)).toBe("");

    const { until } = feelMood(stateDir, "angry", minute)!;
    expect(currentBackgroundMood(stateDir, minute)).toBe("angry");
    expect(currentBackgroundMood(stateDir, until - 1)).toBe("angry");
    expect(currentBackgroundMood(stateDir, until)).toBe("");
    expect(until - minute).toBeGreaterThan(20 * minute);
  });

  test("being made angry four times in a row keeps it angry for over an hour", () => {
    for (let i = 0; i < 4; i++) feelMood(stateDir, "angry", i * minute);

    expect(currentBackgroundMood(stateDir, 3 * minute + HALF_LIFE_MS)).toBe("angry");
  });

  test("the strongest feeling colors it, and a happier stretch takes over as the old one fades", () => {
    for (let i = 0; i < 3; i++) feelMood(stateDir, "angry", i * minute);
    for (let i = 1; i <= 2; i++) feelMood(stateDir, "happy", i * 10 * minute);
    expect(currentBackgroundMood(stateDir, 20 * minute)).toBe("angry");

    feelMood(stateDir, "happy", 30 * minute);
    expect(currentBackgroundMood(stateDir, 30 * minute)).toBe("happy");
  });

  test("a pet halves the bad feelings and adds happiness, so petting cheers it up", () => {
    feelMood(stateDir, "angry", 0);
    feelMood(stateDir, "angry", 0);
    expect(currentBackgroundMood(stateDir, 0)).toBe("angry");

    soothe(stateDir, 0);
    expect(currentBackgroundMood(stateDir, 0)).toBe("");
    soothe(stateDir, 0);
    expect(currentBackgroundMood(stateDir, 0)).toBe("happy");
  });

  test("the /buddy card tells the mood it is in lately and the color of every mood", () => {
    expect(describeMoods(stateDir, 0)).toContain("**Lately:** calm, in its own color");

    feelMood(stateDir, "angry", 0);
    feelMood(stateDir, "angry", 0);
    const angry = describeMoods(stateDir, 0);
    expect(angry).toContain("**Lately:** angry, 🟥 red, until about ");
    for (const [mood, { looks }] of Object.entries(STATUS_MOODS)) expect(angry).toContain(`| ${mood} | ${looks} |`);
    expect(angry).toContain("| calm | its own color |");
    expect(describeMoods(stateDir, 10 * HALF_LIFE_MS)).toContain("**Lately:** calm");
  });

  test("ignores a feeling it has no color for", () => {
    expect(feelMood(stateDir, "furious", 0)).toBeUndefined();
    expect(readBackgroundMood(stateDir).scores).toEqual({});
  });

  test("the buddy_pet tool soothes it, and buddy_show tells the mood", async () => {
    const configDir = mkdtempSync(join(tmpdir(), "coding-buddy-pet-"));
    const petStateDir = join(configDir, "buddy-state");
    mkdirSync(petStateDir, { recursive: true });
    feelMood(petStateDir, "angry", Date.now());
    feelMood(petStateDir, "angry", Date.now());
    const client = new Client({ name: "background-mood-test", version: "1" });
    try {
      await client.connect(new StdioClientTransport({
        command: process.execPath,
        args: [join(import.meta.dir, "index.ts")],
        env: { ...process.env, CLAUDE_CONFIG_DIR: configDir, CLAUDE_CODE_SESSION_ID: "pet" } as Record<string, string>,
      }));
      await client.callTool({ name: "buddy_pet", arguments: {} });
      const scores = JSON.parse(readFileSync(join(petStateDir, "background-mood.json"), "utf8")).scores;
      expect(scores.angry).toBeLessThan(1.1);
      expect(scores.happy).toBeGreaterThan(0.9);
      const shown = await client.callTool({ name: "buddy_show", arguments: {} });
      const text = (shown.content as { type: string; text: string }[])[0].text;
      expect(text).toContain("### Mood");
      expect(text).toContain("**Lately:** calm");
    } finally {
      await client.close();
      rmSync(configDir, { force: true, recursive: true });
    }
  }, 30_000);
});
