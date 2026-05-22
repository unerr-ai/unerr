import { describe, expect, it } from "vitest";
import {
  CONTEXT_LIMIT_TOKENS,
  computeCompoundedHeadroom,
} from "../tracking/headroom.js";

describe("computeCompoundedHeadroom", () => {
  describe("worked examples", () => {
    it("exposes the configured 1M context ceiling", () => {
      expect(CONTEXT_LIMIT_TOKENS).toBe(1_000_000);
    });

    it("computes +12 turns when modest savings (W=10K, S=2K, N=50)", () => {
      // Σs = 2K × 50 = 100K. δ̄_eff = 10K − 2K = 8K.
      // turns_earned = floor(100K / 8K) = 12.
      // Also = N · r/(1−r) = 50 · 0.2/0.8 = 12.5 → floor = 12.
      const result = computeCompoundedHeadroom({
        contextLimit: 1_000_000,
        avgTurnTokensWithout: 10_000,
        avgSavedPerTurn: 2_000,
        turnsObserved: 50,
      });
      expect(result.turnsToLimitWithout).toBe(100);
      expect(result.turnsToLimitWith).toBe(125);
      expect(result.headroomTurns).toBe(12);
    });

    it("computes +200 turns when heavy savings (W=10K, S=8K, N=50)", () => {
      // Σs = 8K × 50 = 400K. δ̄_eff = 2K.
      // turns_earned = floor(400K / 2K) = 200.
      // Also = N · r/(1−r) = 50 · 0.8/0.2 = 200.
      const result = computeCompoundedHeadroom({
        contextLimit: 1_000_000,
        avgTurnTokensWithout: 10_000,
        avgSavedPerTurn: 8_000,
        turnsObserved: 50,
      });
      expect(result.turnsToLimitWithout).toBe(100);
      expect(result.turnsToLimitWith).toBe(500);
      expect(result.headroomTurns).toBe(200);
    });
  });

  describe("edge cases", () => {
    it("honest-zero when no turns observed yet", () => {
      const result = computeCompoundedHeadroom({
        contextLimit: 1_000_000,
        avgTurnTokensWithout: 5_000,
        avgSavedPerTurn: 1_000,
        turnsObserved: 0,
      });
      expect(result.headroomTurns).toBe(0);
      expect(result.turnsToLimitWith).toBe(0);
      expect(result.turnsToLimitWithout).toBe(0);
    });

    it("honest-zero when avgTurnTokensWithout is 0", () => {
      const result = computeCompoundedHeadroom({
        contextLimit: 1_000_000,
        avgTurnTokensWithout: 0,
        avgSavedPerTurn: 1_000,
        turnsObserved: 10,
      });
      expect(result.headroomTurns).toBe(0);
    });

    it("zero headroom but valid without-baseline when no savings recorded", () => {
      const result = computeCompoundedHeadroom({
        contextLimit: 1_000_000,
        avgTurnTokensWithout: 10_000,
        avgSavedPerTurn: 0,
        turnsObserved: 10,
      });
      expect(result.headroomTurns).toBe(0);
      expect(result.turnsToLimitWithout).toBe(100);
      expect(result.turnsToLimitWith).toBe(100);
    });

    it("clamps with-cost to 1 token when S equals W", () => {
      // Σs = 10K × 5 = 50K. δ̄_eff = max(1, 0) = 1.
      // turns_earned = floor(50K / 1) = 50_000. Bounded by Σs (50K) ✓.
      const result = computeCompoundedHeadroom({
        contextLimit: 1_000_000,
        avgTurnTokensWithout: 10_000,
        avgSavedPerTurn: 10_000,
        turnsObserved: 5,
      });
      expect(result.turnsToLimitWithout).toBe(100);
      expect(result.turnsToLimitWith).toBe(1_000_000);
      expect(result.headroomTurns).toBe(50_000);
    });

    it("defensively clamps when S exceeds W", () => {
      // Σs = 8K × 5 = 40K. δ̄_eff = max(1, −3K) = 1.
      // turns_earned = floor(40K / 1) = 40_000.
      const result = computeCompoundedHeadroom({
        contextLimit: 1_000_000,
        avgTurnTokensWithout: 5_000,
        avgSavedPerTurn: 8_000,
        turnsObserved: 5,
      });
      expect(result.turnsToLimitWith).toBe(1_000_000);
      expect(result.turnsToLimitWithout).toBe(200);
      expect(result.headroomTurns).toBe(40_000);
    });

    it("preserves turnsObserved in result", () => {
      const result = computeCompoundedHeadroom({
        contextLimit: 1_000_000,
        avgTurnTokensWithout: 10_000,
        avgSavedPerTurn: 2_000,
        turnsObserved: 42,
      });
      expect(result.turnsObserved).toBe(42);
    });
  });

  describe("compounding shape", () => {
    it("headroom grows super-linearly as savings increase", () => {
      const base = {
        contextLimit: 1_000_000,
        avgTurnTokensWithout: 10_000,
        turnsObserved: 20,
      };
      const r1 = computeCompoundedHeadroom({ ...base, avgSavedPerTurn: 1_000 });
      const r2 = computeCompoundedHeadroom({ ...base, avgSavedPerTurn: 2_000 });
      const r4 = computeCompoundedHeadroom({ ...base, avgSavedPerTurn: 4_000 });
      const r8 = computeCompoundedHeadroom({ ...base, avgSavedPerTurn: 8_000 });

      // Each doubling of S more than doubles headroom — the compounding shape.
      expect(r2.headroomTurns).toBeGreaterThan(r1.headroomTurns * 2);
      expect(r4.headroomTurns).toBeGreaterThan(r2.headroomTurns * 2);
      expect(r8.headroomTurns).toBeGreaterThan(r4.headroomTurns * 2);
    });

    it("matches the linear floor at small S", () => {
      // Σs = 500 × 50 = 25K. δ̄_eff = 9.5K.
      // turns_earned = floor(25K / 9.5K) = 2. r/(1−r) ≈ 0.0526.
      const result = computeCompoundedHeadroom({
        contextLimit: 1_000_000,
        avgTurnTokensWithout: 10_000,
        avgSavedPerTurn: 500,
        turnsObserved: 50,
      });
      expect(result.headroomTurns).toBeGreaterThanOrEqual(2);
      expect(result.headroomTurns).toBe(2);
    });
  });
});
