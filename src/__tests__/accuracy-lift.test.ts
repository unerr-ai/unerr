import { describe, expect, it } from "vitest";

import {
  type BaselineStats,
  analyzeSession,
  computeBaseline,
} from "../router/reasoning/baseline.js";
import type { CounterSnapshot } from "../router/reasoning/counter.js";
import {
  type LiftInput,
  computeLift,
  formatLiftSummary,
} from "../router/reasoning/lift.js";
import type { ToolCallTrace } from "../router/reasoning/wrong-call-detector.js";

function makeTrace(
  overrides: Partial<ToolCallTrace> & { toolName: string; family: string }
): ToolCallTrace {
  return {
    turnNumber: 0,
    timestamp: Date.now(),
    outcome: "success",
    responseTokens: 200,
    ...overrides,
  };
}

function makeSession(wrongCallRatio: number, totalCalls: number) {
  const traces: ToolCallTrace[] = [];
  let ts = 1000;
  const wrongCount = Math.floor(totalCalls * wrongCallRatio);

  for (let i = 0; i < totalCalls; i++) {
    if (i < wrongCount) {
      traces.push(
        makeTrace({
          toolName: "tool_a",
          family: "pg",
          outcome: "empty",
          turnNumber: i,
          timestamp: ts,
        })
      );
      ts += 500;
      traces.push(
        makeTrace({
          toolName: "tool_b",
          family: "pg",
          turnNumber: i,
          timestamp: ts,
        })
      );
    } else {
      traces.push(
        makeTrace({
          toolName: "tool_ok",
          family: "pg",
          responseTokens: 300,
          turnNumber: i,
          timestamp: ts,
        })
      );
    }
    ts += 2000;
  }
  return traces;
}

describe("Baseline computation", () => {
  it("empty sessions returns perfect accuracy", () => {
    const stats = computeBaseline([]);
    expect(stats.sessionCount).toBe(0);
    expect(stats.averageAccuracy).toBe(1.0);
    expect(stats.averageRetries).toBe(0);
  });

  it("single perfect session = 1.0 accuracy", () => {
    const traces = Array.from({ length: 20 }, (_, i) =>
      makeTrace({
        toolName: "file_read",
        family: "unerr",
        turnNumber: i,
        timestamp: i * 2000,
        responseTokens: 500,
      })
    );
    const stats = computeBaseline([{ sessionId: "s1", traces }]);
    expect(stats.sessionCount).toBe(1);
    expect(stats.averageAccuracy).toBe(1.0);
    expect(stats.totalCalls).toBe(20);
  });

  it("sessions with wrong calls produce lower accuracy", () => {
    const traces = makeSession(0.3, 10);
    const stats = computeBaseline([{ sessionId: "s1", traces }]);
    expect(stats.averageAccuracy).toBeLessThan(1.0);
    expect(stats.averageWrongCallRate).toBeGreaterThan(0);
  });

  it("multiple sessions are averaged", () => {
    const perfect = Array.from({ length: 20 }, (_, i) =>
      makeTrace({
        toolName: "file_read",
        family: "unerr",
        turnNumber: i,
        timestamp: i * 2000,
        responseTokens: 500,
      })
    );
    const bad = makeSession(0.5, 10);

    const stats = computeBaseline([
      { sessionId: "perfect", traces: perfect },
      { sessionId: "bad", traces: bad },
    ]);

    expect(stats.sessionCount).toBe(2);
    expect(stats.averageAccuracy).toBeGreaterThan(0.5);
    expect(stats.averageAccuracy).toBeLessThan(1.0);
  });
});

describe("analyzeSession", () => {
  it("returns session-level metrics", () => {
    const traces = makeSession(0.2, 10);
    const analysis = analyzeSession("test-session", traces);

    expect(analysis.sessionId).toBe("test-session");
    expect(analysis.totalCalls).toBe(traces.length);
    expect(analysis.wrongCalls).toBeGreaterThanOrEqual(0);
    expect(analysis.accuracy).toBeGreaterThanOrEqual(0);
    expect(analysis.accuracy).toBeLessThanOrEqual(1);
  });
});

describe("Lift computation", () => {
  const goodBaseline: BaselineStats = {
    sessionCount: 10,
    averageAccuracy: 0.7,
    averageRetries: 8,
    averageWrongCallRate: 0.3,
    totalCalls: 400,
  };

  const goodCounter: CounterSnapshot = {
    preventedWrongCalls: 5,
    totalSoftRefuses: 8,
    alternativesTaken: 6,
    alternativesSucceeded: 5,
    retriesSaved: 5,
    totalRetries: 3,
    baselineRetries: 8,
  };

  it("positive lift when current accuracy > baseline", () => {
    const input: LiftInput = {
      baseline: goodBaseline,
      currentAccuracy: 0.9,
      counter: goodCounter,
      sessionCalls: 40,
    };
    const lift = computeLift(input);
    expect(lift.accuracyLift).toBeCloseTo(0.2);
    expect(lift.isPositive).toBe(true);
    expect(lift.confidence).toBe("high");
  });

  it("negative lift when current accuracy < baseline", () => {
    const input: LiftInput = {
      baseline: goodBaseline,
      currentAccuracy: 0.6,
      counter: goodCounter,
      sessionCalls: 40,
    };
    const lift = computeLift(input);
    expect(lift.accuracyLift).toBeCloseTo(-0.1);
    expect(lift.isPositive).toBe(false);
  });

  it("zero lift when accuracy matches baseline", () => {
    const input: LiftInput = {
      baseline: goodBaseline,
      currentAccuracy: 0.7,
      counter: goodCounter,
      sessionCalls: 40,
    };
    const lift = computeLift(input);
    expect(lift.accuracyLift).toBeCloseTo(0);
  });

  it("retry reduction computed correctly", () => {
    const input: LiftInput = {
      baseline: goodBaseline,
      currentAccuracy: 0.85,
      counter: goodCounter,
      sessionCalls: 30,
    };
    const lift = computeLift(input);
    expect(lift.retryReduction).toBe(5);
  });

  it("prevention rate = prevented / totalSoftRefuses", () => {
    const input: LiftInput = {
      baseline: goodBaseline,
      currentAccuracy: 0.85,
      counter: goodCounter,
      sessionCalls: 30,
    };
    const lift = computeLift(input);
    expect(lift.preventionRate).toBeCloseTo(5 / 8);
  });

  it("zero soft refuses = 0 prevention rate", () => {
    const input: LiftInput = {
      baseline: goodBaseline,
      currentAccuracy: 0.85,
      counter: { ...goodCounter, totalSoftRefuses: 0, preventedWrongCalls: 0 },
      sessionCalls: 30,
    };
    const lift = computeLift(input);
    expect(lift.preventionRate).toBe(0);
  });
});

describe("Lift confidence levels", () => {
  const baseline: BaselineStats = {
    sessionCount: 10,
    averageAccuracy: 0.7,
    averageRetries: 8,
    averageWrongCallRate: 0.3,
    totalCalls: 400,
  };

  const counter: CounterSnapshot = {
    preventedWrongCalls: 3,
    totalSoftRefuses: 5,
    alternativesTaken: 4,
    alternativesSucceeded: 3,
    retriesSaved: 3,
    totalRetries: 5,
    baselineRetries: 8,
  };

  it("high confidence: ≥30 calls + ≥5 baseline sessions", () => {
    const lift = computeLift({
      baseline,
      currentAccuracy: 0.85,
      counter,
      sessionCalls: 30,
    });
    expect(lift.confidence).toBe("high");
  });

  it("medium confidence: ≥15 calls", () => {
    const lift = computeLift({
      baseline: { ...baseline, sessionCount: 2 },
      currentAccuracy: 0.85,
      counter,
      sessionCalls: 20,
    });
    expect(lift.confidence).toBe("medium");
  });

  it("medium confidence: ≥3 baseline sessions", () => {
    const lift = computeLift({
      baseline: { ...baseline, sessionCount: 3 },
      currentAccuracy: 0.85,
      counter,
      sessionCalls: 10,
    });
    expect(lift.confidence).toBe("medium");
  });

  it("low confidence: few calls + few sessions", () => {
    const lift = computeLift({
      baseline: { ...baseline, sessionCount: 1 },
      currentAccuracy: 0.85,
      counter,
      sessionCalls: 5,
    });
    expect(lift.confidence).toBe("low");
  });
});

describe("formatLiftSummary", () => {
  it("formats positive lift correctly", () => {
    const lift = computeLift({
      baseline: {
        sessionCount: 10,
        averageAccuracy: 0.7,
        averageRetries: 8,
        averageWrongCallRate: 0.3,
        totalCalls: 400,
      },
      currentAccuracy: 0.9,
      counter: {
        preventedWrongCalls: 5,
        totalSoftRefuses: 8,
        alternativesTaken: 6,
        alternativesSucceeded: 5,
        retriesSaved: 5,
        totalRetries: 3,
        baselineRetries: 8,
      },
      sessionCalls: 40,
    });
    const summary = formatLiftSummary(lift);
    expect(summary).toContain("+20.0%");
    expect(summary).toContain("90% vs 70% baseline");
    expect(summary).toContain("5.0 fewer retries");
    expect(summary).toContain("Confidence: high");
  });

  it("formats negative lift correctly", () => {
    const lift = computeLift({
      baseline: {
        sessionCount: 10,
        averageAccuracy: 0.8,
        averageRetries: 4,
        averageWrongCallRate: 0.2,
        totalCalls: 400,
      },
      currentAccuracy: 0.7,
      counter: {
        preventedWrongCalls: 1,
        totalSoftRefuses: 3,
        alternativesTaken: 2,
        alternativesSucceeded: 1,
        retriesSaved: 0,
        totalRetries: 6,
        baselineRetries: 4,
      },
      sessionCalls: 40,
    });
    const summary = formatLiftSummary(lift);
    expect(summary).toContain("-10.0%");
    expect(summary).toContain("more retries");
  });
});

describe("Verification gate: 40-turn session lift", () => {
  it("routed session has better accuracy than unrouted baseline", () => {
    const unroutedTraces = makeSession(0.25, 20);
    const baseline = computeBaseline([
      { sessionId: "unrouted-1", traces: unroutedTraces },
      { sessionId: "unrouted-2", traces: makeSession(0.3, 20) },
      { sessionId: "unrouted-3", traces: makeSession(0.2, 20) },
      { sessionId: "unrouted-4", traces: makeSession(0.25, 20) },
      { sessionId: "unrouted-5", traces: makeSession(0.28, 20) },
    ]);

    const routedTraces = makeSession(0.05, 40);
    const routedAnalysis = analyzeSession("routed-1", routedTraces);

    const lift = computeLift({
      baseline,
      currentAccuracy: routedAnalysis.accuracy,
      counter: {
        preventedWrongCalls: 6,
        totalSoftRefuses: 10,
        alternativesTaken: 8,
        alternativesSucceeded: 6,
        retriesSaved: 4,
        totalRetries: 4,
        baselineRetries: 8,
      },
      sessionCalls: routedTraces.length,
    });

    expect(lift.isPositive).toBe(true);
    expect(lift.accuracyLift).toBeGreaterThan(0);
    expect(lift.confidence).toBe("high");
    expect(lift.retryReduction).toBeGreaterThan(0);
  });
});
