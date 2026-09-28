import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";

const HOOKS_DIR = resolve(import.meta.dir, "..", "..", "hooks");
const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { force: true, recursive: true });
});

/** Runs a hook wrapper with a fake bun first on PATH; true when the wrapper started it. */
function startsBun(hook: string, config: object | undefined): boolean {
  const root = mkdtempSync(join(tmpdir(), "coding-buddy-wrapper-"));
  dirs.push(root);
  const stateDir = join(root, "buddy-state");
  const binDir = join(root, "bin");
  const marker = join(root, "bun-started");
  mkdirSync(stateDir);
  mkdirSync(binDir);
  writeFileSync(join(stateDir, "status.json"), JSON.stringify({ name: "Moth", species: "octopus" }));
  if (config) writeFileSync(join(stateDir, "config.json"), JSON.stringify(config, null, 2));
  writeFileSync(join(binDir, "bun"), `#!/bin/sh\ntouch "${marker}"\n`);
  chmodSync(join(binDir, "bun"), 0o755);

  const result = spawnSync("bash", [join(HOOKS_DIR, hook)], {
    encoding: "utf8",
    env: { CLAUDE_CONFIG_DIR: root, HOME: root, PATH: `${binDir}:/usr/bin:/bin` },
    input: JSON.stringify({ prompt: "hi Moth", tool_input: { file_path: "/tmp/a.ts" } }),
  });
  expect(result.status).toBe(0);
  return existsSync(marker);
}

describe("canned-only hook wrappers", () => {
  for (const hook of ["file-type-react.sh", "name-react.sh"]) {
    test(`${hook} does not start bun when canned reactions are off`, () => {
      expect(startsBun(hook, { cannedReactions: false })).toBe(false);
    });

    test(`${hook} starts bun when canned reactions are on or unset`, () => {
      expect(startsBun(hook, { cannedReactions: true })).toBe(true);
      expect(startsBun(hook, undefined)).toBe(true);
    });
  }
});
