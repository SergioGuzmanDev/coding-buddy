import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const script = join(import.meta.dir, "toggle-expanded.sh");
const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { force: true, recursive: true });
});

test("toggle-expanded flips expanded on and off and keeps the rest of the config", () => {
  const configDir = mkdtempSync(join(tmpdir(), "coding-buddy-toggle-"));
  dirs.push(configDir);
  const config = join(configDir, "buddy-state", "config.json");
  mkdirSync(join(configDir, "buddy-state"));
  writeFileSync(config, JSON.stringify({ subStatusInline: true }));
  const toggle = () => spawnSync("/bin/bash", [script], { env: { HOME: configDir, CLAUDE_CONFIG_DIR: configDir } });

  toggle();
  expect(JSON.parse(readFileSync(config, "utf8"))).toEqual({ subStatusInline: true, expanded: true });
  toggle();
  expect(JSON.parse(readFileSync(config, "utf8"))).toEqual({ subStatusInline: true, expanded: false });
});
