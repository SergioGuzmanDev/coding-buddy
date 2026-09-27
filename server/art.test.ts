/**
 * Display-width tests — covers the U+2600-U+27BF split between Emoji_Presentation
 * (2 cols) and text-presentation (1 col), plus VS16 upgrades. Keeps bubble
 * padding and companion-card alignment stable when reactions/achievements
 * contain emoji.
 */

import { describe, test, expect } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import { displayWidth, getArtFrame, getStatusFrames, resolveEyeGlyph, STATUS_FRAME_SEQUENCE, STATUS_MOVES, statusMoveChoices, truncateDisplayWidth } from "./art.ts";
import { SPECIES_ART as CORE_SPECIES_ART } from "../core/art-data.ts";
import { SPECIES, EYES, type BuddyBones } from "../core/engine.ts"
function readCodepointRanges(path: string): number[] {
  const ranges = readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line && !line.startsWith("#"))
    .join(" ")
    .trim()
    .split(/[,\s]+/);
  return ranges.flatMap((range) => {
    const [startText, endText = startText] = range.split("-");
    const start = Number(startText);
    const end = Number(endText);
    return Array.from({ length: end - start + 1 }, (_, index) => start + index);
  });
}

describe("displayWidth", () => {
  test("ASCII has width equal to character count", () => {
    expect(displayWidth("")).toBe(0);
    expect(displayWidth("hola")).toBe(4);
    expect(displayWidth("hola  ")).toBe(6);
  });

  test("non-BMP emoji (U+1F000+) count as 2", () => {
    expect(displayWidth("\u{1F3C6}")).toBe(2); // 🏆
    expect(displayWidth("\u{1F9F9}")).toBe(2); // 🧹
  });

  test("Emoji_Presentation codepoints in U+2600-U+27BF count as 2", () => {
    expect(displayWidth("\u2705")).toBe(2); // ✅
    expect(displayWidth("\u274C")).toBe(2); // ❌
    expect(displayWidth("\u26A1")).toBe(2); // ⚡
    expect(displayWidth("\u2728")).toBe(2); // ✨
  });

  test("text-presentation symbols in U+2600-U+27BF stay 1 without VS16", () => {
    expect(displayWidth("\u2605")).toBe(1);           // ★
    expect(displayWidth("\u2605\u2605\u2605\u2605\u2605")).toBe(5); // ★★★★★ (rarity stars)
    expect(displayWidth("\u2660")).toBe(1);           // ♠
    expect(displayWidth("\u2764")).toBe(1);           // ❤ plain
  });

  test("VS16 upgrades narrow symbols in U+2600-U+27BF to 2", () => {
    expect(displayWidth("\u2764\uFE0F")).toBe(2); // ❤️
    expect(displayWidth("\u2600\uFE0F")).toBe(2); // ☀️
  });

  test("VS16 after an already-wide emoji does not add width", () => {
    expect(displayWidth("\u2705\uFE0F")).toBe(2);      // ✅ + VS16
    expect(displayWidth("\u{1F3C6}\uFE0F")).toBe(2);   // 🏆 + VS16
  });

  test("zero-width joiner and variation selectors don't add width", () => {
    expect(displayWidth("\u200D")).toBe(0);
    expect(displayWidth("\uFE00")).toBe(0);
  });

  test("ANSI escape sequences are stripped", () => {
    expect(displayWidth("\x1b[31mhola\x1b[0m")).toBe(4);
  });

  test("mixed ASCII + emoji matches terminal columns", () => {
    // "🏆 ✅ Good Buddy" → 2+1+2+1+10 = 16
    expect(displayWidth("\u{1F3C6} \u2705 Good Buddy")).toBe(16);
  });
});

describe("truncateDisplayWidth", () => {
  test("keeps wide emoji intact and preserves ANSI state", () => {
    const value = "\x1b[31mhello 🏆 world\x1b[0m";
    const truncated = truncateDisplayWidth(value, 8);

    expect(displayWidth(truncated)).toBeLessThanOrEqual(8);
    expect(truncated).toContain("hello");
    expect(truncated).toContain("\u2026");
    expect(truncated).toContain("\x1b[0m");
    expect(truncated).not.toContain("🏆");
  });
  test("keeps a VS16-upgraded symbol within the suffix budget", () => {
    const truncated = truncateDisplayWidth("❤️x", 2);

    expect(displayWidth(truncated)).toBeLessThanOrEqual(2);
    expect(truncated).toContain("\u2026");
  });

});

describe("getStatusFrames", () => {
  const bones = (overrides: Partial<BuddyBones> = {}): BuddyBones => ({
    rarity: "common",
    species: "capybara",
    eye: "\u00b0",
    hat: "none",
    shiny: false,
    stats: { DEBUGGING: 50, PATIENCE: 50, CHAOS: 50, WISDOM: 50, SNARK: 50 },
    peak: "DEBUGGING",
    dump: "PATIENCE",
    ...overrides,
  });

  test("produces 4 frames and a 15-tick sequence", () => {
    const { frames, frameSequence } = getStatusFrames(bones());
    expect(frames).toHaveLength(4);
    expect(frameSequence).toEqual([...STATUS_FRAME_SEQUENCE]);
  });

  test("every species produces at least 4 frames, each with 5-6 lines", () => {
    for (const species of SPECIES) {
      const { frames } = getStatusFrames(bones({ species }));
      expect(frames.length).toBeGreaterThanOrEqual(4);
      for (const body of frames) {
        const lines = body.split("\n").length;
        expect(lines).toBeGreaterThanOrEqual(5);
        expect(lines).toBeLessThanOrEqual(6);
      }
    }
  });

  const octopus = bones({ species: "octopus", eye: "@" });
  const pool = STATUS_MOVES.octopus!.pool;
  // Evenly spread draws, so every move of the pool is picked in turn.
  const everyMove = () => { let calls = 0; return () => ((calls++ % pool.length) + 0.5) / pool.length; };
  const marks = {
    cigarette: "(______)===*", pipe: "(______)___u", wave: "(______)__/", jump: "' '' '", coffee: "c[_]",
    sleep: "( -  - ) z", look: "(@  @  )", dance: "   (______)", yawn: "(__O___)",
  };
  const acting = (frame: string) => Object.values(marks).some((mark) => frame.includes(mark));

  test("every 30 seconds the octopus does a random move from its pool, at the resting frame's size", () => {
    const { frames, minimalFrames, frameSequence } = getStatusFrames(octopus, everyMove());
    const resting = frames[0].split("\n");

    for (const frame of frames) {
      expect(frame.split("\n")).toHaveLength(resting.length);
      expect(frame.split("\n")[0].trim()).toBe("");
    }
    for (const line of frames.flatMap((f) => f.split("\n"))) expect(displayWidth(line)).toBe(displayWidth(resting[1]));

    for (let slot = 0; slot * 30 < frameSequence.length; slot++) {
      expect(frameSequence.slice(slot * 30, slot * 30 + 30).some((i) => acting(frames[i]))).toBe(true);
    }
    for (const mark of Object.values(marks)) expect(frameSequence.some((i) => frames[i].includes(mark))).toBe(true);
    for (const face of [" *===~(", " u___~(", ")~/", "_(@@)_", "c[_]", "~(--)~z", "~(@@ )~", "/(@@)/", "~(>O<)~"]) {
      expect(frameSequence.some((i) => minimalFrames[i].includes(face))).toBe(true);
    }
    expect(frameSequence.filter((i) => acting(frames[i])).length).toBeLessThanOrEqual(frameSequence.length / 2);

    const cigarettesOnly = getStatusFrames(octopus, () => 0);
    expect(cigarettesOnly.frameSequence.some((i) => Object.values(marks).slice(1).some((m) => cigarettesOnly.frames[i].includes(m)))).toBe(false);
  });

  test("every octopus move still moves when the status line samples every other second", () => {
    const moving = (frames: string[], sequence: number[], label: string) => {
      const resting = new Set(STATUS_FRAME_SEQUENCE.map((i) => frames[i]));
      for (const parity of [0, 1]) {
        const shown = new Set(sequence.filter((_, tick) => tick % 2 === parity).map((i) => frames[i]));
        expect([...shown].filter((frame) => !resting.has(frame)).length, `${label} at parity ${parity}`).toBeGreaterThanOrEqual(2);
      }
    };
    for (let move = 0; move < pool.length; move++) {
      const { frames, frameSequence } = getStatusFrames(octopus, () => (move + 0.5) / pool.length);
      moving(frames, frameSequence, `pool move ${move}`);
    }
    const { frames, idleSequence, celebrateSequence } = getStatusFrames(octopus);
    moving(frames, idleSequence!, "idle");
    moving(frames, celebrateSequence!, "celebration");
  });

  test("a tired octopus sleeps or yawns in at least half of its moves, a rested one far less", () => {
    let calls = 0;
    const evenly = () => ((calls++ % 40) + 0.5) / 40;
    const { frames, frameSequence, tiredSequence } = getStatusFrames(octopus, evenly);
    const drowsyShare = (sequence: number[]) => {
      const slots = Array.from({ length: sequence.length / 30 }, (_, slot) => sequence.slice(slot * 30, slot * 30 + 30));
      return slots.filter((slot) => slot.some((i) => frames[i].includes(marks.sleep) || frames[i].includes(marks.yawn))).length / slots.length;
    };

    expect(drowsyShare(tiredSequence!)).toBeGreaterThanOrEqual(0.5);
    expect(drowsyShare(frameSequence)).toBeLessThan(0.3);
  });

  test("the idle loop sleeps and a finished turn is celebrated with raised arms", () => {
    const { frames, minimalFrames, idleSequence, celebrateSequence } = getStatusFrames(octopus);

    expect(idleSequence!.every((i) => frames[i].includes("( -  - )"))).toBe(true);
    expect(celebrateSequence!.every((i) => frames[i].includes("( ^  ^ )"))).toBe(true);
    expect(celebrateSequence!.some((i) => frames[i].includes("\\( ^  ^ )/"))).toBe(true);
    expect(celebrateSequence!.some((i) => minimalFrames[i] === "\\(^^)/")).toBe(true);
  });

  test("each move Gemini can pick has its own sequence, drawn from that move's frames", () => {
    const { frames, moveSequences } = getStatusFrames(octopus);
    const choices = statusMoveChoices("octopus");

    expect(Object.keys(moveSequences!).sort()).toEqual(choices.map((m) => m.name).sort());
    expect(new Set(choices.map((m) => m.name)).size).toBe(choices.length);
    for (const [name, mark] of Object.entries(marks)) {
      expect(moveSequences![name].some((i) => frames[i].includes(mark)), name).toBe(true);
    }
    expect(moveSequences!.celebrate.every((i) => frames[i].includes("( ^  ^ )"))).toBe(true);
  });

  test("sweat adds a drop left of the eyes and a ';' to the face without resizing any frame", () => {
    const { frames, minimalFrames, sweat } = getStatusFrames(octopus);

    expect(sweat.frames).toHaveLength(frames.length);
    sweat.frames.forEach((frame, i) => {
      expect(frame.split("\n").map(displayWidth)).toEqual(frames[i].split("\n").map(displayWidth));
      expect(frame.split("\n")[2]).toMatch(/'\S/);
    });
    expect(sweat.frames[0].split("\n")[2]).toContain("'( @  @ )");
    expect(sweat.minimalFrames[0]).toBe(minimalFrames[0].replace(")", ";)"));
    expect(sweat.minimalFrames[0]).toContain("(@@;)");
    expect(sweat.compactFrames[0]).toContain("'( @  @ )");
  });

  test("the octopus's bubble floats beside its head so the status line can drop the top row", () => {
    const { frames } = getStatusFrames(bones({ species: "octopus", eye: "@" }));
    const bubble = frames[2].split("\n");
    expect(bubble[0].trim()).toBe("");
    expect(bubble[1]).toMatch(/\.----\.\s+o/);
  });

  test("eye is replaced in idle frames", () => {
    const { frames } = getStatusFrames(bones({ species: "capybara", eye: "@" }));
    expect(frames[0]).toContain("@");
    expect(frames[0]).not.toContain("{E}");
  });

  test("blink frame (index 3) replaces the configured eye with '-'", () => {
    const { frames } = getStatusFrames(bones({ species: "capybara", eye: "@" }));
    expect(frames[3]).not.toContain("@");
    expect(frames[3]).toContain("-");
  });

  test("hat overlays line 0 when the species frame has no line-0 content", () => {
    // duck's frame 0 line 0 is blank — hat should appear there.
    const { frames } = getStatusFrames(bones({ species: "duck", hat: "crown" }));
    const line0 = frames[0].split("\n")[0];
    expect(line0).toContain("\\^^^/");
  });

  test("hat does not override species line-0 content", () => {
    // capybara frame 2 has ripples on line 0 — hat should not replace them.
    const { frames } = getStatusFrames(bones({ species: "capybara", hat: "crown" }));
    const line0 = frames[2].split("\n")[0];
    expect(line0).not.toContain("\\^^^/");
    expect(line0).toContain("~");
  });

  test("frame sequence references only valid frame indices", () => {
    const { frames, frameSequence } = getStatusFrames(bones());
    for (const idx of frameSequence) {
      expect(idx).toBeGreaterThanOrEqual(0);
      expect(idx).toBeLessThan(frames.length);
    }
  });

  test("descriptor eye 'normal' does not leak into baked duck frames", () => {
    // Live bug: bones.eye was the word "normal", so duck `<(° )___` rendered
    // as `<(normal …`. Sanitization must keep sprite glyphs only.
    const corrupted = bones({ species: "duck" });
    // @ts-expect-error intentionally invalid eye descriptor from corrupted state
    corrupted.eye = "normal";
    const { frames } = getStatusFrames(corrupted);
    for (const body of frames) {
      expect(body).not.toContain("normal");
      expect(body).not.toContain("{E}");
    }
    expect(frames[0]).toContain("  <(° )___  ");
    expect(frames[3]).toContain("  <(- )___  ");
  });

  test("resolveEyeGlyph keeps real glyphs and rejects words", () => {
    expect(resolveEyeGlyph("°")).toBe("°");
    expect(resolveEyeGlyph("@")).toBe("@");
    expect(resolveEyeGlyph("normal")).toBe("°");
    expect(resolveEyeGlyph("")).toBe("°");
    expect(resolveEyeGlyph(undefined)).toBe("°");
  });

  test("invalid persisted hyphen falls back in idle frames", () => {
    const hyphenEye = bones({
      species: "duck",
      // @ts-expect-error: blink is an internal frame sentinel, not a persisted eye
      eye: "-",
    });
    expect(getStatusFrames(hyphenEye).frames[0]).toContain("  <(° )___  ");
  });

  test("valid eye glyphs remain unchanged in baked frames", () => {
    for (const eye of EYES) {
      const { frames } = getStatusFrames(bones({ species: "duck", eye }));
      for (const frame of frames.slice(0, 3)) {
        expect(frame).toContain(`  <(${eye} )___  `);
        expect(frame).not.toContain("{E}");
      }
      expect(frames[3]).toContain("  <(- )___  ");
    }
  });

  test("getArtFrame also sanitizes invalid eye descriptors", () => {
    const frame = getArtFrame("duck", "normal", 0);
    expect(frame.join("\n")).not.toContain("normal");
    expect(frame).toContain("  <(° )___  ");
  });
});

describe("statusline/emoji-widths.data", () => {
  test("matches Unicode Emoji_Presentation (regenerate via 'bun run gen:emoji-widths')", () => {
    const fileList = readCodepointRanges(
      join(import.meta.dir, "..", "statusline", "emoji-widths.data"),
    );
    const re = /\p{Emoji_Presentation}/u;
    const expected: number[] = [];
    for (let cp = 0; cp <= 0x10FFFF; cp++) {
      if (re.test(String.fromCodePoint(cp))) expected.push(cp);
    }
    expect(fileList).toEqual(expected);
  });
  test("matches Unicode Emoji codepoints that need VS16 upgrades", () => {
    const fileList = readCodepointRanges(
      join(import.meta.dir, "..", "statusline", "emoji-text.data"),
    );
    const emoji = /\p{Emoji}/u;
    const presentation = /\p{Emoji_Presentation}/u;
    const expected: number[] = [];
    for (let cp = 0; cp <= 0x10FFFF; cp++) {
      const character = String.fromCodePoint(cp);
      if (emoji.test(character) && !presentation.test(character)) expected.push(cp);
    }
    expect(fileList).toEqual(expected);
  });
});
describe("core wyvern art", () => {
  test("has exactly three plain-text frames of five lines", () => {
    const wyvern = CORE_SPECIES_ART.wyvern;
    expect(wyvern.length).toBe(3);
    for (const frame of wyvern) {
      expect(frame.length).toBe(5);
      for (const line of frame) {
        expect(line).not.toContain("\x1b[");
      }
    }
  });
});
