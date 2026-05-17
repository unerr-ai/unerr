/**
 * Sprint P0-6 — Router Dashboard API route tests.
 *
 * Tests the Hono route handler directly (no HTTP server).
 * Covers:
 *   - /api/router/status: enabled/disabled states
 *   - /api/router/sessions: list, empty, aggregation
 *   - /api/router/sessions/:id: detail, 404
 *   - /api/router/recent: last N records, disabled state
 *   - SSE emitters: fire-and-forget event delivery
 */

import { describe, expect, it, vi } from "vitest";

import { createRouterRoutes, type RouterRouteDeps } from "../server/routes/router.js";
import {
  emitRouterToolCall,
  emitRouterUnlock,
  emitRouterSoftRefuse,
  emitRouterSessionStats,
} from "../server/router-sse.js";
import { eventBus } from "../server/event-bus.js";
import type { RouterConfig } from "../config/router-config-writer.js";
import type { RouterTelemetryRecord } from "../proxy/router-telemetry.js";
import type { SessionMetricsSummary } from "../proxy/router-session-metrics.js";

// ── Helpers ──────────────────────────────────────────────────────

function makeRecord(overrides: Partial<RouterTelemetryRecord> = {}): RouterTelemetryRecord {
  return {
    v: 1,
    ts: new Date().toISOString(),
    sessionId: "test-session",
    toolName: "search_code",
    originalToolName: "search_code",
    server: "unerr",
    outcome: "executed",
    wasMasked: false,
    tokensIn: 25,
    tokensSaved: 10,
    latencyMs: { total: 2.5 },
    ...overrides,
  };
}

function makeSummary(overrides: Partial<SessionMetricsSummary> = {}): SessionMetricsSummary {
  return {
    sessionId: "test-session",
    totalCalls: 10,
    totalTokensSaved: 100,
    totalTokensIn: 250,
    softRefuseCount: 2,
    unlockCount: 1,
    efficiency: 0.4,
    firstCallTs: "2026-05-17T12:00:00Z",
    lastCallTs: "2026-05-17T12:30:00Z",
    topTools: [{ name: "search_code", count: 5 }],
    outcomeBreakdown: {
      executed: 8,
      softRefused: 2,
      passthroughDegraded: 0,
      childError: 0,
    },
    avgLatencyMs: 3.2,
    ...overrides,
  };
}

const ENABLED_CONFIG: RouterConfig = {
  version: 1,
  enabled: true,
  enabledAt: "2026-05-17T14:00:00Z",
  proxiedServers: [
    { name: "github", alias: "gh", command: "github-mcp", sourceAgent: "cursor" },
  ],
  rewrittenConfigs: [],
};

function makeDeps(overrides: Partial<RouterRouteDeps> = {}): RouterRouteDeps {
  return {
    getRouterConfig: () => ENABLED_CONFIG,
    getSessionSummary: () => ({
      sessionId: "live",
      totalCalls: 42,
      totalTokensSaved: 500,
      totalTokensIn: 1200,
      softRefuseCount: 3,
      unlockCount: 2,
      efficiency: 0.42,
    }),
    readAllRecords: async () => [],
    aggregateRecords: () => [],
    groupRecords: () => new Map(),
    aggregateSingle: () => null,
    ...overrides,
  };
}

async function fetch(app: ReturnType<typeof createRouterRoutes>, path: string): Promise<Response> {
  return app.request(path);
}

// ── Status endpoint ─────────────────────────────────────────────

describe("GET /status", () => {
  it("returns enabled status with session summary and proxied servers", async () => {
    const app = createRouterRoutes(makeDeps());
    const res = await fetch(app, "/status");

    expect(res.status).toBe(200);
    const body = await res.json() as { data: Record<string, unknown> };

    expect(body.data.enabled).toBe(true);
    expect(body.data.phase).toBe(0);
    expect(body.data.proxiedServers).toHaveLength(1);

    const session = body.data.session as Record<string, unknown>;
    expect(session.totalCalls).toBe(42);
    expect(session.totalTokensSaved).toBe(500);
  });

  it("returns disabled status when no config", async () => {
    const app = createRouterRoutes(makeDeps({
      getRouterConfig: () => null,
    }));
    const res = await fetch(app, "/status");
    const body = await res.json() as { data: Record<string, unknown> };

    expect(body.data.enabled).toBe(false);
    expect(body.data.session).toBeNull();
    expect(body.data.proxiedServers).toHaveLength(0);
  });

  it("returns disabled status when config exists but enabled=false", async () => {
    const app = createRouterRoutes(makeDeps({
      getRouterConfig: () => ({ ...ENABLED_CONFIG, enabled: false }),
    }));
    const res = await fetch(app, "/status");
    const body = await res.json() as { data: Record<string, unknown> };

    expect(body.data.enabled).toBe(false);
  });

  it("includes _meta.latency_ms in response", async () => {
    const app = createRouterRoutes(makeDeps());
    const res = await fetch(app, "/status");
    const body = await res.json() as { _meta: { latency_ms: number } };

    expect(body._meta.latency_ms).toBeTypeOf("number");
    expect(body._meta.latency_ms).toBeGreaterThanOrEqual(0);
  });
});

// ── Sessions endpoint ───────────────────────────────────────────

describe("GET /sessions", () => {
  it("returns empty sessions when disabled", async () => {
    const app = createRouterRoutes(makeDeps({
      getRouterConfig: () => null,
    }));
    const res = await fetch(app, "/sessions");
    const body = await res.json() as { data: { sessions: unknown[] } };

    expect(body.data.sessions).toHaveLength(0);
  });

  it("returns aggregated session summaries", async () => {
    const summary = makeSummary();
    const app = createRouterRoutes(makeDeps({
      readAllRecords: async () => [makeRecord()],
      aggregateRecords: () => [summary],
    }));
    const res = await fetch(app, "/sessions");
    const body = await res.json() as { data: { sessions: SessionMetricsSummary[] } };

    expect(body.data.sessions).toHaveLength(1);
    expect(body.data.sessions[0]!.sessionId).toBe("test-session");
    expect(body.data.sessions[0]!.avgLatencyMs).toBe(3.2);
  });
});

// ── Session detail endpoint ─────────────────────────────────────

describe("GET /sessions/:id", () => {
  it("returns 404 when router disabled", async () => {
    const app = createRouterRoutes(makeDeps({
      getRouterConfig: () => null,
    }));
    const res = await fetch(app, "/sessions/abc");

    expect(res.status).toBe(404);
  });

  it("returns 404 when session not found", async () => {
    const app = createRouterRoutes(makeDeps({
      readAllRecords: async () => [],
      groupRecords: () => new Map(),
    }));
    const res = await fetch(app, "/sessions/nonexistent");

    expect(res.status).toBe(404);
  });

  it("returns session detail with records", async () => {
    const records = [makeRecord(), makeRecord({ toolName: "file_read" })];
    const grouped = new Map([["test-session", records]]);
    const summary = makeSummary();

    const app = createRouterRoutes(makeDeps({
      readAllRecords: async () => records,
      groupRecords: () => grouped,
      aggregateSingle: () => summary,
    }));
    const res = await fetch(app, "/sessions/test-session");
    const body = await res.json() as { data: SessionMetricsSummary & { records: unknown[] } };

    expect(res.status).toBe(200);
    expect(body.data.sessionId).toBe("test-session");
    expect(body.data.records).toHaveLength(2);
  });
});

// ── Recent endpoint ─────────────────────────────────────────────

describe("GET /recent", () => {
  it("returns empty when disabled", async () => {
    const app = createRouterRoutes(makeDeps({
      getRouterConfig: () => null,
    }));
    const res = await fetch(app, "/recent");
    const body = await res.json() as { data: { records: unknown[] } };

    expect(body.data.records).toHaveLength(0);
  });

  it("returns last N records", async () => {
    const records = Array.from({ length: 30 }, (_, i) =>
      makeRecord({ toolName: `tool_${i}` }),
    );
    const app = createRouterRoutes(makeDeps({
      readAllRecords: async () => records,
    }));
    const res = await fetch(app, "/recent?limit=10");
    const body = await res.json() as { data: { records: RouterTelemetryRecord[] } };

    expect(body.data.records).toHaveLength(10);
    expect(body.data.records[0]!.toolName).toBe("tool_20");
  });

  it("caps limit at 100", async () => {
    const records = Array.from({ length: 150 }, (_, i) =>
      makeRecord({ toolName: `tool_${i}` }),
    );
    const app = createRouterRoutes(makeDeps({
      readAllRecords: async () => records,
    }));
    const res = await fetch(app, "/recent?limit=200");
    const body = await res.json() as { data: { records: RouterTelemetryRecord[] } };

    expect(body.data.records).toHaveLength(100);
  });
});

// ── SSE emitters ────────────────────────────────────────────────

describe("router SSE emitters", () => {
  it("emitRouterToolCall delivers event to eventBus", () => {
    const listener = vi.fn();
    const unsub = eventBus.subscribe(listener);

    emitRouterToolCall({
      toolName: "search_code",
      outcome: "executed",
      tokensIn: 25,
      tokensSaved: 10,
      latencyMs: 2.5,
    });

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener.mock.calls[0]![0]!.type).toBe("router:tool_call");

    unsub();
  });

  it("emitRouterUnlock delivers unlock event", () => {
    const listener = vi.fn();
    const unsub = eventBus.subscribe(listener);

    emitRouterUnlock({ toolName: "get_imports", reason: "file_outline seen ≥5 imports" });

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener.mock.calls[0]![0]!.type).toBe("router:unlock");

    unsub();
  });

  it("emitRouterSoftRefuse delivers refuse event", () => {
    const listener = vi.fn();
    const unsub = eventBus.subscribe(listener);

    emitRouterSoftRefuse({ toolName: "get_critical_nodes", alternative: "get_references" });

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener.mock.calls[0]![0]!.type).toBe("router:soft_refuse");

    unsub();
  });

  it("emitRouterSessionStats delivers stats snapshot", () => {
    const listener = vi.fn();
    const unsub = eventBus.subscribe(listener);

    emitRouterSessionStats({
      totalCalls: 42,
      totalTokensSaved: 500,
      softRefuseCount: 3,
      unlockCount: 2,
      efficiency: 0.42,
    });

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener.mock.calls[0]![0]!.type).toBe("router:session_stats");

    unsub();
  });
});
