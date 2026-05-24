import { describe, expect, it } from "vitest";
import {
  type NoteDecayInput,
  assignTiers,
  computeDecayScore,
  computeDecayScores,
} from "../intelligence/note-tiering.js";

const NOW_MS = 1_700_000_000_000;
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

function input(over: Partial<NoteDecayInput> = {}): NoteDecayInput {
  return {
    note_id: "n",
    reinforcement_count: 0,
    contradiction_count: 0,
    last_seen_turn: 0,
    inactive: false,
    anchor_missing: false,
    anchor_missing_since_ms: 0,
    ...over,
  };
}

describe("computeDecayScore (A4)", () => {
  it("higher reinforcement → higher score", () => {
    const low = computeDecayScore(input({ reinforcement_count: 1 }), 1, NOW_MS);
    const high = computeDecayScore(
      input({ reinforcement_count: 5 }),
      1,
      NOW_MS
    );
    expect(high).toBeGreaterThan(low);
  });

  it("more turns since last seen → lower score", () => {
    const recent = computeDecayScore(
      input({ last_seen_turn: 100 }),
      100,
      NOW_MS
    );
    const stale = computeDecayScore(input({ last_seen_turn: 0 }), 100, NOW_MS);
    expect(recent).toBeGreaterThan(stale);
  });

  it("contradictions demote score by 0.5 per contradiction", () => {
    const clean = computeDecayScore(
      input({ reinforcement_count: 5 }),
      1,
      NOW_MS
    );
    const contradicted = computeDecayScore(
      input({ reinforcement_count: 5, contradiction_count: 2 }),
      1,
      NOW_MS
    );
    expect(clean - contradicted).toBeCloseTo(1.0, 5);
  });

  it("anchor_missing accelerates decay over weeks", () => {
    const present = computeDecayScore(
      input({ reinforcement_count: 5 }),
      1,
      NOW_MS
    );
    const missing4Weeks = computeDecayScore(
      input({
        reinforcement_count: 5,
        anchor_missing: true,
        anchor_missing_since_ms: NOW_MS - 4 * WEEK_MS,
      }),
      1,
      NOW_MS
    );
    expect(missing4Weeks).toBeLessThan(present);
    // 4 weeks * 0.5 penalty = 2.0 reduction
    expect(present - missing4Weeks).toBeCloseTo(2.0, 5);
  });

  it("anchor_missing penalty is ~zero the same day", () => {
    const sameDay = computeDecayScore(
      input({
        reinforcement_count: 5,
        anchor_missing: true,
        anchor_missing_since_ms: NOW_MS - 1000,
      }),
      1,
      NOW_MS
    );
    const noMissing = computeDecayScore(
      input({ reinforcement_count: 5 }),
      1,
      NOW_MS
    );
    expect(Math.abs(sameDay - noMissing)).toBeLessThan(0.01);
  });

  it("turns_since_last_seen never goes negative", () => {
    const futureTurn = computeDecayScore(
      input({ last_seen_turn: 100 }),
      50,
      NOW_MS
    );
    expect(Number.isFinite(futureTurn)).toBe(true);
    expect(futureTurn).toBeGreaterThan(0);
  });
});

describe("assignTiers (A4)", () => {
  it("small population (< 5 active) → all active hot", () => {
    const notes = [
      input({ note_id: "a", reinforcement_count: 1 }),
      input({ note_id: "b", reinforcement_count: 5 }),
      input({ note_id: "c", reinforcement_count: 10 }),
    ];
    const tiers = assignTiers(notes, 1, NOW_MS);
    expect(tiers.every((t) => t.tier === "hot")).toBe(true);
  });

  it("large population → 20/50/30 split", () => {
    const notes = Array.from({ length: 100 }, (_, i) =>
      input({ note_id: `n${i}`, reinforcement_count: 100 - i })
    );
    const tiers = assignTiers(notes, 1, NOW_MS);
    const counts = { hot: 0, warm: 0, cold: 0 };
    for (const t of tiers) counts[t.tier]++;
    expect(counts.hot).toBe(20);
    expect(counts.warm).toBe(50);
    expect(counts.cold).toBe(30);
  });

  it("inactive notes always tier cold and don't dilute the active pool", () => {
    const notes = [
      input({ note_id: "a1", reinforcement_count: 10 }),
      input({ note_id: "a2", reinforcement_count: 5 }),
      input({ note_id: "a3", reinforcement_count: 1 }),
      input({ note_id: "a4", reinforcement_count: 1 }),
      input({ note_id: "a5", reinforcement_count: 1 }),
      input({ note_id: "a6", reinforcement_count: 1 }),
      input({ note_id: "a7", reinforcement_count: 1 }),
      input({ note_id: "a8", reinforcement_count: 1 }),
      input({ note_id: "a9", reinforcement_count: 1 }),
      input({ note_id: "a10", reinforcement_count: 1 }),
      input({ note_id: "dead", reinforcement_count: 100, inactive: true }),
    ];
    const tiers = assignTiers(notes, 1, NOW_MS);
    expect(tiers.find((t) => t.note_id === "dead")?.tier).toBe("cold");
    expect(tiers.find((t) => t.note_id === "a1")?.tier).toBe("hot");
  });

  it("highest-score notes land in hot tier", () => {
    const notes = Array.from({ length: 20 }, (_, i) =>
      input({ note_id: `n${i}`, reinforcement_count: i })
    );
    const tiers = assignTiers(notes, 1, NOW_MS);
    const hotIds = new Set(
      tiers.filter((t) => t.tier === "hot").map((t) => t.note_id)
    );
    expect(hotIds.has("n19")).toBe(true);
    expect(hotIds.has("n18")).toBe(true);
  });

  it("contradicted high-reinforcement notes can demote below clean low-reinforcement", () => {
    const notes = [
      input({
        note_id: "tainted",
        reinforcement_count: 5,
        contradiction_count: 20,
      }),
      input({ note_id: "fresh", reinforcement_count: 2 }),
      ...Array.from({ length: 8 }, (_, i) =>
        input({ note_id: `filler${i}`, reinforcement_count: 1 })
      ),
    ];
    const tiers = assignTiers(notes, 1, NOW_MS);
    const tainted = tiers.find((t) => t.note_id === "tainted")?.tier;
    const fresh = tiers.find((t) => t.note_id === "fresh")?.tier;
    expect(fresh).toBe("hot");
    expect(tainted).toBe("cold");
  });
});

describe("computeDecayScores (A4)", () => {
  it("preserves input order", () => {
    const notes = [
      input({ note_id: "a", reinforcement_count: 1 }),
      input({ note_id: "b", reinforcement_count: 5 }),
    ];
    const result = computeDecayScores(notes, 1, NOW_MS);
    expect(result.map((r) => r.note_id)).toEqual(["a", "b"]);
  });
});
