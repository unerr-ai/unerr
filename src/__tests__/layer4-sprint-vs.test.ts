/**
 * Layer 4 Sprint VS: Value Surfacing tests.
 */

import { describe, expect, it } from "vitest";
import {
  formatGuardMoment,
  getDollarGate,
  shouldFireGuard,
} from "../behaviors/guard-formatter.js";
import {
  getValueSurfacingConfig,
  resetValueSurfacingConfig,
  setValueSurfacingConfig,
} from "../config/value-surfacing.js";
import { calculateDollarSavings } from "../proxy/model-pricing.js";
import { createIntelligenceCounter } from "../tracking/intelligence-counter.js";
import {
  frameGuardMoment,
  frameSessionSummary,
  frameTokenSavings,
  frameWeeklyTrend,
} from "../utils/counterfactual.js";

describe("Counterfactual Framing (VS.8)", () => {
  it("frames token savings with 'without unerr' language", () => {
    const msg = frameTokenSavings(45000, 0.135);
    expect(msg).toContain("Without unerr");
    expect(msg).toContain("45.0K");
    expect(msg).toContain("$");
  });

  it("frames guard moment with prevented cost", () => {
    const msg = frameGuardMoment("hallucination loop detected", 2.13);
    expect(msg).toContain("[unerr]");
    expect(msg).toContain("Prevented");
    expect(msg).toContain("$2.13");
  });

  it("frames session summary", () => {
    const msg = frameSessionSummary(23000, 0.069, 2);
    expect(msg).toContain("Without unerr");
    expect(msg).toContain("23.0K");
    expect(msg).toContain("2 issue(s) prevented");
  });

  it("frames session with zero events positively", () => {
    const msg = frameSessionSummary(0, 0, 0);
    expect(msg).toContain("monitoring");
    expect(msg).not.toContain("Without unerr");
  });

  it("frames weekly trend", () => {
    const msg = frameWeeklyTrend(45000, 30000, 0.135);
    expect(msg).toContain("↑");
    expect(msg).toContain("This week");
  });
});

describe("Guard Formatter (VS.4)", () => {
  it("fires guard when >$0.50 threshold", () => {
    const tokens = 200_000;
    expect(shouldFireGuard(tokens)).toBe(true);
  });

  it("does not fire guard below $0.50 threshold", () => {
    const tokens = 100;
    expect(shouldFireGuard(tokens)).toBe(false);
  });

  it("dollar gate is $0.50", () => {
    expect(getDollarGate()).toBe(0.5);
  });

  it("formatGuardMoment returns null below threshold", () => {
    const result = formatGuardMoment("test", 10);
    expect(result).toBeNull();
  });

  it("formatGuardMoment returns GuardMoment above threshold", () => {
    const result = formatGuardMoment("loop detected", 500_000);
    expect(result).not.toBeNull();
    expect(result?.passed).toBe(true);
    expect(result?.dollarsPrevented).toBeGreaterThanOrEqual(0.5);
  });
});

describe("Intelligence Counter (VS.7)", () => {
  it("tracks metrics", () => {
    const counter = createIntelligenceCounter();
    counter.record("entityCount", 847);
    counter.record("edgeCount", 2134);
    counter.record("communitiesDetected", 8);
    counter.increment("conventionsLearned");
    counter.increment("conventionsLearned");

    const metrics = counter.getMetrics();
    expect(metrics.entityCount).toBe(847);
    expect(metrics.edgeCount).toBe(2134);
    expect(metrics.conventionsLearned).toBe(2);
  });

  it("formats summary string", () => {
    const counter = createIntelligenceCounter();
    counter.record("entityCount", 1247);
    counter.record("edgeCount", 3456);
    counter.record("communitiesDetected", 12);

    const summary = counter.formatSummary();
    expect(summary).toContain("1,247 entities");
    expect(summary).toContain("3,456 edges");
    expect(summary).toContain("12 communities");
  });

  it("resets all metrics", () => {
    const counter = createIntelligenceCounter();
    counter.record("entityCount", 100);
    counter.reset();
    expect(counter.getMetrics().entityCount).toBe(0);
  });
});

describe("Value Surfacing Config (VS.9)", () => {
  it("has sensible defaults", () => {
    resetValueSurfacingConfig();
    const config = getValueSurfacingConfig();
    expect(config.guardThresholdDollars).toBe(0.5);
    expect(config.weeklyEnabled).toBe(true);
    expect(config.scorecardEnabled).toBe(true);
  });

  it("allows overrides", () => {
    setValueSurfacingConfig({ guardThresholdDollars: 1.0 });
    expect(getValueSurfacingConfig().guardThresholdDollars).toBe(1.0);
    resetValueSurfacingConfig();
  });
});
