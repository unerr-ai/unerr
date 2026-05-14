/**
 * Sprint S8: Value Surfacing — Tests
 *
 * S8.1: Guard fires once when threshold crossed
 * S8.2: Per-response _meta has optimization + powered_by
 * S8.3: Scorecard formats correctly
 * S8.4: Weekly accumulator persists and resets
 * S8.7: Counterfactual explanation format
 */

import { beforeEach, describe, expect, it } from "vitest";
import {
  type ScorecardInput,
  assembleValueMeta,
  createValueGuard,
  formatCounterfactual,
  formatScorecard,
  resetValueSurfacingConfig,
} from "../config/value-surfacing.js";
import {
  type SessionAccumulatorInput,
  accumulateSession,
  formatStatsReport,
  loadStats,
} from "../tracking/weekly-accumulator.js";

// ── S8.1: Value Guard ──────────────────────────────────────────────

describe("S8.1: Value Guard", () => {
  it("does not fire below threshold", () => {
    const guard = createValueGuard(1.0);
    expect(guard.check(0.49)).toBeNull();
    expect(guard.hasFired()).toBe(false);
  });

  it("fires once when threshold crossed", () => {
    const guard = createValueGuard(0.5);
    const msg = guard.check(0.75);
    expect(msg).toContain("$0.75");
    expect(guard.hasFired()).toBe(true);
  });

  it("does not fire a second time", () => {
    const guard = createValueGuard(0.5);
    guard.check(0.6); // fires
    expect(guard.check(1.0)).toBeNull(); // already fired
  });

  it("resets correctly", () => {
    const guard = createValueGuard(0.5);
    guard.check(0.6);
    guard.reset();
    expect(guard.hasFired()).toBe(false);
    const msg = guard.check(0.8);
    expect(msg).toContain("$0.80");
  });
});

// ── S8.2: Per-response _meta ───────────────────────────────────────

describe("S8.2: Value Meta Assembly", () => {
  it("assembles basic meta fields", () => {
    const meta = assembleValueMeta(1500, 0.009);
    expect(meta.tokens_saved).toBe(1500);
    expect(meta.dollar_savings).toBe(0.009);
    expect(meta.powered_by).toContain("unerr");
    expect(meta.optimization).toBeUndefined();
  });

  it("includes optimization description when provided", () => {
    const meta = assembleValueMeta(3000, 0.018, "blast_radius served 7 files");
    expect(meta.optimization).toBe("blast_radius served 7 files");
  });

  it("rounds dollar savings to 6 decimal places", () => {
    const meta = assembleValueMeta(100, 0.0001234567);
    expect(meta.dollar_savings).toBe(0.000123);
  });
});

// ── S8.3: Session Scorecard ────────────────────────────────────────

describe("S8.3: Session Scorecard", () => {
  it("formats basic scorecard", () => {
    const input: ScorecardInput = {
      toolCalls: 47,
      tokensSaved: 45200,
      dollarsSaved: 0.27,
      efficiency: 73,
      durationMs: 12 * 60_000,
      blastRadiusComputed: 4,
      conventionsInjected: 3,
      outputsCompressed: 12,
      correctionsApplied: 2,
      wrongApproachesPrevented: 0,
    };
    const sc = formatScorecard(input);
    expect(sc.toolCalls).toBe(47);
    expect(sc.tokensSaved).toBe("45.2K");
    expect(sc.dollarsSaved).toBe("$0.27");
    expect(sc.efficiency).toBe("73%");
    expect(sc.duration).toBe("12 min");
    expect(sc.intelligenceApplied).toContain("4 blast radius computations");
    expect(sc.intelligenceApplied).toContain("3 convention injections");
    expect(sc.intelligenceApplied).toContain("12 outputs compressed");
    expect(sc.intelligenceApplied).toContain("2 corrections applied");
  });

  it("handles zero duration", () => {
    const input: ScorecardInput = {
      toolCalls: 3,
      tokensSaved: 500,
      dollarsSaved: 0.003,
      efficiency: 50,
      durationMs: 20_000,
      blastRadiusComputed: 0,
      conventionsInjected: 0,
      outputsCompressed: 0,
      correctionsApplied: 0,
      wrongApproachesPrevented: 0,
    };
    const sc = formatScorecard(input);
    expect(sc.duration).toBe("<1 min");
    expect(sc.intelligenceApplied).toHaveLength(0);
  });

  it("formats million tokens", () => {
    const input: ScorecardInput = {
      toolCalls: 200,
      tokensSaved: 1_500_000,
      dollarsSaved: 9.0,
      efficiency: 85,
      durationMs: 45 * 60_000,
      blastRadiusComputed: 10,
      conventionsInjected: 5,
      outputsCompressed: 30,
      correctionsApplied: 4,
      wrongApproachesPrevented: 2,
    };
    const sc = formatScorecard(input);
    expect(sc.tokensSaved).toBe("1.5M");
    expect(sc.intelligenceApplied).toContain("2 wrong approaches prevented");
  });
});

// ── S8.4: Weekly Accumulator ───────────────────────────────────────

describe("S8.4: Weekly Accumulator", () => {
  it("loadStats returns valid empty structure", () => {
    const stats = loadStats();
    expect(stats.version).toBe(1);
    expect(stats.weekly.sessions).toBeGreaterThanOrEqual(0);
    expect(stats.allTime.totalSessions).toBeGreaterThanOrEqual(0);
    expect(stats.lastUpdated).toBeDefined();
  });

  it("formatStatsReport produces readable output", () => {
    const stats = loadStats();
    // Seed some data for formatting
    stats.weekly.sessions = 5;
    stats.weekly.tokensSaved = 280_000;
    stats.weekly.dollarsSaved = 1.68;
    stats.weekly.avgEfficiency = 73;
    stats.weekly.violationsCaught = 12;
    stats.allTime.totalSessions = 20;
    stats.allTime.totalTokensSaved = 1_200_000;
    stats.allTime.totalDollarsSaved = 7.2;
    stats.allTime.totalViolationsCaught = 45;

    const report = formatStatsReport(stats);
    expect(report).toContain("This week:");
    expect(report).toContain("All time:");
    expect(report).toContain("$1.68");
    expect(report).toContain("280.0K");
    expect(report).toContain("73%");
    expect(report).toContain("1.2M");
  });
});

// ── S8.7: Counterfactual Explanation ───────────────────────────────

describe("S8.7: Counterfactual Explanation", () => {
  it("formats basic counterfactual", () => {
    const result = formatCounterfactual(100_000, 35_000);
    expect(result).toContain("Without unerr: ~100.0K tokens");
    expect(result).toContain("with unerr: 35.0K tokens");
    expect(result).toContain("65% reduction");
  });

  it("handles zero tokens without", () => {
    const result = formatCounterfactual(0, 0);
    expect(result).toContain("0% reduction");
  });

  it("formats millions", () => {
    const result = formatCounterfactual(2_000_000, 600_000);
    expect(result).toContain("2.0M");
    expect(result).toContain("600.0K");
    expect(result).toContain("70% reduction");
  });
});
