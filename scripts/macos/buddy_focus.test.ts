import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const focusScript = join(import.meta.dir, "buddy_focus.py");
const temporaryDirectories: string[] = [];

// Stands in for the iterm2 package. Each step moves the focus, then reports a focus change or a poll timeout;
// a step without a title is a tab that closed before its title could be read.
const iterm2Stub = `
import asyncio
import json
import os
from types import SimpleNamespace

class RPCException(Exception):
    pass

class ScenarioDone(Exception):
    pass

class Session:
    def __init__(self, step):
        self.session_id = step["id"]
        self.title = step.get("title")

    async def async_get_variable(self, name):
        if self.title is None:
            raise RPCException("SESSION_NOT_FOUND")
        return self.title

steps = json.loads(os.environ["FOCUS_STEPS"])
focused = [Session(steps.pop(0))]

class App:
    async def async_refresh_focus(self):
        pass

    @property
    def current_terminal_window(self):
        return SimpleNamespace(current_tab=SimpleNamespace(current_session=focused[0]))

async def async_get_app(connection):
    return App()

class FocusMonitor:
    def __init__(self, connection):
        pass

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False

    async def async_get_next_update(self):
        if not steps:
            raise ScenarioDone()
        step = steps.pop(0)
        focused[0] = Session(step)
        if step["event"] == "poll":
            raise asyncio.TimeoutError()
        return step

def run_forever(main):
    try:
        asyncio.run(main(None))
    except ScenarioDone:
        pass
`;

function runFocusScript(steps: Record<string, string>[]) {
  const home = mkdtempSync(join(tmpdir(), "coding-buddy-focus-"));
  temporaryDirectories.push(home);
  mkdirSync(join(home, ".claude-buddy"));
  writeFileSync(join(home, "iterm2.py"), iterm2Stub);
  const result = spawnSync(
    "python3",
    ["-I", "-c", "import runpy, sys; sys.path.insert(0, sys.argv[1]); runpy.run_path(sys.argv[2], run_name='__main__')", home, focusScript],
    { env: { ...process.env, HOME: home, FOCUS_STEPS: JSON.stringify(steps) }, encoding: "utf8" },
  );
  const read = (name: string) => readFileSync(join(home, ".claude-buddy", name), "utf8");
  return { result, focusedSession: read("focused-session"), focusedTitle: read("focused-title") };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a tab that closes while it is being read leaves the script recording the tab focused after it", () => {
  const { result, focusedSession, focusedTitle } = runFocusScript([
    { id: "ONE", title: "✳ one" },
    { id: "GONE", event: "focus" },
    { id: "THREE", title: "✳ three", event: "poll" },
  ]);

  expect(result.stderr).toBe("");
  expect(focusedSession).toBe("THREE");
  expect(focusedTitle).toBe("✳ three");
});
