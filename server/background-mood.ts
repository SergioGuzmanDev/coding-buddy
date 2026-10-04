import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { STATUS_MOODS } from "./art.ts";

// Each mood a reaction brings adds a point to it, and every score halves each hour. The strongest colors the
// buddy while it stays at SHOWN_FROM or more: one reaction never gets there, two in a row do. All scores fade
// at one rate, so the strongest stays the strongest until it fades out, which is when `until` says.
export const HALF_LIFE_MS = 60 * 60_000;
export const SHOWN_FROM = 1.5;
const SOOTHED = ["angry", "sad", "embarrassed"];

export interface BackgroundMood {
  scores: Record<string, number>;
  at: number;
  mood: string;
  until: number;
}

const moodFile = (stateDir: string) => join(stateDir, "background-mood.json");

export function readBackgroundMood(stateDir: string): BackgroundMood {
  try {
    const state = JSON.parse(readFileSync(moodFile(stateDir), "utf8")) as BackgroundMood;
    if (state && typeof state.scores === "object" && typeof state.at === "number") return state;
  } catch {
    // No mood felt yet.
  }
  return { scores: {}, at: 0, mood: "", until: 0 };
}

/** The mood the buddy has been in lately, or "" while calm. */
export function currentBackgroundMood(stateDir: string, now = Date.now()): string {
  const state = readBackgroundMood(stateDir);
  return state.until > now ? state.mood : "";
}

function faded(stateDir: string, now: number): Record<string, number> {
  const state = readBackgroundMood(stateDir);
  const factor = 0.5 ** (Math.max(0, now - state.at) / HALF_LIFE_MS);
  return Object.fromEntries(Object.entries(state.scores).map(([mood, score]) => [mood, score * factor]));
}

function settle(stateDir: string, scores: Record<string, number>, now: number): BackgroundMood {
  const [mood, score] = Object.entries(scores).sort((a, b) => b[1] - a[1])[0] ?? ["", 0];
  const shown = score >= SHOWN_FROM;
  const state = {
    scores: Object.fromEntries(Object.entries(scores).filter(([, s]) => s >= 0.01)),
    at: now,
    mood: shown ? mood : "",
    until: shown ? Math.round(now + HALF_LIFE_MS * Math.log2(score / SHOWN_FROM)) : 0,
  };
  // Every tab's status line reads it, so it must never see a half-written file.
  const tmp = `${moodFile(stateDir)}.tmp.${process.pid}`;
  writeFileSync(tmp, JSON.stringify(state));
  renameSync(tmp, moodFile(stateDir));
  return state;
}

export function feelMood(stateDir: string, mood: string, now = Date.now()): BackgroundMood | undefined {
  if (!Object.hasOwn(STATUS_MOODS, mood)) return undefined;
  const scores = faded(stateDir, now);
  scores[mood] = (scores[mood] ?? 0) + 1;
  return settle(stateDir, scores, now);
}

/** A pet halves every bad feeling and adds a point of happiness. */
export function soothe(stateDir: string, now = Date.now()): BackgroundMood {
  const scores = faded(stateDir, now);
  for (const mood of SOOTHED) if (scores[mood]) scores[mood] /= 2;
  scores.happy = (scores.happy ?? 0) + 1;
  return settle(stateDir, scores, now);
}
