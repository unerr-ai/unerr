/**
 * Sprint P2-6: Router Dashboard v2 tests.
 *
 * Validates:
 *   - API v2 endpoint response shapes
 *   - Insights v2 with lift/counter/associations
 *   - Intent endpoint per-turn lookup
 *   - Associations endpoint weekly aggregation
 *   - Trends endpoint cross-session data
 *   - Clear-overrides and unmask actions
 */

import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AssociationAggregate } from "../router/associations/types.js";
import type { IntentEvaluation } from "../router/dispatch.js";
import type { CounterSnapshot } from "../router/reasoning/counter.js";
import type { LiftMetrics } from "../router/reasoning/lift.js";
import {
  type RouterApiV2Deps,
  type TrendDataPoint,
  createRouterApiV2,
} from "../server/router-api-v2.js";

function makeLift(overrides: Partial<LiftMetrics> = {}): LiftMetrics {
  return {
    accuracyLift: 0.15,
    retryReduction: 3,
    preventionRate: 0.6,
    currentAccuracy: 0.85,
    baselineAccuracy: 0.7,
    isPositive: true,
    confidence: "medium" as const,
    ...overrides,
  };
}

function makeCounter(
  overrides: Partial<CounterSnapshot> = {}
): CounterSnapshot {
  return {
    preventedWrongCalls: 4,
    totalSoftRefuses: 8,
    alternativesTaken: 5,
    alternativesSucceeded: 4,
    retriesSaved: 3,
    totalRetries: 5,
    baselineRetries: 8,
    ...overrides,
  };
}

function makeAssociations(
  overrides: Partial<AssociationAggregate> = {}
): AssociationAggregate {
  return {
    weekStart: "2026-05-11T00:00:00.000Z",
    weekEnd: "2026-05-17T23:59:59.999Z",
    totalAssociations: 12,
    byTriggerType: new Map([
      ["ur_tag", 8],
      ["nudge", 4],
    ]),
    byFamily: new Map([
      ["db", 7],
      ["github", 5],
    ]),
    highQualityCount: 6,
    mediumQualityCount: 4,
    lowQualityCount: 2,
    topAssociations: [
      {
        triggerType: "ur_tag",
        triggerDetail: "ur|rsk",
        family: "db",
        count: 5,
        avgQuality: 0.8,
      },
      {
        triggerType: "nudge",
        triggerDetail: "file_pattern",
        family: "github",
        count: 3,
        avgQuality: 0.6,
      },
    ],
    driverPercentage: 0.35,
    ...overrides,
  };
}

function makeEvaluation(turn: number): IntentEvaluation {
  return {
    turnNumber: turn,
    intentShifted: turn > 1,
    newlyExposedFamilies: turn > 1 ? ["github"] : [],
    scorerOutput: {
      scores: [
        {
          family: "db",
          score: 0.8,
          exposed: true,
          sticky: false,
          reasons: ["entity tag: postgres"],
          thresholdApplied: 0.3,
        },
        {
          family: "github",
          score: 0.2,
          exposed: false,
          sticky: false,
          reasons: ["no signal"],
          thresholdApplied: 0.3,
        },
      ],
      exposedFamilies: new Set(["db"]),
      multiDomain: false,
      latencyMs: 1.2,
      budgetExceeded: false,
    },
    maskSnapshot: {
      decisions: [],
      maskedFamilies: new Set(["github", "slack"]),
      exposedFamilies: new Set(["db", "unerr"]),
      overriddenFamilies: new Set(),
    },
  };
}

function makeTrends(): TrendDataPoint[] {
  return [
    {
      sessionId: "s1",
      date: "2026-05-15T10:00:00Z",
      accuracyLift: 0.1,
      retriesSaved: 2,
      maskingEffectiveness: 0.7,
      associationsDetected: 5,
    },
    {
      sessionId: "s2",
      date: "2026-05-16T10:00:00Z",
      accuracyLift: 0.15,
      retriesSaved: 4,
      maskingEffectiveness: 0.75,
      associationsDetected: 8,
    },
    {
      sessionId: "s3",
      date: "2026-05-17T10:00:00Z",
      accuracyLift: 0.2,
      retriesSaved: 6,
      maskingEffectiveness: 0.8,
      associationsDetected: 12,
    },
  ];
}

function createTestApp(overrides: Partial<RouterApiV2Deps> = {}): Hono {
  const deps: RouterApiV2Deps = {
    getLiftMetrics: () => makeLift(),
    getCounterSnapshot: () => makeCounter(),
    getWeeklyAssociations: () => makeAssociations(),
    getIntentEvaluation: (turn: number) => makeEvaluation(turn),
    getIntentHistory: () => [makeEvaluation(0), makeEvaluation(1)],
    getTrendData: () => makeTrends(),
    getOverrides: () => ({
      unmasked: [],
      masked: [],
      unmaskAll: false,
      updatedAt: "",
    }),
    clearOverrides: vi.fn(),
    unmaskFamily: vi.fn(),
    ...overrides,
  };

  const app = new Hono();
  app.route("/api/router", createRouterApiV2(deps));
  return app;
}

describe("Router Dashboard v2 API", () => {
  // ── /insights/v2 ──────────────────────────────────────────────────────────

  describe("GET /api/router/insights/v2", () => {
    it("returns lift + counter + association summary", async () => {
      const app = createTestApp();
      const res = await app.request("/api/router/insights/v2");
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.data.lift.accuracyLift).toBe(0.15);
      expect(body.data.lift.confidence).toBe("medium");
      expect(body.data.counter.preventedWrongCalls).toBe(4);
      expect(body.data.counter.retriesSaved).toBe(3);
      expect(body.data.associations.totalAssociations).toBe(12);
      expect(body.data.associations.driverPercentage).toBe(0.35);
      expect(body.data.associations.topAssociations).toHaveLength(2);
    });

    it("returns defaults when no data available", async () => {
      const app = createTestApp({
        getLiftMetrics: () => null,
        getCounterSnapshot: () => null,
        getWeeklyAssociations: () => null,
      });
      const res = await app.request("/api/router/insights/v2");
      const body = await res.json();

      expect(body.data.lift.accuracyLift).toBe(0);
      expect(body.data.lift.confidence).toBe("low");
      expect(body.data.counter.preventedWrongCalls).toBe(0);
      expect(body.data.associations).toBeNull();
    });

    it("caps top associations at 5", async () => {
      const assoc = makeAssociations({
        topAssociations: Array.from({ length: 10 }, (_, i) => ({
          triggerType: "ur_tag",
          triggerDetail: `detail_${i}`,
          family: "db",
          count: 10 - i,
          avgQuality: 0.5,
        })),
      });
      const app = createTestApp({ getWeeklyAssociations: () => assoc });
      const res = await app.request("/api/router/insights/v2");
      const body = await res.json();
      expect(body.data.associations.topAssociations).toHaveLength(5);
    });
  });

  // ── /associations ─────────────────────────────────────────────────────────

  describe("GET /api/router/associations", () => {
    it("returns full weekly breakdown", async () => {
      const app = createTestApp();
      const res = await app.request("/api/router/associations");
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.data.totalAssociations).toBe(12);
      expect(body.data.byTriggerType.ur_tag).toBe(8);
      expect(body.data.byFamily.db).toBe(7);
      expect(body.data.highQualityCount).toBe(6);
      expect(body.data.driverPercentage).toBe(0.35);
    });

    it("returns null data when no associations", async () => {
      const app = createTestApp({ getWeeklyAssociations: () => null });
      const res = await app.request("/api/router/associations");
      const body = await res.json();
      expect(body.data).toBeNull();
    });
  });

  // ── /intent/:turn ─────────────────────────────────────────────────────────

  describe("GET /api/router/intent/:turn", () => {
    it("returns per-turn intent evaluation", async () => {
      const app = createTestApp();
      const res = await app.request("/api/router/intent/1");
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.data.turnNumber).toBe(1);
      expect(body.data.intentShifted).toBe(false);
      expect(body.data.scores).toHaveLength(2);
      expect(body.data.scores[0].family).toBe("db");
      expect(body.data.scores[0].score).toBe(0.8);
      expect(body.data.maskedFamilies).toContain("github");
      expect(body.data.exposedFamilies).toContain("db");
    });

    it("returns 400 for invalid turn number", async () => {
      const app = createTestApp();
      const res = await app.request("/api/router/intent/abc");
      expect(res.status).toBe(400);
    });

    it("returns null for unknown turn", async () => {
      const app = createTestApp({ getIntentEvaluation: () => null });
      const res = await app.request("/api/router/intent/999");
      const body = await res.json();
      expect(body.data).toBeNull();
    });

    it("includes shift info for turn > 1", async () => {
      const app = createTestApp();
      const res = await app.request("/api/router/intent/2");
      const body = await res.json();
      expect(body.data.intentShifted).toBe(true);
      expect(body.data.newlyExposedFamilies).toContain("github");
    });
  });

  // ── /trends ───────────────────────────────────────────────────────────────

  describe("GET /api/router/trends", () => {
    it("returns cross-session trend data", async () => {
      const app = createTestApp();
      const res = await app.request("/api/router/trends");
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.data).toHaveLength(3);
      expect(body.data[0].sessionId).toBe("s1");
      expect(body.data[2].accuracyLift).toBe(0.2);
    });

    it("returns empty array when no sessions", async () => {
      const app = createTestApp({ getTrendData: () => [] });
      const res = await app.request("/api/router/trends");
      const body = await res.json();
      expect(body.data).toEqual([]);
    });
  });

  // ── POST actions ──────────────────────────────────────────────────────────

  describe("POST /api/router/clear-overrides", () => {
    it("calls clearOverrides and returns ok", async () => {
      const clearFn = vi.fn();
      const app = createTestApp({ clearOverrides: clearFn });
      const res = await app.request("/api/router/clear-overrides", {
        method: "POST",
      });
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.ok).toBe(true);
      expect(clearFn).toHaveBeenCalledOnce();
    });
  });

  describe("POST /api/router/unmask/:family", () => {
    it("calls unmaskFamily with correct family", async () => {
      const unmaskFn = vi.fn();
      const app = createTestApp({ unmaskFamily: unmaskFn });
      const res = await app.request("/api/router/unmask/github", {
        method: "POST",
      });
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.ok).toBe(true);
      expect(body.family).toBe("github");
      expect(unmaskFn).toHaveBeenCalledWith("github");
    });
  });

  // ── Confidence level rendering ────────────────────────────────────────────

  describe("confidence levels", () => {
    it.each([
      { confidence: "high" as const, lift: 0.25 },
      { confidence: "medium" as const, lift: 0.1 },
      { confidence: "low" as const, lift: 0.02 },
    ])(
      "returns $confidence confidence correctly",
      async ({ confidence, lift }) => {
        const app = createTestApp({
          getLiftMetrics: () => makeLift({ confidence, accuracyLift: lift }),
        });
        const res = await app.request("/api/router/insights/v2");
        const body = await res.json();
        expect(body.data.lift.confidence).toBe(confidence);
        expect(body.data.lift.accuracyLift).toBe(lift);
      }
    );
  });

  // ── Edge cases ────────────────────────────────────────────────────────────

  describe("edge cases", () => {
    it("handles zero-division in prevention rate gracefully", async () => {
      const app = createTestApp({
        getCounterSnapshot: () =>
          makeCounter({ totalSoftRefuses: 0, preventedWrongCalls: 0 }),
      });
      const res = await app.request("/api/router/insights/v2");
      const body = await res.json();
      expect(body.data.counter.totalSoftRefuses).toBe(0);
      expect(body.data.counter.preventedWrongCalls).toBe(0);
    });

    it("handles negative accuracy lift", async () => {
      const app = createTestApp({
        getLiftMetrics: () =>
          makeLift({ accuracyLift: -0.05, isPositive: false }),
      });
      const res = await app.request("/api/router/insights/v2");
      const body = await res.json();
      expect(body.data.lift.accuracyLift).toBe(-0.05);
      expect(body.data.lift.isPositive).toBe(false);
    });

    it("serializes Map-based fields as plain objects", async () => {
      const app = createTestApp();
      const res = await app.request("/api/router/associations");
      const body = await res.json();
      expect(typeof body.data.byTriggerType).toBe("object");
      expect(body.data.byTriggerType.ur_tag).toBe(8);
    });
  });
});
