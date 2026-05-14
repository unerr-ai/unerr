import { mkdirSync, rmSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTokenFlowRoutes } from "../server/routes/token-flow.js";
import { appendSessionHistory } from "../tracking/session-history.js";
import { TokenFlowWriter, aggregateSession } from "../tracking/token-flow.js";

describe("token-flow-api", () => {
  let tmpDir: string;
  let unerrDir: string;
  let writer: TokenFlowWriter;
  let app: Hono;

  beforeEach(() => {
    tmpDir = join(
      os.tmpdir(),
      `unerr-tfa-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    );
    unerrDir = join(tmpDir, ".unerr");
    mkdirSync(unerrDir, { recursive: true });
    writer = new TokenFlowWriter(unerrDir, "api-test-session");

    const routes = createTokenFlowRoutes({
      unerrDir,
      getTokenFlowWriter: () => writer,
    });
    app = new Hono();
    app.route("/api/token-flow", routes);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // ── /api/token-flow/session ───────────────────────────────────────

  describe("GET /api/token-flow/session", () => {
    it("returns null data when no events recorded", async () => {
      const emptyWriter = new TokenFlowWriter(unerrDir, "empty-session");
      const routes = createTokenFlowRoutes({
        unerrDir,
        getTokenFlowWriter: () => emptyWriter,
      });
      const testApp = new Hono();
      testApp.route("/api/token-flow", routes);

      const res = await testApp.request("/api/token-flow/session");
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body.data.total_tokens_saved).toBe(0);
    });

    it("returns session summary with mechanism breakdown", async () => {
      writer.record({
        session_id: "api-test-session",
        turn: 1,
        mechanism: "graph_query",
        tool: "get_callers",
        tokens_without: 5000,
        tokens_with: 1800,
        tokens_saved: 3200,
      });
      writer.record({
        session_id: "api-test-session",
        turn: 2,
        mechanism: "shell_compression",
        tool: null,
        tokens_without: 2000,
        tokens_with: 800,
        tokens_saved: 1200,
      });

      const res = await app.request("/api/token-flow/session");
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body.data.total_tokens_saved).toBe(4400);
      expect(body.data.efficiency_pct).toBeGreaterThan(0);
      expect(body.data.by_mechanism.graph_query).toBeDefined();
      expect(body.data.by_mechanism.graph_query.tokens_saved).toBe(3200);
      expect(body.data.event_count).toBe(2);
      expect(body._meta.latency_ms).toBeDefined();
    });

    it("includes top_turns sorted by savings", async () => {
      writer.record({
        session_id: "api-test-session",
        turn: 1,
        mechanism: "graph_query",
        tool: "search_code",
        tokens_without: 1000,
        tokens_with: 800,
        tokens_saved: 200,
      });
      writer.record({
        session_id: "api-test-session",
        turn: 2,
        mechanism: "graph_query",
        tool: "get_callers",
        tokens_without: 5000,
        tokens_with: 1000,
        tokens_saved: 4000,
      });

      const res = await app.request("/api/token-flow/session");
      const body = await res.json();

      expect(body.data.top_turns[0].turn).toBe(2);
      expect(body.data.top_turns[0].tokens_saved).toBe(4000);
    });
  });

  // ── /api/token-flow/history ───────────────────────────────────────

  describe("GET /api/token-flow/history", () => {
    it("returns empty array when no history", async () => {
      const res = await app.request("/api/token-flow/history");
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body.data).toEqual([]);
    });

    it("returns sessions with tokenFlowSummary", async () => {
      appendSessionHistory(unerrDir, {
        sessionId: "hist-1",
        startedAt: "2026-01-01T00:00:00Z",
        endedAt: "2026-01-01T00:10:00Z",
        durationMs: 600_000,
        toolCalls: 10,
        tokensSaved: 5000,
        tokensProcessed: 15000,
        efficiency: 33,
        dollarsSaved: 0.15,
        modelId: "unknown",
        entityCount: 0,
        tokenFlowSummary: {
          by_mechanism: { graph_query: { tokens_saved: 4000, event_count: 5 } },
          top_mechanism: "graph_query",
          efficiency_pct: 33,
          total_tokens_saved: 5000,
          total_tokens_delivered: 10000,
        },
      });

      const res = await app.request("/api/token-flow/history");
      const body = await res.json();

      expect(body.data).toHaveLength(1);
      expect(body.data[0].token_flow.top_mechanism).toBe("graph_query");
      expect(body.data[0].tokens_saved).toBe(5000);
    });

    it("respects limit parameter", async () => {
      for (let i = 0; i < 5; i++) {
        appendSessionHistory(unerrDir, {
          sessionId: `hist-${i}`,
          startedAt: new Date(Date.now() - i * 60_000).toISOString(),
          endedAt: new Date().toISOString(),
          durationMs: 60_000,
          toolCalls: 5,
          tokensSaved: 1000,
          tokensProcessed: 3000,
          efficiency: 33,
          dollarsSaved: 0,
          modelId: "unknown",
          entityCount: 0,
          tokenFlowSummary: {
            by_mechanism: {
              graph_query: { tokens_saved: 1000, event_count: 3 },
            },
            top_mechanism: "graph_query",
            efficiency_pct: 33,
            total_tokens_saved: 1000,
            total_tokens_delivered: 2000,
          },
        });
      }

      const res = await app.request("/api/token-flow/history?limit=3");
      const body = await res.json();

      expect(body.data).toHaveLength(3);
    });
  });

  // ── /api/token-flow/events ────────────────────────────────────────

  describe("GET /api/token-flow/events", () => {
    it("returns all session events", async () => {
      writer.record({
        session_id: "api-test-session",
        turn: 1,
        mechanism: "graph_query",
        tool: "t",
        tokens_without: 100,
        tokens_with: 50,
        tokens_saved: 50,
      });
      writer.record({
        session_id: "api-test-session",
        turn: 2,
        mechanism: "graph_query",
        tool: "t",
        tokens_without: 200,
        tokens_with: 100,
        tokens_saved: 100,
      });

      const res = await app.request("/api/token-flow/events");
      const body = await res.json();

      expect(body.data).toHaveLength(2);
      expect(body.total).toBe(2);
    });

    it("filters by turn number", async () => {
      writer.record({
        session_id: "api-test-session",
        turn: 1,
        mechanism: "graph_query",
        tool: "a",
        tokens_without: 100,
        tokens_with: 50,
        tokens_saved: 50,
      });
      writer.record({
        session_id: "api-test-session",
        turn: 2,
        mechanism: "graph_query",
        tool: "b",
        tokens_without: 200,
        tokens_with: 100,
        tokens_saved: 100,
      });
      writer.record({
        session_id: "api-test-session",
        turn: 2,
        mechanism: "format_encoding",
        tool: "b",
        tokens_without: 100,
        tokens_with: 80,
        tokens_saved: 20,
      });

      const res = await app.request("/api/token-flow/events?turn=2");
      const body = await res.json();

      expect(body.data).toHaveLength(2);
      expect(body.data.every((e: { turn: number }) => e.turn === 2)).toBe(true);
    });
  });

  // ── Response structure validation ─────────────────────────────────

  describe("response structure", () => {
    it("all endpoints include _meta.latency_ms", async () => {
      const endpoints = [
        "/api/token-flow/session",
        "/api/token-flow/history",
        "/api/token-flow/events",
      ];

      for (const ep of endpoints) {
        const res = await app.request(ep);
        const body = await res.json();
        expect(body._meta?.latency_ms).toBeDefined();
        expect(typeof body._meta.latency_ms).toBe("number");
      }
    });
  });
});
