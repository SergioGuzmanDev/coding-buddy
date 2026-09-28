import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { displayWidth } from "../server/art.ts";

const temporaryDirectories: string[] = [];
const statuslineScript = join(import.meta.dir, "buddy-status.sh");
const chromeReserve = Number(readFileSync(statuslineScript, "utf8").match(/^CHROME_RESERVE=([0-9]+)/m)?.[1] ?? 0);

function createStatuslineFixture(config: Record<string, unknown>) {
  const configDir = mkdtempSync(join(tmpdir(), "coding-buddy-substatus-"));
  temporaryDirectories.push(configDir);
  const stateDir = join(configDir, "buddy-state");
  mkdirSync(stateDir);
  writeFileSync(join(stateDir, "config.json"), JSON.stringify(config));
  writeFileSync(join(stateDir, "status.json"), JSON.stringify({
    name: "Nimbus",
    rarity: "common",
    stars: "",
    shiny: false,
    reaction: "",
    achievement: "",
    level: 1,
    mood: "focused",
    frames: ["  art"],
    frameSequence: [0],
  }));
  return { configDir, stateDir };
}

function runStatusline(
  configDir: string,
  input = "{}\n",
  columns = "80",
  envOverrides: Record<string, string> = {},
) {
  return spawnSync("bash", [statuslineScript], {
    env: {
      ...process.env,
      CLAUDE_CONFIG_DIR: configDir,
      CLAUDE_CODE_SESSION_ID: "",
      TMUX_PANE: "",
      BUDDY_STATUSLINE_ROWS: "50",
      BUDDY_STATUSLINE_COLS: columns,
        BUDDY_STATUSLINE_ROWS: "50",
      TERM: "xterm-256color",
      NO_COLOR: "",
      BUDDY_SHELL: "",
      ...envOverrides,
    },
    input,
    stdout: "pipe",
    stderr: "pipe",
  });
}

async function waitFor(condition: () => boolean, timeoutMs = 3000) {
  const attempts = Math.ceil(timeoutMs / 50);
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (condition()) return;
    await Bun.sleep(50);
  }
  throw new Error(`condition was not met within ${timeoutMs}ms`);
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});
describe("buddy statusline colors", () => {
  test("uses rarity color for the name, stars, and sprite", () => {
    const configDir = mkdtempSync(join(tmpdir(), "coding-buddy-statusline-"));
    temporaryDirectories.push(configDir);
    const stateDir = join(configDir, "buddy-state");
    mkdirSync(stateDir);
    writeFileSync(join(stateDir, "config.json"), JSON.stringify({ theme: "dark" }));
    writeFileSync(join(stateDir, "status.json"), JSON.stringify({
      name: "Nimbus",
      rarity: "uncommon",
      stars: "★★",
      shiny: false,
      reaction: "",
      achievement: "",
      level: 1,
      mood: "focused",
      frames: ["  art\n (°°)"],
      frameSequence: [0],
    }));
    writeFileSync(join(stateDir, "reaction.default.json"), JSON.stringify({
      reaction: "colored *bubble [x]",
      timestamp: Date.now(),
    }));

    const result = Bun.spawnSync(["bash", join(import.meta.dir, "buddy-status.sh")], {
      env: {
        ...process.env,
        CLAUDE_CONFIG_DIR: configDir,
        CLAUDE_CODE_SESSION_ID: "",
        TMUX_PANE: "",
        BUDDY_FAKE_NOW: "0",
        BUDDY_STATUSLINE_COLS: "80",
        BUDDY_STATUSLINE_ROWS: "50",
        TERM: "xterm-256color",
        NO_COLOR: "",
        BUDDY_SHELL: "",
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const output = result.stdout.toString();
    const green = "\x1b[38;2;78;186;101m";
    const greenLines = output.split("\n").filter((line) => line.includes(green));

    expect(result.exitCode).toBe(0);
    expect(greenLines.length).toBeGreaterThanOrEqual(2);
    expect(greenLines.some((line) => line.includes("Nimbus ★★"))).toBe(true);
    expect(greenLines.some((line) => line.includes("(°°)"))).toBe(true);
    expect(greenLines.some((line) => /\.[-]{4,}\./.test(line))).toBe(true);
    expect(output).toContain("colored *bubble [x]");
  });

  test.each([40, 60, 80, 120])("keeps the shared card inside %i columns", (columns) => {
    const { configDir, stateDir } = createStatuslineFixture({ reactionTTL: 900 });
    writeFileSync(join(stateDir, "status.json"), JSON.stringify({
      name: "Nimbus",
      rarity: "uncommon",
      stars: "★★",
      shiny: false,
      reaction: "",
      achievement: "milestone with 🏆🌈 wide emoji and enough words to wrap across multiple lines",
      level: 1,
      mood: "focused",
      frames: [" .----.\n(°  °)\n(    )\n `----'"],
      frameSequence: [0],
    }));
    writeFileSync(join(stateDir, "reaction.default.json"), JSON.stringify({
      reaction: "hello from buddy with several words and 🏆 wide emoji",
      timestamp: Date.now(),
    }));

    const result = runStatusline(configDir, "{}\n", String(columns));
    const plain = result.stdout.toString().replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
    const lines = plain.split("\n").filter(Boolean);

    expect(result.status).toBe(0);
    expect(lines.every((line) => line.length <= columns)).toBe(true);
    expect(result.stdout.toString().split("\n").filter(Boolean).every((line) => displayWidth(line) <= columns)).toBe(true);
    const budget = columns >= 40 ? Math.min(columns, Math.max(40, columns - chromeReserve)) : columns;
    expect(result.stdout.toString().split("\n").filter(Boolean).every((line) => displayWidth(line) <= budget)).toBe(true);
    expect(Math.max(...lines.map((line) => displayWidth(line)))).toBe(budget);
    const connectorLine = result.stdout.toString().split("\n").find((line) => line.includes("--"));
    expect(connectorLine).toContain("\x1b[38;2;78;186;101m");
    expect(lines.some((line) => /\|.*\|-- /.test(line))).toBe(true);
    expect(plain).toContain("Nimbus ★★");
  });

  test("honors a signed width adjustment and NO_COLOR", () => {
    const { configDir, stateDir } = createStatuslineFixture({
      reactionTTL: 900,
      statuslineWidthAdjust: -10,
    });
    writeFileSync(join(stateDir, "reaction.default.json"), JSON.stringify({
      reaction: "width override",
      timestamp: Date.now(),
    }));

    const result = runStatusline(configDir, "{}\n", "80", { NO_COLOR: "1" });
    const lines = result.stdout.toString().split("\n").filter(Boolean);

    expect(result.status).toBe(0);
    expect(lines.every((line) => displayWidth(line) <= 56)).toBe(true);
  });

  test("BUDDY_STATUSLINE_COLS wins over exported COLUMNS", () => {
    const { configDir, stateDir } = createStatuslineFixture({ reactionTTL: 900 });
    writeFileSync(join(stateDir, "status.json"), JSON.stringify({
      name: "Nimbus",
      rarity: "uncommon",
      stars: "★★",
      shiny: false,
      reaction: "",
      achievement: "milestone with 🏆🌈 wide emoji and enough words to wrap across multiple lines",
      level: 1,
      mood: "focused",
      frames: [" .----.\n(°  °)\n(    )\n `----'"],
      frameSequence: [0],
    }));
    writeFileSync(join(stateDir, "reaction.default.json"), JSON.stringify({
      reaction: "hello from buddy with several words and 🏆 wide emoji",
      timestamp: Date.now(),
    }));

    const result = runStatusline(configDir, "{}\n", "60", { COLUMNS: "200" });
    const lines = result.stdout.toString().split("\n").filter(Boolean);

    expect(result.status).toBe(0);
    expect(lines.every((line) => displayWidth(line) <= 46)).toBe(true);
  });

  test("exported COLUMNS wins over a wider controlling PTY", () => {
    const { configDir, stateDir } = createStatuslineFixture({ reactionTTL: 900 });
    writeFileSync(join(stateDir, "status.json"), JSON.stringify({
      name: "Nimbus",
      rarity: "uncommon",
      stars: "★★",
      shiny: false,
      reaction: "",
      achievement: "milestone with 🏆🌈 wide emoji and enough words to wrap across multiple lines",
      level: 1,
      mood: "focused",
      frames: [" .----.\n(°  °)\n(    )\n `----'"],
      frameSequence: [0],
    }));
    writeFileSync(join(stateDir, "reaction.default.json"), JSON.stringify({
      reaction: "hello from buddy with several words and 🏆 wide emoji",
      timestamp: Date.now(),
    }));

    const env = {
      ...process.env,
      CLAUDE_CONFIG_DIR: configDir,
      CLAUDE_CODE_SESSION_ID: "",
      TMUX_PANE: "",
      BUDDY_FAKE_NOW: "0",
      BUDDY_STATUSLINE_COLS: process.stdin.isTTY ? "" : "60",
        BUDDY_STATUSLINE_ROWS: "50",
      COLUMNS: "60",
      TERM: "xterm-256color",
      LC_ALL: "C",
      NO_COLOR: "",
      BUDDY_SHELL: "",
    };
    const result = process.stdin.isTTY
      ? spawnSync("script", ["-q", "/dev/null", "bash", "-c", `stty cols 120 rows 24; bash ${statuslineScript} </dev/null`], {
        env,
        stdio: ["inherit", "pipe", "pipe"],
      })
      : spawnSync("bash", [statuslineScript], {
        env,
        input: "{}\n",
        stdout: "pipe",
        stderr: "pipe",
      });
    const lines = result.stdout.toString()
      .replace(/\r/g, "")
      .replace(/\^D/g, "")
      .replace(/\x08/g, "")
      .split("\n")
      .filter(Boolean);

    expect(result.status).toBe(0);
    expect(lines.every((line) => displayWidth(line) <= 46)).toBe(true);
  });

  test("invalid BUDDY_STATUSLINE_COLS values are ignored and fall through", () => {
    const { configDir, stateDir } = createStatuslineFixture({ reactionTTL: 900 });
    writeFileSync(join(stateDir, "status.json"), JSON.stringify({
      name: "Nimbus",
      rarity: "uncommon",
      stars: "★★",
      shiny: false,
      reaction: "",
      achievement: "milestone with 🏆🌈 wide emoji and enough words to wrap across multiple lines",
      level: 1,
      mood: "focused",
      frames: [" .----.\n(°  °)\n(    )\n `----'"],
      frameSequence: [0],
    }));
    writeFileSync(join(stateDir, "reaction.default.json"), JSON.stringify({
      reaction: "hello from buddy with several words and 🏆 wide emoji",
      timestamp: Date.now(),
    }));

    for (const override of ["0", "abc"]) {
      const result = runStatusline(configDir, "{}\n", "60", {
        BUDDY_STATUSLINE_COLS: override,
        BUDDY_STATUSLINE_ROWS: "50",
        COLUMNS: "60",
      });
      const lines = result.stdout.toString().split("\n").filter(Boolean);

      expect(result.status).toBe(0);
      expect(lines.every((line) => displayWidth(line) <= 46)).toBe(true);
    }
  });

  test("drops the shell bubble and tail when the panel is narrow", () => {
    const { configDir, stateDir } = createStatuslineFixture({ reactionTTL: 900 });
    writeFileSync(join(stateDir, "reaction.default.json"), JSON.stringify({
      reaction: "hello from buddy",
      timestamp: Date.now(),
    }));

    const result = runStatusline(configDir, "{}\n", "24");
    const plain = result.stdout.toString().replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
    const lines = plain.split("\n").filter(Boolean);

    expect(result.status).toBe(0);
    expect(lines.every((line) => line.length <= 24)).toBe(true);
    expect(lines.some((line) => /\|.*\|-- /.test(line))).toBe(false);
    expect(plain).not.toMatch(/^ *\.[-]{12,}\.$/m);
  });

  test("expires stale reactions and sweeps per-session reaction files", () => {
    const { configDir, stateDir } = createStatuslineFixture({ reactionTTL: 30 });
    const staleReaction = join(stateDir, "reaction.default.json");
    const staleComment = join(stateDir, ".last_comment.default");
    writeFileSync(staleReaction, JSON.stringify({
      reaction: "stale reaction",
      timestamp: Date.now() - 60_000,
    }));
    writeFileSync(staleComment, String(Math.floor(Date.now() / 1000) - 60));

    const result = runStatusline(configDir);
    const output = result.stdout.toString();

    expect(result.status).toBe(0);
    expect(output).not.toContain("stale reaction");
    expect(existsSync(staleReaction)).toBe(false);
    expect(existsSync(staleComment)).toBe(false);
    expect(output).not.toMatch(/^ *\.[-]{12,}\.$/m);
  });

  test("sweeps other sessions' expired reactions and keeps their fresh ones", () => {
    const { configDir, stateDir } = createStatuslineFixture({ reactionTTL: 30 });
    const stale = join(stateDir, "reaction.other1.json");
    const fresh = join(stateDir, "reaction.other2.json");
    writeFileSync(stale, JSON.stringify({ reaction: "old", timestamp: Date.now() - 60_000 }));
    writeFileSync(fresh, JSON.stringify({ reaction: "new", timestamp: Date.now() }));

    runStatusline(configDir);

    expect(existsSync(stale)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
  });

  test("uses a finite default TTL while honoring zero as permanent", () => {
    const defaultFixture = createStatuslineFixture({});
    const defaultReaction = join(defaultFixture.stateDir, "reaction.default.json");
    writeFileSync(defaultReaction, JSON.stringify({
      reaction: "default stale reaction",
      timestamp: Date.now() - 901_000,
    }));

    const defaultResult = runStatusline(defaultFixture.configDir);
    expect(defaultResult.stdout.toString()).not.toContain("default stale reaction");
    expect(existsSync(defaultReaction)).toBe(false);

    const permanentFixture = createStatuslineFixture({ reactionTTL: 0 });
    const permanentReaction = join(permanentFixture.stateDir, "reaction.default.json");
    writeFileSync(permanentReaction, JSON.stringify({
      reaction: "permanent reaction",
      timestamp: Date.now() - 901_000,
    }));

    const permanentResult = runStatusline(permanentFixture.configDir);
    expect(permanentResult.stdout.toString()).toContain("permanent reaction");
    expect(existsSync(permanentReaction)).toBe(true);
  });
});

describe("buddy sub-status cache", () => {
  test("returns immediately and refreshes the cache with the same stdin payload", async () => {
    const { configDir, stateDir } = createStatuslineFixture({
      subStatusCommand: "sleep 1; cat",
    });

    const input = '{"payload":"same-input"}\n';
    const started = performance.now();
    const first = runStatusline(configDir, input);
    const elapsedMs = performance.now() - started;

    expect(first.status).toBe(0);
    // Includes launching a fresh bash process; the one-second sub-command is
    // intentionally not part of this wall-clock measurement.
    expect(elapsedMs).toBeLessThan(1500);
    expect(existsSync(join(stateDir, ".substatus.default"))).toBe(false);

    for (let attempt = 0; attempt < 30; attempt++) {
      if (Bun.file(join(stateDir, ".substatus.default")).size > 0) break;
      await Bun.sleep(100);
    }

    expect(readFileSync(join(stateDir, ".substatus.default"), "utf8").trim()).toBe(input.trim());
    await Bun.sleep(200);
    const second = runStatusline(configDir, input);

    expect(second.stdout.toString()).toContain(input.trim());
  });

  test("uses one temp path and cleans it up after a failed refresh", async () => {
    const { configDir, stateDir } = createStatuslineFixture({
      subStatusCommand: "sleep 1; exit 1",
    });
    const tempFile = join(stateDir, ".substatus.default.tmp");
    const lockDir = join(stateDir, ".substatus.default.lock");

    expect(runStatusline(configDir).status).toBe(0);
    await waitFor(() => existsSync(tempFile));
    expect(readdirSync(stateDir).filter((name) => name.startsWith(".substatus.default.")).sort())
      .toEqual([".substatus.default.lock", ".substatus.default.tmp"]);

    await waitFor(() => !existsSync(tempFile) && !existsSync(lockDir));
    expect(existsSync(tempFile)).toBe(false);
    expect(readdirSync(stateDir).filter((name) => name.startsWith(".substatus.default.")).sort())
      .toEqual([]);
  });

  test("truncates cached sub-status rows to the adjusted budget", () => {
    const { configDir, stateDir } = createStatuslineFixture({
      reactionTTL: 900,
      subStatusCommand: "printf ignored",
    });
    writeFileSync(join(stateDir, "reaction.default.json"), JSON.stringify({
      reaction: "cached-bubble reaction 🏆 with enough words to wrap",
      timestamp: Date.now(),
    }));
    const cacheFile = join(stateDir, ".substatus.default");
    writeFileSync(cacheFile, "\u00a0[Timeout]\u00a0\uE0B0\u00a0💰\u00a0$143.14\u00a0session\u00a0\uE0B0\u00a0⏰\u00a04h\u00a054m\u00a0left\n");

    const result = runStatusline(configDir, "{}\n", "60");
    const lines = result.stdout.toString().split("\n").filter(Boolean);
    expect(result.stdout.toString()).toContain("cached-bubble");
    expect(result.stdout.toString()).toContain("reaction 🏆");

    expect(result.status).toBe(0);
    expect(lines.every((line) => displayWidth(line) <= 46)).toBe(true);
  });

  test("a muted buddy prints nothing", () => {
    const { configDir, stateDir } = createStatuslineFixture({});
    const status = JSON.parse(readFileSync(join(stateDir, "status.json"), "utf8"));
    writeFileSync(join(stateDir, "status.json"), JSON.stringify({ ...status, muted: true }));

    expect(runStatusline(configDir).stdout.toString()).toBe("");
  });

  test("the light theme darkens the rarity color", () => {
    const { configDir } = createStatuslineFixture({ theme: "light", statuslineDensity: "full" });

    expect(runStatusline(configDir).stdout.toString()).toContain("\x1b[38;2;90;90;90m  art");
  });

  test("a shiny buddy paints its art with the configured rainbowColors", () => {
    const { configDir, stateDir } = createStatuslineFixture({ rainbowColors: ["#010203"], statuslineDensity: "full" });
    const status = JSON.parse(readFileSync(join(stateDir, "status.json"), "utf8"));
    writeFileSync(join(stateDir, "status.json"), JSON.stringify({ ...status, shiny: true }));

    expect(runStatusline(configDir).stdout.toString()).toContain("\x1b[38;2;1;2;3m  art");
  });

  test("bubbleWidth and bubbleMargin size the speech bubble", () => {
    const dashes = (config: Record<string, unknown>, columns: string) => {
      const { configDir, stateDir } = createStatuslineFixture({ statuslineDensity: "full", ...config });
      writeFileSync(join(stateDir, "reaction.default.json"), JSON.stringify({ reaction: "word ".repeat(30), timestamp: Date.now() }));
      return runStatusline(configDir, "{}\n", columns).stdout.toString().match(/\.(-+)\./)![1].length;
    };

    expect(dashes({ bubbleWidth: 20 }, "120")).toBe(22);
    expect(dashes({ bubbleMargin: 8 }, "60") - dashes({ bubbleMargin: 10 }, "60")).toBe(2);
  });

  test("shows the level after the name once it is above 1", () => {
    const { configDir, stateDir } = createStatuslineFixture({ statuslineDensity: "full" });
    const status = JSON.parse(readFileSync(join(stateDir, "status.json"), "utf8"));
    writeFileSync(join(stateDir, "status.json"), JSON.stringify({ ...status, level: 3 }));

    expect(runStatusline(configDir).stdout.toString()).toContain("Nimbus [L3]");
  });

  test("takes the level from xp.json, which awarding XP updates, over the older copy in status.json", () => {
    const { configDir, stateDir } = createStatuslineFixture({ statuslineDensity: "full" });
    const status = JSON.parse(readFileSync(join(stateDir, "status.json"), "utf8"));
    writeFileSync(join(stateDir, "status.json"), JSON.stringify({ ...status, level: 3 }));
    const xpFile = join(stateDir, "xp.json");

    writeFileSync(xpFile, JSON.stringify({ totalXp: 900, level: 4 }, null, 2));
    expect(runStatusline(configDir).stdout.toString()).toContain("Nimbus [L4]");

    writeFileSync(xpFile, "{ half-written");
    expect(runStatusline(configDir).stdout.toString()).toContain("Nimbus [L3]");
  });

  test("truncates a sub-status row that is not valid UTF-8 to the budget", () => {
    const { configDir, stateDir } = createStatuslineFixture({ subStatusCommand: "printf ignored" });
    writeFileSync(join(stateDir, ".substatus.default"), Buffer.concat([Buffer.from([0xff]), Buffer.from(`${"A".repeat(200)}\n`)]));

    const row = runStatusline(configDir, "{}\n", "60").stdout.toString().split("\n").find((l) => l.includes("AAAA"));

    expect(row!.length).toBeLessThanOrEqual(46);
    expect(row!.match(/A+/)![0]).toHaveLength(45);
  });

  test("measures a sub-status OSC 8 link by its visible text only", () => {
    const { configDir, stateDir } = createStatuslineFixture({ subStatusCommand: "printf ignored" });
    const link = "\x1b]8;;https://github.com/ramarivera/coding-buddy/tree/main\x1b\\main\x1b]8;;\x1b\\";
    writeFileSync(join(stateDir, ".substatus.default"), `~/Repositories/app (${link}) • END-OF-LINE-MARK\n`);

    const out = runStatusline(configDir, "{}\n", "60").stdout.toString();

    expect(out).toContain(`(${link}) • END-OF-LINE-MARK`);
  });

  test("closes a sub-status OSC 8 link cut by the budget", () => {
    const { configDir, stateDir } = createStatuslineFixture({ subStatusCommand: "printf ignored" });
    const open = "\x1b]8;;https://example.org/branch\x1b\\";
    writeFileSync(join(stateDir, ".substatus.default"), `${"x".repeat(40)} (${open}feature-branch\x1b]8;;\x1b\\)\n`);

    const row = runStatusline(configDir, "{}\n", "60").stdout.toString().split("\n").find((l) => l.includes(open));

    expect(row).toContain(`${open}feat`);
    expect(row).not.toContain("feature-branch");
    expect(row!.split("\x1b]8;;").length - 1).toBe(2);
  });

  test("inline mode puts the buddy at the end of the sub-status row", () => {
    const { configDir, stateDir } = createStatuslineFixture({
      statuslineDensity: "minimal",
      subStatusInline: true,
      subStatusCommand: "printf ignored",
    });
    writeFileSync(join(stateDir, "reaction.default.json"), JSON.stringify({
      reaction: "a reaction far too long to fit in the room this narrow row leaves",
      timestamp: Date.now(),
    }));
    writeFileSync(join(stateDir, ".substatus.default"), "LEFT-SIDE-STATUS\n");

    const lines = runStatusline(configDir, "{}\n", "80").stdout.toString().split("\n").filter(Boolean);

    expect(lines).toHaveLength(1);
    expect(lines[0]).toStartWith("LEFT-SIDE-STATUS");
    expect(lines[0]).toContain("Nimbus");
    expect(lines[0]).toContain("…");
  });

  test("inline mode leaves a multi-line sub-status below the buddy", () => {
    const { configDir, stateDir } = createStatuslineFixture({
      statuslineDensity: "minimal",
      subStatusInline: true,
      subStatusCommand: "printf ignored",
    });
    writeFileSync(join(stateDir, ".substatus.default"), "LINE-ONE\nLINE-TWO\n");

    const lines = runStatusline(configDir, "{}\n", "80").stdout.toString().split("\n").filter(Boolean);

    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain("Nimbus");
    expect(lines[1]).toStartWith("LINE-ONE");
    expect(lines[2]).toStartWith("LINE-TWO");
  });

  test("inline mode falls back to two rows when the buddy does not fit", () => {
    const { configDir, stateDir } = createStatuslineFixture({
      statuslineDensity: "minimal",
      subStatusInline: true,
      subStatusCommand: "printf ignored",
    });
    writeFileSync(join(stateDir, ".substatus.default"), `${"W".repeat(60)}\n`);

    const lines = runStatusline(configDir, "{}\n", "80").stdout.toString().split("\n").filter(Boolean);

    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("Nimbus");
    expect(lines[1]).toStartWith("W".repeat(60));
  });

  test("clickToExpand links the name to coding-buddy://toggle", () => {
    const { configDir } = createStatuslineFixture({ statuslineDensity: "minimal", clickToExpand: true });

    const out = runStatusline(configDir, "{}\n", "80").stdout.toString();

    expect(out).toContain("\x1b]8;;coding-buddy://toggle\x1b\\Nimbus");
  });

  test("expanded shows the whole reaction and puts the name on the sub-status row", () => {
    const { configDir, stateDir } = createStatuslineFixture({
      statuslineDensity: "minimal",
      subStatusInline: true,
      expanded: true,
      subStatusCommand: "printf ignored",
    });
    const reaction = "a reaction far too long to fit in the room a single narrow row leaves";
    writeFileSync(join(stateDir, "reaction.default.json"), JSON.stringify({ reaction, timestamp: Date.now() }));
    writeFileSync(join(stateDir, ".substatus.default"), "LEFT-SIDE-STATUS\n");

    const lines = runStatusline(configDir, "{}\n", "120").stdout.toString().split("\n").filter(Boolean);

    expect(lines.length).toBeGreaterThan(2);
    expect(lines.at(-1)).toStartWith("LEFT-SIDE-STATUS");
    expect(lines.at(-1)).toContain("Nimbus");
    expect(lines.join("\n").split("Nimbus")).toHaveLength(2);
    for (const word of reaction.split(" ")) expect(lines.join(" ")).toContain(word);
  });

  test("expanded keeps the name on its own row when the sub-status leaves no room", () => {
    const { configDir, stateDir } = createStatuslineFixture({
      subStatusInline: true,
      expanded: true,
      subStatusCommand: "printf ignored",
    });
    writeFileSync(join(stateDir, ".substatus.default"), `${"W".repeat(100)}\n`);

    const lines = runStatusline(configDir, "{}\n", "120").stdout.toString().split("\n").filter(Boolean);

    expect(lines.at(-1)).toBe("W".repeat(100));
    expect(lines.at(-2)).toContain("Nimbus");
  });

  test("a configured color replaces the rarity color", () => {
    const { configDir } = createStatuslineFixture({ statuslineDensity: "minimal", color: "#4EBA65" });

    const out = runStatusline(configDir, "{}\n", "80").stdout.toString();

    expect(out).toContain("\x1b[38;2;78;186;101m");
    expect(out).not.toContain("\x1b[38;2;153;153;153m");
  });

  test("showRarity false drops the stars from the name", () => {
    const { configDir, stateDir } = createStatuslineFixture({ statuslineDensity: "minimal" });
    const status = JSON.parse(readFileSync(join(stateDir, "status.json"), "utf8"));
    writeFileSync(join(stateDir, "status.json"), JSON.stringify({ ...status, stars: "★" }));
    expect(runStatusline(configDir, "{}\n", "80").stdout.toString()).toContain("Nimbus ★");

    writeFileSync(join(stateDir, "config.json"), JSON.stringify({ statuslineDensity: "minimal", showRarity: false }));

    expect(runStatusline(configDir, "{}\n", "80").stdout.toString()).not.toContain("★");
  });

  test("animate false keeps the same frame whatever the clock says", () => {
    const { configDir, stateDir } = createStatuslineFixture({ statuslineDensity: "full" });
    const status = JSON.parse(readFileSync(join(stateDir, "status.json"), "utf8"));
    writeFileSync(join(stateDir, "status.json"), JSON.stringify({ ...status, frames: ["  art-A", "  art-B"], frameSequence: [0, 1] }));
    const at = (now: string) => runStatusline(configDir, "{}\n", "80", { BUDDY_FAKE_NOW: now }).stdout.toString();
    expect(at("1")).not.toBe(at("2"));

    writeFileSync(join(stateDir, "config.json"), JSON.stringify({ statuslineDensity: "full", animate: false }));

    expect(at("1")).toBe(at("2"));
    expect(at("1")).toContain("art-A");
  });

  test("animate focused moves only the iTerm2 session named in focused-session", () => {
    const { configDir, stateDir } = createStatuslineFixture({ statuslineDensity: "full", animate: "focused" });
    const status = JSON.parse(readFileSync(join(stateDir, "status.json"), "utf8"));
    writeFileSync(join(stateDir, "status.json"), JSON.stringify({ ...status, frames: ["  art-A", "  art-B"], frameSequence: [0, 1] }));
    writeFileSync(join(stateDir, "focused-session"), "AAA");
    const at = (now: string, session: string) =>
      runStatusline(configDir, "{}\n", "80", { BUDDY_FAKE_NOW: now, ITERM_SESSION_ID: session }).stdout.toString();

    expect(at("1", "w0t0p0:AAA")).not.toBe(at("2", "w0t0p0:AAA"));
    expect(at("1", "w0t1p0:BBB")).toBe(at("2", "w0t1p0:BBB"));
    expect(at("1", "")).not.toBe(at("2", ""));
  });

  describe("moves driven by the session", () => {
    const now = 1_700_000_000;
    const fixture = (status: Record<string, unknown>, config: Record<string, unknown> = {}) => {
      const made = createStatuslineFixture({ statuslineDensity: "full", ...config });
      const base = JSON.parse(readFileSync(join(made.stateDir, "status.json"), "utf8"));
      writeFileSync(join(made.stateDir, "status.json"), JSON.stringify({
        ...base, frames: ["  art-rest", "  art-tired", "  art-asleep", "  art-cheer"], frameSequence: [0], ...status,
      }));
      return made;
    };
    const render = (configDir: string, input: Record<string, unknown>, env: Record<string, string> = {}) =>
      runStatusline(configDir, JSON.stringify(input), "80", { BUDDY_FAKE_NOW: String(now), ...env }).stdout.toString();

    test("sweats from 40% of the context, the drop showing 4 seconds out of every 20", () => {
      const { configDir } = fixture({ sweat: { frames: ["  art-sweat"] } });
      const at = (seconds: number, pct = 40) =>
        render(configDir, { context_window: { used_percentage: pct } }, { BUDDY_FAKE_NOW: String(now + seconds) });

      expect(at(0)).toContain("art-sweat");
      expect(at(3)).toContain("art-sweat");
      expect(at(4)).toContain("art-rest");
      expect(at(19)).toContain("art-rest");
      expect(at(20)).toContain("art-sweat");
      expect(at(0, 39.9)).toContain("art-rest");
    });

    test("a frozen status line keeps the drop while sweating", () => {
      const { configDir } = fixture({ sweat: { frames: ["  art-sweat"] } }, { animate: false });

      expect(render(configDir, { context_window: { used_percentage: 40 } }, { BUDDY_FAKE_NOW: String(now + 10) })).toContain("art-sweat");
    });

    test("draws from the tired pool from 50% of the 5-hour limit", () => {
      const { configDir } = fixture({ tiredSequence: [1] });

      expect(render(configDir, { rate_limits: { five_hour: { used_percentage: 50 } } })).toContain("art-tired");
      expect(render(configDir, { rate_limits: { five_hour: { used_percentage: 49 } } })).toContain("art-rest");
    });

    test("falls asleep once the transcript has been quiet for five minutes, tired or not", () => {
      const { configDir } = fixture({ tiredSequence: [1], idleSequence: [2] });
      const transcript = join(configDir, "session.jsonl");
      writeFileSync(transcript, "{}\n");
      const input = { transcript_path: transcript, rate_limits: { five_hour: { used_percentage: 90 } } };

      utimesSync(transcript, now - 300, now - 300);
      expect(render(configDir, input)).toContain("art-asleep");
      utimesSync(transcript, now - 299, now - 299);
      expect(render(configDir, input)).toContain("art-tired");
    });

    test("acts out the move Gemini picked for 30 seconds after its reaction, if the move exists and it animates", () => {
      const { configDir, stateDir } = fixture({ moveSequences: { coffee: [3] } });
      // Expired reactions are swept by the real clock, so this test runs on it.
      const clock = Math.floor(Date.now() / 1000);
      const at = { BUDDY_FAKE_NOW: String(clock) };
      const reacted = (secondsAgo: number, move: string) => writeFileSync(join(stateDir, "reaction.default.json"),
        JSON.stringify({ reaction: "*sorbe*", timestamp: (clock - secondsAgo) * 1000, move }));

      reacted(29, "coffee");
      expect(render(configDir, {}, at)).toContain("art-cheer");
      reacted(30, "coffee");
      expect(render(configDir, {}, at)).toContain("art-rest");
      reacted(5, "moonwalk");
      expect(render(configDir, {}, at)).toContain("art-rest");

      reacted(5, "coffee");
      writeFileSync(join(stateDir, "config.json"), JSON.stringify({ statuslineDensity: "full", animate: "focused" }));
      writeFileSync(join(stateDir, "focused-session"), "AAA");
      expect(render(configDir, {}, { ...at, ITERM_SESSION_ID: "w0t1p0:BBB" })).toContain("art-rest");
    });

    describe("under animate focused, the move and its mood wait for 3 seconds of focus after the reaction", () => {
      const clock = Math.floor(Date.now() / 1000);
      const red = "\x1b[38;2;255;0;0m";
      const setup = () => {
        const made = fixture({ moveSequences: { coffee: [3, 1] }, moodColors: { angry: ["#FF0000"] } }, { animate: "focused" });
        const reaction = join(made.stateDir, "reaction.default.json");
        const focus = join(made.stateDir, "focused-session");
        const gate = join(made.stateDir, ".move_gate.default");
        writeFileSync(focus, "BBB");
        const react = (secondsAgo: number) => writeFileSync(reaction,
          JSON.stringify({ reaction: "*sorbe*", timestamp: (clock - secondsAgo) * 1000, move: "coffee", mood: "angry" }));
        const tick = (seconds: number, session = "w0t1p0:BBB") =>
          render(made.configDir, {}, { BUDDY_FAKE_NOW: String(clock + seconds), ITERM_SESSION_ID: session });
        const touch = (path: string, seconds: number) => utimesSync(path, clock + seconds, clock + seconds);
        return { ...made, reaction, focus, gate, react, tick, touch };
      };

      test("already focused when it arrives, it starts 3 seconds after the reaction and plays for 30", () => {
        const { reaction, focus, react, tick, touch } = setup();
        react(1);
        touch(focus, -100);
        touch(reaction, -1);

        expect(tick(0)).toContain("art-rest");
        expect(tick(0)).not.toContain(red);
        const started = tick(2);
        expect(started).toContain("art-cheer");
        expect(started).toContain(red);
        expect(tick(3)).toContain("art-tired");
        expect(tick(31)).toContain("art-tired");
        expect(tick(32)).toContain("art-rest");
      });

      test("focused after it arrives, it counts 3 seconds from the first focused render, without rewriting its state meanwhile", () => {
        const { reaction, focus, gate, react, tick, touch } = setup();
        react(10);
        touch(reaction, -10);
        touch(focus, -5);

        expect(tick(0)).toContain("art-rest");
        touch(gate, -4);
        expect(tick(2)).toContain("art-rest");
        expect(Math.round(statSync(gate).mtimeMs / 1000)).toBe(clock - 4);
        expect(tick(3)).toContain("art-cheer");
      });

      test("focus going away restarts the count, but not a move already playing", () => {
        const { reaction, focus, gate, react, tick, touch } = setup();
        react(10);
        touch(reaction, -10);
        touch(focus, -5);

        expect(tick(0)).toContain("art-rest");
        touch(gate, -3);
        touch(focus, -2);
        expect(tick(3)).toContain("art-rest");
        expect(tick(6)).toContain("art-cheer");

        touch(focus, 100);
        expect(tick(7)).toContain("art-tired");
      });

      test("where focus is not tracked, it plays at once as before", () => {
        const { stateDir, react, tick } = setup();
        react(1);

        expect(tick(0, "")).toContain("art-tired");
        writeFileSync(join(stateDir, "config.json"), JSON.stringify({ statuslineDensity: "full", animate: true }));
        expect(tick(0)).toContain("art-tired");
      });
    });

    test("paints the buddy, not its bubble, with the reaction's mood for 30 seconds, each color lasting 2 ticks", () => {
      const { configDir, stateDir } = fixture({ moodColors: { angry: ["#FF0000", ""] } });
      const clock = Math.floor(Date.now() / 1000);
      const reacted = (secondsAgo: number, mood: string) => {
        writeFileSync(join(stateDir, "reaction.default.json"),
          JSON.stringify({ reaction: "*se enfada*", timestamp: (clock - secondsAgo) * 1000, mood }));
        return render(configDir, {}, { BUDDY_FAKE_NOW: String(clock) });
      };
      const red = "\x1b[38;2;255;0;0m";
      const own = "\x1b[38;2;153;153;153m";

      const angry = reacted(1, "angry");
      expect(angry).toContain(`${red}  art-rest`);
      expect(angry).toContain(`${own}.---`);
      expect(reacted(2, "angry")).toContain(`${own}  art-rest`);
      expect(reacted(3, "angry")).toContain(`${own}  art-rest`);
      expect(reacted(4, "angry")).toContain(`${red}  art-rest`);
      expect(reacted(29, "angry")).toContain(`${red}  art-rest`);
      expect(reacted(30, "angry")).not.toContain(red);
      expect(reacted(1, "furious")).not.toContain(red);
    });

    test("records sweat, context and tiredness for gemini-react, writing only when that changes", () => {
      const { configDir, stateDir } = fixture({});
      const signals = join(stateDir, ".signals.default");

      render(configDir, { context_window: { used_percentage: 45 } }, { BUDDY_FAKE_NOW: String(now + 10) });
      expect(readFileSync(signals, "utf8")).toBe("sweat=true context=45 tired=false\n");

      utimesSync(signals, now - 100, now - 100);
      render(configDir, { context_window: { used_percentage: 45 } });
      expect(Math.round(statSync(signals).mtimeMs / 1000)).toBe(now - 100);

      render(configDir, { context_window: { used_percentage: 10 }, rate_limits: { five_hour: { used_percentage: 60 } } });
      expect(readFileSync(signals, "utf8")).toBe("sweat=false context=10 tired=true\n");
    });

    test("a finished turn moves nothing until its reaction, whose move shows in the same render as its text", () => {
      const { configDir, stateDir } = fixture({ celebrateSequence: [3, 3], moveSequences: { cigarette: [1] } });
      const clock = Math.floor(Date.now() / 1000);
      const at = { BUDDY_FAKE_NOW: String(clock) };
      writeFileSync(join(stateDir, ".last_stop_hook.default"), String(clock - 1));

      expect(render(configDir, {}, at)).toContain("art-rest");

      writeFileSync(join(stateDir, "reaction.default.json"),
        JSON.stringify({ reaction: "*da una calada*", timestamp: clock * 1000, move: "cigarette" }));
      const shown = render(configDir, {}, at);
      expect(shown).toContain("*da una calada*");
      expect(shown).toContain("art-tired");
    });
  });

  test("an unfocused session keeps no render until its sub-status cache exists", () => {
    const { configDir, stateDir } = createStatuslineFixture({
      animate: "focused",
      subStatusInline: true,
      subStatusCommand: "sleep 5",
    });
    const cache = join(stateDir, ".render.default");
    writeFileSync(join(stateDir, "focused-session"), "AAA");
    const tick = () => runStatusline(configDir, "{}\n", "80", { ITERM_SESSION_ID: "w0t1p0:BBB" });

    tick();
    expect(existsSync(cache)).toBe(false);

    writeFileSync(join(stateDir, ".substatus.default"), "LEFT-SIDE-STATUS\n");
    tick();
    expect(readFileSync(cache, "utf8")).toContain("LEFT-SIDE-STATUS");
  });

  test("an unfocused session reprints its render while Claude Code's input changes every tick", () => {
    const { configDir, stateDir } = createStatuslineFixture({ statuslineDensity: "minimal", animate: "focused" });
    const configFile = join(stateDir, "config.json");
    const reactionFile = join(stateDir, "reaction.default.json");
    const cache = join(stateDir, ".render.default");
    const focus = (session: string) => writeFileSync(join(stateDir, "focused-session"), session);
    const age = (path: string, seconds: number) => utimesSync(path, Date.now() / 1000 - seconds, Date.now() / 1000 - seconds);
    const cached = () => { writeFileSync(cache, "FROM-CACHE\n"); age(cache, 50); };
    const tick = (n: number) =>
      runStatusline(configDir, JSON.stringify({ cost: { total_duration_ms: n } }), "80", { ITERM_SESSION_ID: "w0t1p0:BBB" }).stdout.toString();
    focus("AAA");
    age(configFile, 100);

    cached();
    expect(tick(1)).toBe("FROM-CACHE\n");

    writeFileSync(reactionFile, JSON.stringify({ reaction: "NEW-REACTION", timestamp: Date.now() }));
    expect(tick(2)).toContain("NEW-REACTION");

    age(reactionFile, 100);
    cached();
    writeFileSync(configFile, readFileSync(configFile));
    expect(tick(3)).not.toContain("FROM-CACHE");

    age(configFile, 100);
    cached();
    focus("BBB");
    tick(4);
    focus("AAA");
    const afterFocus = tick(5);
    expect(afterFocus).not.toContain("FROM-CACHE");
    expect(readFileSync(cache, "utf8")).toBe(afterFocus);
  });

  test("bubble text is italic in the buddy color, not faint", () => {
    const { configDir, stateDir } = createStatuslineFixture({ statuslineDensity: "full", color: "#EEEEEE" });
    writeFileSync(join(stateDir, "reaction.default.json"), JSON.stringify({ reaction: "READABLE-TEXT", timestamp: Date.now() }));

    const row = runStatusline(configDir, "{}\n", "120").stdout.toString().split("\n").find((l) => l.includes("READABLE-TEXT"));

    expect(row).toMatch(/\x1b\[38;2;238;238;238m\|\x1b\[3m\s*READABLE-TEXT/);
    expect(row).not.toContain("\x1b[2;3m");
  });

  test("bubbleColor paints the bubble while the buddy keeps its own color", () => {
    const { configDir, stateDir } = createStatuslineFixture({ statuslineDensity: "full", color: "#EEEEEE", bubbleColor: "#A0A0A0" });
    writeFileSync(join(stateDir, "reaction.default.json"), JSON.stringify({ reaction: "MUTED-TEXT", timestamp: Date.now() }));
    const muted = "\x1b[38;2;160;160;160m";
    const buddy = "\x1b[38;2;238;238;238m";

    const lines = runStatusline(configDir, "{}\n", "120").stdout.toString().split("\n");

    expect(lines.find((l) => l.includes(".---"))).toContain(`${muted}.---`);
    expect(lines.find((l) => l.includes("MUTED-TEXT"))).toContain(`${muted}|\x1b[3m`);
    expect(lines.find((l) => l.includes("Nimbus"))).toContain(buddy);
  });

  test("bubbleColor paints the reaction in the one-row layout", () => {
    const { configDir, stateDir } = createStatuslineFixture({
      statuslineDensity: "minimal",
      subStatusInline: true,
      subStatusCommand: "printf ignored",
      color: "#EEEEEE",
      bubbleColor: "#A0A0A0",
    });
    writeFileSync(join(stateDir, "reaction.default.json"), JSON.stringify({ reaction: "short", timestamp: Date.now() }));
    writeFileSync(join(stateDir, ".substatus.default"), "LEFT\n");

    const row = runStatusline(configDir, "{}\n", "120").stdout.toString().split("\n")[0];

    expect(row).toContain("\x1b[38;2;238;238;238m  art Nimbus");
    expect(row).toContain('\x1b[38;2;160;160;160m │ "short"');
  });

  test("drops the art's blank top line in every frame, but keeps a hat line", () => {
    const { configDir, stateDir } = createStatuslineFixture({ statuslineDensity: "full" });
    const status = JSON.parse(readFileSync(join(stateDir, "status.json"), "utf8"));
    const render = (frames: string[], now: string) => {
      writeFileSync(join(stateDir, "status.json"), JSON.stringify({ ...status, frames, frameSequence: [0, 1] }));
      return runStatusline(configDir, "{}\n", "80", { BUDDY_FAKE_NOW: now }).stdout.toString().split("\n").filter(Boolean);
    };

    const resting = render(["            \n  BODY-A", "     o      \n  BODY-B"], "0");
    const blowing = render(["            \n  BODY-A", "     o      \n  BODY-B"], "1");
    expect(resting[0]).toContain("BODY-A");
    expect(blowing).toHaveLength(resting.length);

    const hatted = render(["    HAT     \n  BODY-A", "    HAT     \n  BODY-B"], "0");
    expect(hatted[0]).toContain("HAT");
  });

  test("uses the 15-second default and honors a numeric TTL override", async () => {
    const { configDir, stateDir } = createStatuslineFixture({
      subStatusCommand: "printf refreshed",
      subStatusRefreshSeconds: "invalid",
    });
    const cacheFile = join(stateDir, ".substatus.default");
    const oldDate = new Date(Date.now() - 10 * 1000);
    writeFileSync(cacheFile, "cached\n");
    utimesSync(cacheFile, oldDate, oldDate);

    expect(runStatusline(configDir).status).toBe(0);
    await Bun.sleep(200);
    expect(readFileSync(cacheFile, "utf8")).toBe("cached\n");

    writeFileSync(join(stateDir, "config.json"), JSON.stringify({
      subStatusCommand: "printf refreshed",
      subStatusRefreshSeconds: 5,
    }));
    expect(runStatusline(configDir).status).toBe(0);
    await waitFor(() => readFileSync(cacheFile, "utf8") === "refreshed");
  });
});

describe("slim layout", () => {
  const octopus = ["            \n   .----.   \n  ( o  o )  \n  (______)  \n  TENTACLES "];

  function render(config: Record<string, unknown>, reaction: string) {
    const { configDir, stateDir } = createStatuslineFixture({
      subStatusInline: true,
      expanded: true,
      clickToExpand: true,
      subStatusCommand: "printf ignored",
      slim: "tight",
      ...config,
    });
    const status = JSON.parse(readFileSync(join(stateDir, "status.json"), "utf8"));
    writeFileSync(join(stateDir, "status.json"), JSON.stringify({ ...status, level: 3, frames: octopus }));
    writeFileSync(join(stateDir, ".substatus.default"), "LEFT-SIDE-STATUS\n");
    writeFileSync(join(stateDir, "reaction.default.json"), JSON.stringify({ reaction, timestamp: Date.now() }));
    const raw = runStatusline(configDir, "{}\n", "150").stdout.toString();
    return { raw, plain: raw.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").split("\n").filter(Boolean) };
  }

  test("keeps the panel as tall as the art: no name row, and a long reaction beside it", () => {
    const reaction = "*Toma un café* mientras brilla en arcoíris; qué placer ver 7 mutaciones caer ante tests bien paridos, y además el refresh se respeta.";

    const { raw, plain } = render({}, reaction);

    expect(plain).toHaveLength(4);
    expect(plain.at(-1)).toStartWith("LEFT-SIDE-STATUS");
    expect(plain.at(-1)).toContain("TENTACLES");
    expect(raw).not.toContain("Nimbus");
    expect(raw).not.toContain("coding-buddy://toggle");
    for (const word of reaction.split(" ")) expect(plain.join(" ")).toContain(word);
    expect(plain[0]).toContain("/ *Toma");
    expect(plain[1]).toContain("|--");
  });

  test("keeps the bordered bubble for a reaction that fits on one line", () => {
    const { plain } = render({}, "hola");

    expect(plain).toHaveLength(4);
    expect(plain[0]).toContain(".---");
    expect(plain[1]).toContain("| hola ");
  });

  test("bubble keeps the borders, fitting a long reaction in two lines one row above the art", () => {
    const reaction = "*Toma un café* mientras brilla en arcoíris; qué placer ver 7 mutaciones caer ante tests bien paridos, y además el refresh se respeta.";

    const { raw, plain } = render({ slim: "bubble" }, reaction);

    expect(plain).toHaveLength(5);
    expect(plain[0]).toContain(".---");
    expect(plain[3]).toContain("'---");
    expect(plain[1]).toContain("| *Toma");
    expect(plain[2]).toContain("|--");
    expect(plain[2]).toContain("( o  o )");
    expect(plain.at(-1)).toStartWith("LEFT-SIDE-STATUS");
    expect(raw).not.toContain("Nimbus");
    for (const word of reaction.split(" ")) expect(plain.join(" ")).toContain(word);
  });

  test("bubble stays as tall as the art for a reaction that fits on one line", () => {
    const { plain } = render({ slim: "bubble" }, "hola");

    expect(plain).toHaveLength(4);
    expect(plain[1]).toContain("| hola ");
    expect(plain[2]).toContain("'---");
  });

  test("drops the name from the one-row buddy too", () => {
    const { raw } = render({ expanded: false, statuslineDensity: "minimal" }, "hola");

    expect(raw).toContain('"hola"');
    expect(raw).not.toContain("Nimbus");
    expect(raw).not.toContain("coding-buddy://toggle");
  });
});

describe("statusline density", () => {
  function createDensityFixture(
    density: string,
    overrides: Record<string, unknown> = {},
    statusOverrides: Record<string, unknown> = {},
  ) {
    const { configDir, stateDir } = createStatuslineFixture({
      statuslineDensity: density,
      ...overrides,
    });
    writeFileSync(join(stateDir, "status.json"), JSON.stringify({
      name: "Nimbus",
      rarity: "common",
      stars: "",
      shiny: false,
      reaction: (statusOverrides.reaction as string) ?? "",
      achievement: "",
      level: 1,
      mood: "focused",
      frames: statusOverrides.frames ?? ["l0\nl1\nl2\nl3\nl4"],
      compactFrames: statusOverrides.compactFrames ?? ["c0\nc1\nc2"],
      minimalFrames: statusOverrides.minimalFrames ?? ["face"],
      frameSequence: [0],
    }));
    return { configDir, stateDir };
  }


  test("auto tier selects full when rows >= 40", () => {
    const { configDir } = createDensityFixture("auto");
    const result = runStatusline(configDir, "{}\n", "80", { BUDDY_STATUSLINE_ROWS: "50" });
    expect(result.status).toBe(0);
    expect(result.stdout.toString().split("\n").filter((line) => line.trim().length > 0).length).toBeGreaterThanOrEqual(6);
    expect(result.stdout.toString()).toContain("Nimbus");
  });

  test("auto tier selects compact when rows are 20-39", () => {
    const { configDir } = createDensityFixture("auto");
    const result = runStatusline(configDir, "{}\n", "80", { BUDDY_STATUSLINE_ROWS: "30" });
    expect(result.status).toBe(0);
    expect(result.stdout.toString().split("\n").filter((line) => line.trim().length > 0).length).toBe(4);
    expect(result.stdout.toString()).toContain("Nimbus");
  });

  test("auto tier selects minimal when rows < 20", () => {
    const { configDir } = createDensityFixture("auto");
    const result = runStatusline(configDir, "{}\n", "80", { BUDDY_STATUSLINE_ROWS: "10" });
    expect(result.status).toBe(0);
    expect(result.stdout.toString().split("\n").filter((line) => line.trim().length > 0).length).toBe(1);
    expect(result.stdout.toString()).toContain("Nimbus");
  });

  test("auto tier selects minimal for very narrow terminal width", () => {
    const { configDir } = createDensityFixture("auto");
    const result = runStatusline(configDir, "{}\n", "30", { BUDDY_STATUSLINE_ROWS: "50" });
    expect(result.status).toBe(0);
    expect(result.stdout.toString().split("\n").filter((line) => line.trim().length > 0).length).toBe(1);
    expect(result.stdout.toString()).toContain("Nimbus");
  });

  test("BUDDY_STATUSLINE_ROWS overrides PTY rows and pins compact", () => {
    const { configDir } = createDensityFixture("auto");
    const result = runStatusline(configDir, "{}\n", "80", { BUDDY_STATUSLINE_ROWS: "25" });
    expect(result.status).toBe(0);
    expect(result.stdout.toString().split("\n").filter((line) => line.trim().length > 0).length).toBe(4);
  });

  test("explicit full overrides row-driven minimal", () => {
    const { configDir } = createDensityFixture("full");
    const result = runStatusline(configDir, "{}\n", "80", { BUDDY_STATUSLINE_ROWS: "10" });
    expect(result.status).toBe(0);
    expect(result.stdout.toString().split("\n").filter((line) => line.trim().length > 0).length).toBeGreaterThanOrEqual(6);
  });

  test("explicit compact overrides row-driven full", () => {
    const { configDir } = createDensityFixture("compact");
    const result = runStatusline(configDir, "{}\n", "80", { BUDDY_STATUSLINE_ROWS: "50" });
    expect(result.status).toBe(0);
    expect(result.stdout.toString().split("\n").filter((line) => line.trim().length > 0).length).toBe(4);
  });

  test("explicit minimal overrides row-driven full", () => {
    const { configDir } = createDensityFixture("minimal");
    const result = runStatusline(configDir, "{}\n", "80", { BUDDY_STATUSLINE_ROWS: "50" });
    expect(result.status).toBe(0);
    expect(result.stdout.toString().split("\n").filter((line) => line.trim().length > 0).length).toBe(1);
  });

  test("invalid density config falls back to auto behavior", () => {
    const { configDir } = createDensityFixture("banana");
    const result = runStatusline(configDir, "{}\n", "80", { BUDDY_STATUSLINE_ROWS: "30" });
    expect(result.status).toBe(0);
    expect(result.stdout.toString().split("\n").filter((line) => line.trim().length > 0).length).toBe(4);
  });

  test("minimal shows reaction only when it fits", () => {
    const { configDir, stateDir } = createDensityFixture("minimal", {}, {
      minimalFrames: ["(°°)"],
    });
    writeFileSync(join(stateDir, "reaction.default.json"), JSON.stringify({
      reaction: "long-reaction-text",
      timestamp: 9999999999999,
      reason: "tool",
    }));
    const wide = runStatusline(configDir, "{}\n", "80", { BUDDY_STATUSLINE_ROWS: "10" });
    expect(wide.stdout.toString()).toContain("long-reaction-text");

    const narrow = runStatusline(configDir, "{}\n", "20", { BUDDY_STATUSLINE_ROWS: "10" });
    expect(narrow.stdout.toString()).toContain("Nimbus");
    expect(narrow.stdout.toString()).not.toContain("long-reaction-text");
  });
});

describe("achievement banner expiry", () => {
  function writeStatus(stateDir: string, extra: Record<string, unknown>) {
    writeFileSync(join(stateDir, "status.json"), JSON.stringify({
      name: "Nimbus",
      rarity: "common",
      stars: "★",
      shiny: false,
      reaction: "",
      level: 1,
      mood: "focused",
      frames: ["  art"],
      frameSequence: [0],
      ...extra,
    }));
  }

  test("shows a freshly awarded achievement", () => {
    const { configDir, stateDir } = createStatuslineFixture({ reactionTTL: 900 });
    writeStatus(stateDir, { achievement: "🕊️ Diplomat", achievementAt: Date.now() });

    const result = runStatusline(configDir);

    expect(result.status).toBe(0);
    expect(result.stdout.toString()).toContain("Diplomat");
  });

  test("drops an achievement older than the reaction TTL", () => {
    const { configDir, stateDir } = createStatuslineFixture({ reactionTTL: 900 });
    writeStatus(stateDir, {
      achievement: "🕊️ Diplomat",
      achievementAt: Date.now() - 901_000,
    });

    const result = runStatusline(configDir);

    expect(result.status).toBe(0);
    expect(result.stdout.toString()).not.toContain("Diplomat");
  });

  test("does not render a banner when achievementAt is zeroed", () => {
    const { configDir, stateDir } = createStatuslineFixture({ reactionTTL: 900 });
    writeStatus(stateDir, { achievement: "🕊️ Diplomat", achievementAt: 0 });

    const result = runStatusline(configDir);

    expect(result.status).toBe(0);
    expect(result.stdout.toString()).not.toContain("Diplomat");
  });

  test("never renders a zeroed achievementAt even when reactionTTL disables expiry", () => {
    const { configDir, stateDir } = createStatuslineFixture({ reactionTTL: 0 });
    writeStatus(stateDir, { achievement: "\u{1F54A}\uFE0F Diplomat", achievementAt: 0 });

    const result = runStatusline(configDir);

    expect(result.status).toBe(0);
    expect(result.stdout.toString()).not.toContain("Diplomat");
  });

  test("reactionTTL=0 keeps a validly stamped achievement from expiring", () => {
    const { configDir, stateDir } = createStatuslineFixture({ reactionTTL: 0 });
    writeStatus(stateDir, {
      achievement: "\u{1F54A}\uFE0F Diplomat",
      achievementAt: Date.now() - 86_400_000,
    });

    const result = runStatusline(configDir);

    expect(result.status).toBe(0);
    expect(result.stdout.toString()).toContain("Diplomat");
  });

  test("treats a legacy status.json without achievementAt as fresh", () => {
    const { configDir, stateDir } = createStatuslineFixture({ reactionTTL: 900 });
    writeStatus(stateDir, { achievement: "🕊️ Diplomat" });

    const result = runStatusline(configDir);

    expect(result.status).toBe(0);
    expect(result.stdout.toString()).toContain("Diplomat");
  });
});
