/**
 * Sprint P0-6: Router dashboard REST API routes.
 *
 * GET /api/router/status       — Activation state, proxied servers, phase, session summary
 * GET /api/router/sessions     — All recorded session summaries (current + archived)
 * GET /api/router/sessions/:id — Per-session detail with outcome breakdown, top tools
 * GET /api/router/recent       — Last N telemetry records for live feed table
 *
 * All endpoints return gracefully when the router is disabled (enabled: false).
 */

import { Hono } from "hono";

import type { RouterConfig } from "../../config/router-config-writer.js";
import type { SessionMetricsSummary } from "../../proxy/router-session-metrics.js";
import type {
  RouterSessionSummary,
  RouterTelemetryRecord,
} from "../../proxy/router-telemetry.js";

export interface ServerHealthInfo {
  readonly id: string;
  readonly name: string;
  readonly alias: string;
  readonly status: "healthy" | "unhealthy" | "stopped" | "starting";
  readonly lastPingMs: number | null;
  readonly lastError: string | null;
  readonly restartCount: number;
  readonly lastRestartAt: string | null;
  readonly upSince: string | null;
  readonly toolCount: number;
}

export interface RouterRouteDeps {
  /** Read current router config (null when disabled). */
  getRouterConfig: () => RouterConfig | null;
  /** In-memory session summary from the running gateway. Null if no gateway active. */
  getSessionSummary: () => RouterSessionSummary | null;
  /** Read all telemetry records from current JSONL + archives. */
  readAllRecords: () => Promise<readonly RouterTelemetryRecord[]>;
  /** Aggregate records into per-session summaries. */
  aggregateRecords: (
    records: readonly RouterTelemetryRecord[]
  ) => readonly SessionMetricsSummary[];
  /** Group records by session ID. */
  groupRecords: (
    records: readonly RouterTelemetryRecord[]
  ) => ReadonlyMap<string, RouterTelemetryRecord[]>;
  /** Aggregate a single session's records. */
  aggregateSingle: (
    records: readonly RouterTelemetryRecord[]
  ) => SessionMetricsSummary | null;
  /** Get health status for all proxied child servers. */
  getServerHealth?: () => readonly ServerHealthInfo[];
  /** Restart a specific child server by ID. Returns new health status or null if not found. */
  restartServer?: (serverId: string) => Promise<ServerHealthInfo | null>;
  /** Get family nudge accuracy stats. */
  getNudgeStats?: () => {
    totalNudges: number;
    totalFollowed: number;
    accuracyRate: number | null;
  };
  /** Get alias collision rewrite count. */
  getCollisionRewriteCount?: () => number;
}

export function createRouterRoutes(deps: RouterRouteDeps): Hono {
  const app = new Hono();

  app.get("/status", (c) => {
    const start = performance.now();
    const config = deps.getRouterConfig();

    if (!config || !config.enabled) {
      return c.json({
        data: {
          enabled: false,
          phase: 0,
          proxiedServers: [],
          session: null,
        },
        _meta: {
          source: "local",
          latency_ms: Math.round((performance.now() - start) * 100) / 100,
        },
      });
    }

    const session = deps.getSessionSummary();

    return c.json({
      data: {
        enabled: true,
        enabledAt: config.enabledAt,
        phase: 0,
        proxiedServers: config.proxiedServers.map((s) => ({
          name: s.name,
          alias: s.alias,
          sourceAgent: s.sourceAgent,
        })),
        session: session
          ? {
              totalCalls: session.totalCalls,
              totalTokensSaved: session.totalTokensSaved,
              totalTokensIn: session.totalTokensIn,
              softRefuseCount: session.softRefuseCount,
              unlockCount: session.unlockCount,
              efficiency: session.efficiency,
            }
          : null,
      },
      _meta: {
        source: "local",
        latency_ms: Math.round((performance.now() - start) * 100) / 100,
      },
    });
  });

  app.get("/sessions", async (c) => {
    const start = performance.now();
    const config = deps.getRouterConfig();

    if (!config || !config.enabled) {
      return c.json({
        data: { sessions: [] },
        _meta: {
          source: "local",
          latency_ms: Math.round((performance.now() - start) * 100) / 100,
        },
      });
    }

    const records = await deps.readAllRecords();
    const summaries = deps.aggregateRecords(records);

    return c.json({
      data: {
        sessions: summaries.map((s) => ({
          sessionId: s.sessionId,
          totalCalls: s.totalCalls,
          totalTokensSaved: s.totalTokensSaved,
          totalTokensIn: s.totalTokensIn,
          softRefuseCount: s.softRefuseCount,
          unlockCount: s.unlockCount,
          efficiency: s.efficiency,
          firstCallTs: s.firstCallTs,
          lastCallTs: s.lastCallTs,
          topTools: s.topTools,
          outcomeBreakdown: s.outcomeBreakdown,
          avgLatencyMs: s.avgLatencyMs,
        })),
      },
      _meta: {
        source: "local",
        latency_ms: Math.round((performance.now() - start) * 100) / 100,
      },
    });
  });

  app.get("/sessions/:id", async (c) => {
    const start = performance.now();
    const sessionId = c.req.param("id");
    const config = deps.getRouterConfig();

    if (!config || !config.enabled) {
      return c.json(
        {
          error: "Router is not enabled",
          _meta: {
            source: "local",
            latency_ms: Math.round((performance.now() - start) * 100) / 100,
          },
        },
        404
      );
    }

    const records = await deps.readAllRecords();
    const grouped = deps.groupRecords(records);
    const sessionRecords = grouped.get(sessionId);

    if (!sessionRecords || sessionRecords.length === 0) {
      return c.json(
        {
          error: "Session not found",
          _meta: {
            source: "local",
            latency_ms: Math.round((performance.now() - start) * 100) / 100,
          },
        },
        404
      );
    }

    const summary = deps.aggregateSingle(sessionRecords);
    if (!summary) {
      return c.json(
        {
          error: "Session has no records",
          _meta: {
            source: "local",
            latency_ms: Math.round((performance.now() - start) * 100) / 100,
          },
        },
        404
      );
    }

    return c.json({
      data: {
        ...summary,
        records: sessionRecords.slice(-50),
      },
      _meta: {
        source: "local",
        latency_ms: Math.round((performance.now() - start) * 100) / 100,
      },
    });
  });

  app.get("/recent", async (c) => {
    const start = performance.now();
    const limitParam = c.req.query("limit");
    const limit = limitParam
      ? Math.min(Number.parseInt(limitParam, 10), 100)
      : 20;

    const config = deps.getRouterConfig();
    if (!config || !config.enabled) {
      return c.json({
        data: { records: [] },
        _meta: {
          source: "local",
          latency_ms: Math.round((performance.now() - start) * 100) / 100,
        },
      });
    }

    const records = await deps.readAllRecords();

    return c.json({
      data: { records: records.slice(-limit) },
      _meta: {
        source: "local",
        latency_ms: Math.round((performance.now() - start) * 100) / 100,
      },
    });
  });

  // ── Server health endpoints ─────────────────────────────────────

  app.get("/servers", (c) => {
    const start = performance.now();

    if (!deps.getServerHealth) {
      return c.json({
        data: { servers: [] },
        _meta: {
          source: "local",
          latency_ms: Math.round((performance.now() - start) * 100) / 100,
          hint: "Server health tracking not active",
        },
      });
    }

    const servers = deps.getServerHealth();

    return c.json({
      data: { servers },
      _meta: {
        source: "local",
        latency_ms: Math.round((performance.now() - start) * 100) / 100,
      },
    });
  });

  app.post("/servers/:id/restart", async (c) => {
    const start = performance.now();
    const serverId = c.req.param("id");

    if (!deps.restartServer) {
      return c.json(
        {
          error: "Server restart not available (gateway not running)",
          _meta: {
            source: "local",
            latency_ms: Math.round((performance.now() - start) * 100) / 100,
          },
        },
        503
      );
    }

    const result = await deps.restartServer(serverId);

    if (!result) {
      return c.json(
        {
          error: `Server "${serverId}" not found`,
          _meta: {
            source: "local",
            latency_ms: Math.round((performance.now() - start) * 100) / 100,
          },
        },
        404
      );
    }

    return c.json({
      data: { server: result },
      _meta: {
        source: "local",
        latency_ms: Math.round((performance.now() - start) * 100) / 100,
      },
    });
  });

  // ── Router insights endpoint ────────────────────────────────────

  app.get("/insights", (c) => {
    const start = performance.now();

    const nudgeStats = deps.getNudgeStats?.() ?? {
      totalNudges: 0,
      totalFollowed: 0,
      accuracyRate: null,
    };
    const collisionRewrites = deps.getCollisionRewriteCount?.() ?? 0;

    return c.json({
      data: {
        nudgeAccuracy: nudgeStats,
        collisionRewrites,
      },
      _meta: {
        source: "local",
        latency_ms: Math.round((performance.now() - start) * 100) / 100,
      },
    });
  });

  return app;
}
