import { describe, it, expect } from "vitest";

import {
  isSticky,
  getStickyFamilies,
  recordFamilyCall,
  advanceTurn,
  createStickinessState,
  type StickinessState,
} from "../router/intent/stickiness.js";
import {
  getAdjustedThreshold,
  buildDecayState,
  createEmptyDecayState,
  type DecayState,
} from "../router/intent/threshold-decay.js";

describe("Ledger Stickiness", () => {
  // ── Basic stickiness ───────────────────────────────────────────

  it("family is sticky immediately after call on same turn", () => {
    let state = createStickinessState();
    state = recordFamilyCall(state, "pg", 0);
    expect(isSticky("pg", state)).toBe(true);
  });

  it("family stays sticky for 5 turns after call", () => {
    let state = createStickinessState();
    state = recordFamilyCall(state, "pg", 0);

    for (let i = 0; i < 5; i++) {
      state = advanceTurn(state);
      expect(isSticky("pg", state)).toBe(true);
    }
  });

  it("family loses stickiness after 6 turns", () => {
    let state = createStickinessState();
    state = recordFamilyCall(state, "pg", 0);

    for (let i = 0; i < 6; i++) {
      state = advanceTurn(state);
    }
    expect(isSticky("pg", state)).toBe(false);
  });

  it("never-called family is not sticky", () => {
    const state = createStickinessState();
    expect(isSticky("pg", state)).toBe(false);
  });

  // ── Multiple families ──────────────────────────────────────────

  it("multiple families can be sticky simultaneously", () => {
    let state = createStickinessState();
    state = recordFamilyCall(state, "pg", 0);
    state = recordFamilyCall(state, "gh", 0);

    expect(isSticky("pg", state)).toBe(true);
    expect(isSticky("gh", state)).toBe(true);
  });

  it("getStickyFamilies returns all currently sticky families", () => {
    let state = createStickinessState();
    state = recordFamilyCall(state, "pg", 0);
    state = recordFamilyCall(state, "gh", 0);

    const sticky = getStickyFamilies(state);
    expect(sticky.has("pg")).toBe(true);
    expect(sticky.has("gh")).toBe(true);
    expect(sticky.has("slk")).toBe(false);
  });

  // ── Stickiness refresh ─────────────────────────────────────────

  it("repeated calls refresh the stickiness window", () => {
    let state = createStickinessState();
    state = recordFamilyCall(state, "pg", 0);

    for (let i = 0; i < 4; i++) state = advanceTurn(state);
    state = recordFamilyCall(state, "pg", state.currentTurn);

    for (let i = 0; i < 5; i++) state = advanceTurn(state);
    expect(isSticky("pg", state)).toBe(true);
  });

  // ── State pruning ─────────────────────────────────────────────

  it("old records are pruned on advance", () => {
    let state = createStickinessState();
    state = recordFamilyCall(state, "pg", 0);

    for (let i = 0; i < 20; i++) state = advanceTurn(state);

    expect(state.recentCalls.length).toBeLessThanOrEqual(1);
    expect(isSticky("pg", state)).toBe(false);
  });

  // ── Asymmetric window (used in last 5, exposed for next 5) ────

  it("stickiness scenario: used in last 5 turns stays exposed for next 5", () => {
    let state: StickinessState = { currentTurn: 10, recentCalls: [] };

    state = recordFamilyCall(state, "pg", 8);

    expect(isSticky("pg", state)).toBe(true);

    state = { ...state, currentTurn: 13 };
    expect(isSticky("pg", state)).toBe(true);

    state = { ...state, currentTurn: 14 };
    expect(isSticky("pg", state)).toBe(false);
  });
});

describe("Threshold Decay", () => {
  // ── Never-used families ────────────────────────────────────────

  it("never-used family gets raised threshold (capped at 0.60)", () => {
    const state = buildDecayState(
      new Map([["slk", { sessionsActive: 0, sessionsTotal: 10 }]]),
    );

    const threshold = getAdjustedThreshold("slk", state);
    expect(threshold).toBe(0.60);
  });

  it("never-used family with few sessions gets moderate raise", () => {
    const state = buildDecayState(
      new Map([["slk", { sessionsActive: 0, sessionsTotal: 4 }]]),
    );

    const threshold = getAdjustedThreshold("slk", state);
    expect(threshold).toBe(0.30 + 4 * 0.05);
    expect(threshold).toBe(0.50);
  });

  it("threshold caps at 0.60", () => {
    const state = buildDecayState(
      new Map([["slk", { sessionsActive: 0, sessionsTotal: 100 }]]),
    );

    const threshold = getAdjustedThreshold("slk", state);
    expect(threshold).toBe(0.60);
  });

  // ── Frequently-used families ───────────────────────────────────

  it("frequently-used family gets lowered threshold", () => {
    const state = buildDecayState(
      new Map([["pg", { sessionsActive: 10, sessionsTotal: 15 }]]),
    );

    const threshold = getAdjustedThreshold("pg", state);
    expect(threshold).toBeLessThan(0.30);
    expect(threshold).toBeGreaterThanOrEqual(0.15);
  });

  it("threshold floors at 0.15", () => {
    const state = buildDecayState(
      new Map([["pg", { sessionsActive: 100, sessionsTotal: 100 }]]),
    );

    const threshold = getAdjustedThreshold("pg", state);
    expect(threshold).toBe(0.15);
  });

  // ── Mixed usage ────────────────────────────────────────────────

  it("occasional usage (< 50% ratio) returns base threshold", () => {
    const state = buildDecayState(
      new Map([["gh", { sessionsActive: 3, sessionsTotal: 10 }]]),
    );

    const threshold = getAdjustedThreshold("gh", state);
    expect(threshold).toBe(0.30);
  });

  // ── Unknown family (no record) ─────────────────────────────────

  it("unknown family returns base threshold", () => {
    const state = createEmptyDecayState();
    const threshold = getAdjustedThreshold("unknown", state);
    expect(threshold).toBe(0.30);
  });

  // ── Custom base threshold ──────────────────────────────────────

  it("respects custom base threshold", () => {
    const state = createEmptyDecayState();
    const threshold = getAdjustedThreshold("pg", state, 0.25);
    expect(threshold).toBe(0.25);
  });

  // ── Zero sessions ──────────────────────────────────────────────

  it("zero total sessions returns base threshold", () => {
    const state = buildDecayState(
      new Map([["pg", { sessionsActive: 0, sessionsTotal: 0 }]]),
    );

    const threshold = getAdjustedThreshold("pg", state);
    expect(threshold).toBe(0.30);
  });

  // ── Multiple families with different histories ─────────────────

  it("different families get different thresholds", () => {
    const state = buildDecayState(
      new Map([
        ["pg", { sessionsActive: 20, sessionsTotal: 25 }],
        ["slk", { sessionsActive: 0, sessionsTotal: 15 }],
        ["gh", { sessionsActive: 3, sessionsTotal: 10 }],
      ]),
    );

    const pgT = getAdjustedThreshold("pg", state);
    const slkT = getAdjustedThreshold("slk", state);
    const ghT = getAdjustedThreshold("gh", state);

    expect(pgT).toBeLessThan(ghT);
    expect(slkT).toBeGreaterThan(ghT);
  });
});

describe("Combined: Stickiness + Decay in Scorer", () => {
  it("sticky family is exposed even with high threshold", async () => {
    const { scoreIntent } = await import("../router/intent/scorer.js");

    let state = createStickinessState();
    state = recordFamilyCall(state, "slk", 0);

    const decayState = buildDecayState(
      new Map([["slk", { sessionsActive: 0, sessionsTotal: 20 }]]),
    );

    const result = scoreIntent({
      recentFiles: [],
      entityFamilyTags: new Map(),
      recentToolFamilies: [],
      stickinessState: state,
      decayState,
      knownFamilies: new Set(["pg", "gh", "slk"]),
    });

    const slkScore = result.scores.find((s) => s.family === "slk")!;
    expect(slkScore.sticky).toBe(true);
    expect(slkScore.exposed).toBe(true);
  });

  it("non-sticky family with raised threshold is NOT exposed at low score", async () => {
    const { scoreIntent } = await import("../router/intent/scorer.js");

    const decayState = buildDecayState(
      new Map([["slk", { sessionsActive: 0, sessionsTotal: 10 }]]),
    );

    const result = scoreIntent({
      recentFiles: [],
      entityFamilyTags: new Map(),
      recentToolFamilies: [],
      stickinessState: createStickinessState(),
      decayState,
      knownFamilies: new Set(["pg", "gh", "slk"]),
    });

    const slkScore = result.scores.find((s) => s.family === "slk")!;
    expect(slkScore.exposed).toBe(false);
    expect(slkScore.thresholdApplied).toBeGreaterThan(0.30);
  });
});
