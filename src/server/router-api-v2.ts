/**
 * Sprint P2-6: Router Dashboard v2 API endpoints.
 *
 * Extends the Phase 1 router API with intelligence data:
 *   GET /api/router/insights/v2     — Accuracy lift, prevented wrong calls, associations summary
 *   GET /api/router/associations    — Weekly association data with trigger/family breakdown
 *   GET /api/router/intent/:turn    — Per-call intent scores, family reasoning, mask decision
 *   GET /api/router/trends          — Cross-session trend data for charting
 *   POST /api/router/clear-overrides — Clear all mask overrides
 *   POST /api/router/unmask/:family — Quick unmask from dashboard
 */

import { Hono } from "hono";

import type { LiftMetrics } from "../router/reasoning/lift.js";
import type { CounterSnapshot } from "../router/reasoning/counter.js";
import type { AssociationAggregate } from "../router/associations/types.js";
import type { IntentEvaluation } from "../router/dispatch.js";
import type { OverrideState } from "../router/overrides.js";

export interface RouterApiV2Deps {
  getLiftMetrics: () => LiftMetrics | null;
  getCounterSnapshot: () => CounterSnapshot | null;
  getWeeklyAssociations: () => AssociationAggregate | null;
  getIntentEvaluation: (turnNumber: number) => IntentEvaluation | null;
  getIntentHistory: () => readonly IntentEvaluation[];
  getTrendData: () => TrendDataPoint[];
  getOverrides: () => OverrideState;
  clearOverrides: () => void;
  unmaskFamily: (family: string) => void;
}

export interface TrendDataPoint {
  readonly sessionId: string;
  readonly date: string;
  readonly accuracyLift: number;
  readonly retriesSaved: number;
  readonly maskingEffectiveness: number;
  readonly associationsDetected: number;
}

export function createRouterApiV2(deps: RouterApiV2Deps): Hono {
  const app = new Hono();

  app.get("/insights/v2", (c) => {
    const lift = deps.getLiftMetrics();
    const counter = deps.getCounterSnapshot();
    const associations = deps.getWeeklyAssociations();

    return c.json({
      data: {
        lift: lift ?? {
          accuracyLift: 0,
          retryReduction: 0,
          preventionRate: 0,
          currentAccuracy: 1.0,
          baselineAccuracy: 1.0,
          isPositive: false,
          confidence: "low",
        },
        counter: counter ?? {
          preventedWrongCalls: 0,
          totalSoftRefuses: 0,
          alternativesTaken: 0,
          alternativesSucceeded: 0,
          retriesSaved: 0,
          totalRetries: 0,
          baselineRetries: 0,
        },
        associations: associations ? {
          totalAssociations: associations.totalAssociations,
          highQualityCount: associations.highQualityCount,
          driverPercentage: associations.driverPercentage,
          topAssociations: associations.topAssociations.slice(0, 5),
        } : null,
      },
    });
  });

  app.get("/associations", (c) => {
    const associations = deps.getWeeklyAssociations();
    if (!associations) {
      return c.json({ data: null });
    }

    return c.json({
      data: {
        weekStart: associations.weekStart,
        weekEnd: associations.weekEnd,
        totalAssociations: associations.totalAssociations,
        byTriggerType: Object.fromEntries(associations.byTriggerType),
        byFamily: Object.fromEntries(associations.byFamily),
        highQualityCount: associations.highQualityCount,
        mediumQualityCount: associations.mediumQualityCount,
        lowQualityCount: associations.lowQualityCount,
        topAssociations: associations.topAssociations,
        driverPercentage: associations.driverPercentage,
      },
    });
  });

  app.get("/intent/:turn", (c) => {
    const turn = parseInt(c.req.param("turn"), 10);
    if (isNaN(turn)) {
      return c.json({ error: "Invalid turn number" }, 400);
    }

    const evaluation = deps.getIntentEvaluation(turn);
    if (!evaluation) {
      return c.json({ data: null });
    }

    return c.json({
      data: {
        turnNumber: evaluation.turnNumber,
        intentShifted: evaluation.intentShifted,
        newlyExposedFamilies: evaluation.newlyExposedFamilies,
        scores: evaluation.scorerOutput.scores.map((s) => ({
          family: s.family,
          score: s.score,
          exposed: s.exposed,
          sticky: s.sticky,
          reasons: s.reasons,
          thresholdApplied: s.thresholdApplied,
        })),
        multiDomain: evaluation.scorerOutput.multiDomain,
        latencyMs: evaluation.scorerOutput.latencyMs,
        maskedFamilies: [...evaluation.maskSnapshot.maskedFamilies],
        exposedFamilies: [...evaluation.maskSnapshot.exposedFamilies],
      },
    });
  });

  app.get("/trends", (c) => {
    const trends = deps.getTrendData();
    return c.json({ data: trends });
  });

  app.post("/clear-overrides", (c) => {
    deps.clearOverrides();
    return c.json({ ok: true });
  });

  app.post("/unmask/:family", (c) => {
    const family = c.req.param("family");
    deps.unmaskFamily(family);
    return c.json({ ok: true, family });
  });

  return app;
}
