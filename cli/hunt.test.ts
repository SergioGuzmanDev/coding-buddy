import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "child_process";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { loadCompanion } from "../server/state.ts";

const savedEnv = { ...process.env };
let root = "";

afterEach(() => {
  process.env = { ...savedEnv };
  if (root) rmSync(root, { force: true, recursive: true });
});

function hunt(...args: string[]) {
  root = mkdtempSync(join(tmpdir(), "coding-buddy-hunt-"));
  process.env.CLAUDE_CONFIG_DIR = root;
  return spawnSync(process.execPath, [join(import.meta.dir, "hunt.ts"), ...args], {
    env: { ...process.env, CLAUDE_CONFIG_DIR: root },
    input: "",
    encoding: "utf8",
  });
}

test("--species adopts a buddy of that species without asking anything", () => {
  const result = hunt("--species", "octopus", "--name", "Inky");

  expect(result.status).toBe(0);
  expect(loadCompanion()).toMatchObject({ name: "Inky", bones: { species: "octopus" } });
});

test("--species refuses a species that does not exist", () => {
  const result = hunt("--species", "kraken");

  expect(result.status).toBe(1);
  expect(result.stderr).toContain('Unknown species "kraken"');
  expect(loadCompanion()).toBeNull();
});
