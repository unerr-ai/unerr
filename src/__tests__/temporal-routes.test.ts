import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import type { TemporalFact } from "../intelligence/temporal-facts.js";
import {
  type TemporalRouteDeps,
  createTemporalRoutes,
} from "../server/routes/temporal.js";
import type { SessionSummaryRecord } from "../tracking/session-summary-writer.js";

function makeFact(overrides: Partial<TemporalFact> = {}): TemporalFact {
  return {
    fact_id: "fact-001",
    fact_type: "semantic",
    scope: "project",
    subject: "architecture",
    content: "We use microservices",
    base_confidence: 0.9,
    effective_confidence: 0.85,
    reinforcement_count: 3,
    created_at: Date.now() - 86400000,
    last_reinforced_at: Date.now() - 3600000,
    last_contradicted_at: 0,
    source: "agent_explicit",
    ...overrides,
  };
}

function makeSession(
  overrides: Partial<SessionSummaryRecord> = {},
): SessionSummaryRecord {
  return {
    session_id: "sess-test",
    written_at: new Date().toISOString(),
    started_at: new Date(Date.now() - 3600000).toISOString(),
    ended_at: new Date().toISOString(),
    duration_ms: 3600000,
    tool_calls: 15,
    chains: 4,
    files_modified: ["src/a.ts"],
    entities_touched: ["src/a.ts::fn"],
    tools_used: { get_function: 10 },
    feature_areas: ["src"],
    facts_recorded: 1,
    facts_surfaced: ["f1"],
    revert_count: 0,
    rot_score: 0.1,
    token_estimate: 8000,
    branch: "main",
    ...overrides,
  };
}

function createTestDeps(
  overrides: Partial<TemporalRouteDeps> = {},
): TemporalRouteDeps {
  return {
    factStore: {
      recallByScope: vi.fn().mockResolvedValue([makeFact()]),
      getFactHealth: vi.fn().mockResolvedValue({
        total: 5,
        active: 4,
        decayed: 1,
        by_type: { semantic: 2, procedural: 1, negative: 1, episodic: 1 },
        avg_confidence: 0.72,
      }),
      reinforceFact: vi.fn().mockResolvedValue(undefined),
      contradictFact: vi.fn().mockResolvedValue(undefined),
    } as any,
    loadRecentSessions: vi.fn().mockReturnValue([makeSession()]),
    emitEvent: vi.fn(),
    ...overrides,
  };
}

describe("temporal routes", () => {
  describe("GET /api/facts", () => {
    it("returns facts with default filters", async () => {
      const deps = createTestDeps();
      const app = new Hono();
      app.route("", createTemporalRoutes(deps));

      const res = await app.request("/api/facts");
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.facts.length).toBe(1);
      expect(body.facts[0].fact_id).toBe("fact-001");
      expect(body.total).toBe(1);
    });

    it("returns empty when factStore is null", async () => {
      const deps = createTestDeps({ factStore: null });
      const app = new Hono();
      app.route("", createTemporalRoutes(deps));

      const res = await app.request("/api/facts");
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.facts).toEqual([]);
    });
  });

  describe("GET /api/facts/health", () => {
    it("returns health summary", async () => {
      const deps = createTestDeps();
      const app = new Hono();
      app.route("", createTemporalRoutes(deps));

      const res = await app.request("/api/facts/health");
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.total).toBe(5);
      expect(body.active).toBe(4);
      expect(body.avg_confidence).toBe(0.72);
    });
  });

  describe("GET /api/sessions", () => {
    it("returns recent sessions", async () => {
      const deps = createTestDeps();
      const app = new Hono();
      app.route("", createTemporalRoutes(deps));

      const res = await app.request("/api/sessions");
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.sessions.length).toBe(1);
      expect(body.sessions[0].session_id).toBe("sess-test");
    });
  });

  describe("POST /api/facts/:id/reinforce", () => {
    it("reinforces a fact and emits event", async () => {
      const deps = createTestDeps();
      const app = new Hono();
      app.route("", createTemporalRoutes(deps));

      const res = await app.request("/api/facts/fact-001/reinforce", {
        method: "POST",
      });
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.success).toBe(true);
      expect(body.action).toBe("reinforced");

      expect(deps.factStore!.reinforceFact).toHaveBeenCalledWith(
        "fact-001",
        expect.objectContaining({ action: "reinforced" }),
      );
      expect(deps.emitEvent).toHaveBeenCalledWith(
        "fact:reinforced",
        expect.objectContaining({ fact_id: "fact-001" }),
      );
    });
  });

  describe("DELETE /api/facts/:id", () => {
    it("dismisses a fact and emits event", async () => {
      const deps = createTestDeps();
      const app = new Hono();
      app.route("", createTemporalRoutes(deps));

      const res = await app.request("/api/facts/fact-001", {
        method: "DELETE",
      });
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.success).toBe(true);
      expect(body.action).toBe("dismissed");

      expect(deps.factStore!.contradictFact).toHaveBeenCalledWith(
        "fact-001",
        "Manually dismissed from dashboard",
      );
      expect(deps.emitEvent).toHaveBeenCalledWith(
        "fact:expired",
        expect.objectContaining({ fact_id: "fact-001" }),
      );
    });
  });
});
