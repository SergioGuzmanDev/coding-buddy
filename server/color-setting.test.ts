import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { loadConfig, saveColor, saveConfig, saveUnsetConfig } from "./state.ts";

let root: string;
const savedEnv = { ...process.env };

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "coding-buddy-color-"));
  process.env.CLAUDE_CONFIG_DIR = root;
  delete process.env.CODING_BUDDY_USER_ID;
});

afterEach(() => {
  process.env = { ...savedEnv };
  rmSync(root, { force: true, recursive: true });
});

test("saveColor stores #RRGGBB, adds a missing #, rejects anything else and resets", () => {
  expect(saveColor("b8b196")?.color).toBe("#B8B196");
  expect(saveColor("orange")).toBeNull();
  expect(loadConfig().color).toBe("#B8B196");

  saveColor("reset");

  expect(loadConfig().color).toBeUndefined();
});

test("reactions default to the best agy Flash model", () => {
  expect(loadConfig().geminiModel).toBe("gemini-3.8-flash-high");
});

test("saveUnsetConfig saves only the settings the config file does not have yet", () => {
  expect(saveUnsetConfig({ slim: "bubble", expanded: true })).toEqual(["slim", "expanded"]);
  expect(loadConfig()).toMatchObject({ slim: "bubble", expanded: true });

  saveConfig({ slim: false });
  expect(saveUnsetConfig({ slim: "bubble", subStatusInline: true })).toEqual([]);
  expect(loadConfig()).toMatchObject({ slim: false });
});
