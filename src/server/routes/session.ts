/**
 * Layer 7: Session API — live counters, efficiency, intents, shadow ledger.
 */

import { Hono } from "hono";
import {
  computePercentiles,
  totalCaughtEvents,
} from "../../proxy/session-stats.js";
import type { SessionStats } from "../../proxy/session-stats.js";
import type { IntentGroup } from "../../tracking/intent-token-tracker.js";
import type { LedgerEntry } from "../../tracking/shadow-ledger.js";

export interface SessionRouteDeps {
  stats: SessionStats;
  getEfficiencySnapshot: () => {
    totalCalls: number;
    savedTokens: number;
    efficiency: number;
  } | null;
  getIntentGroups: () => IntentGroup[];
  getRecentLedgerEntries: (limit: number) => LedgerEntry[];
}

function parseLimit(
  raw: string | undefined,
  fallback: number,
  max: number,
): number {
  const n = Number.parseInt(raw ?? "", 10);
  if (Number.isNaN(n) || n < 1) return fallback;
  return Math.min(n, max);
}

export function createSessionRoutes(deps: SessionRouteDeps): Hono {
  const app = new Hono();

  app.get("/stats", async (c) => {
    const start = performance.now();
    const s = deps.stats;
    const localP = computePercentiles(
      s.latency.localSamples,
      s.latency.localTotalSamples,
    );

    return c.json({
      data: {
        tool_calls: s.toolCallsLocal,
        estimated_tokens_saved: s.estimatedTokensSaved,
        violations_caught: s.violationsCaught,
        risk_warnings_issued: s.riskWarningsIssued,
        session_started_at: new Date(s.sessionStartedAt).toISOString(),
        is_resumed_session: s.isResumedSession,
        previous_session: s.previousSession,
        caught_events: {
          ...s.events,
          total: totalCaughtEvents(s.events),
        },
        latency_ms: localP
          ? {
              p50: localP.p50,
              p95: localP.p95,
              p99: localP.p99,
              min: localP.min,
              max: localP.max,
              count: localP.count,
            }
          : null,
        local_mode: s.localMode,
      },
      _meta: {
        source: "local",
        latency_ms: Math.round((performance.now() - start) * 100) / 100,
      },
    });
  });

  app.get("/efficiency", async (c) => {
    const start = performance.now();
    const snap = deps.getEfficiencySnapshot();
    return c.json({
      data: snap,
      _meta: {
        source: "local",
        latency_ms: Math.round((performance.now() - start) * 100) / 100,
      },
    });
  });

  app.get("/intents", async (c) => {
    const start = performance.now();
    const groups = deps.getIntentGroups();
    return c.json({
      data: groups,
      _meta: {
        source: "local",
        count: groups.length,
        latency_ms: Math.round((performance.now() - start) * 100) / 100,
      },
    });
  });

  app.get("/ledger", async (c) => {
    const start = performance.now();
    const limit = parseLimit(c.req.query("limit"), 50, 200);
    const entries = deps.getRecentLedgerEntries(limit);
    return c.json({
      data: entries,
      _meta: {
        source: "local",
        count: entries.length,
        latency_ms: Math.round((performance.now() - start) * 100) / 100,
      },
    });
  });

  return app;
}
