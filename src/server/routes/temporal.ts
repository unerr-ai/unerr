/**
 * Layer 9: Temporal Intelligence API — facts, sessions, decay projections.
 *
 * Endpoints:
 *   GET  /api/facts              — list active facts (filterable by scope, type, confidence)
 *   GET  /api/facts/:id/history  — evidence chain for a specific fact
 *   GET  /api/facts/health       — fact store health summary
 *   GET  /api/sessions           — recent session summaries
 *   POST /api/facts/:id/reinforce — manual reinforcement ("still true")
 *   DELETE /api/facts/:id         — manual dismissal (prune)
 *
 * All handlers operate against the TemporalFactStore (facts.db).
 * The event bus receives fact lifecycle events for SSE broadcast.
 */

import { Hono } from "hono";
import type { TemporalFactStore } from "../../intelligence/temporal-facts.js";
import type { SessionSummaryRecord } from "../../tracking/session-summary-writer.js";

export interface TemporalRouteDeps {
  factStore: TemporalFactStore | null;
  loadRecentSessions: (limit: number) => SessionSummaryRecord[];
  emitEvent: (type: string, data: unknown) => void;
}

export function createTemporalRoutes(deps: TemporalRouteDeps): Hono {
  const app = new Hono();

  // ── GET /api/facts ─────────────────────────────────────────────────
  app.get("/api/facts", async (c) => {
    if (!deps.factStore) {
      return c.json({ facts: [], message: "Fact store not available" });
    }

    const scope = c.req.query("scope") ?? "project";
    const factType = c.req.query("type");
    const minConfidence = Number.parseFloat(
      c.req.query("min_confidence") ?? "0.2",
    );
    const limit = Number.parseInt(c.req.query("limit") ?? "50", 10);

    try {
      let facts =
        scope === "*"
          ? await deps.factStore.recallAll(minConfidence)
          : await deps.factStore.recallByScope(scope, minConfidence);

      if (factType && factType !== "all") {
        facts = facts.filter((f) => f.fact_type === factType);
      }

      return c.json({
        facts: facts.slice(0, limit).map((f) => ({
          fact_id: f.fact_id,
          fact_type: f.fact_type,
          scope: f.scope,
          subject: f.subject,
          content: f.content,
          base_confidence: f.base_confidence,
          effective_confidence:
            Math.round(f.effective_confidence * 1000) / 1000,
          reinforcement_count: f.reinforcement_count,
          created_at: f.created_at,
          last_reinforced_at: f.last_reinforced_at,
          source: f.source,
        })),
        total: facts.length,
        filters: {
          scope,
          type: factType ?? "all",
          min_confidence: minConfidence,
        },
      });
    } catch (err) {
      return c.json(
        { error: err instanceof Error ? err.message : "Unknown error" },
        500,
      );
    }
  });

  // ── GET /api/facts/health ──────────────────────────────────────────
  app.get("/api/facts/health", async (c) => {
    if (!deps.factStore) {
      return c.json({ error: "Fact store not available" }, 503);
    }

    try {
      const health = await deps.factStore.getFactHealth();
      return c.json(health);
    } catch (err) {
      return c.json(
        { error: err instanceof Error ? err.message : "Unknown error" },
        500,
      );
    }
  });

  // ── GET /api/facts/:id/history ─────────────────────────────────────
  app.get("/api/facts/:id/history", async (c) => {
    if (!deps.factStore) {
      return c.json({ error: "Fact store not available" }, 503);
    }

    const factId = c.req.param("id");

    try {
      const facts = await deps.factStore.recallByScope("project", 0);
      const fact = facts.find((f) => f.fact_id === factId);

      if (!fact) {
        return c.json({ error: "Fact not found" }, 404);
      }

      return c.json({
        fact_id: fact.fact_id,
        fact_type: fact.fact_type,
        scope: fact.scope,
        subject: fact.subject,
        content: fact.content,
        base_confidence: fact.base_confidence,
        effective_confidence: fact.effective_confidence,
        reinforcement_count: fact.reinforcement_count,
        created_at: fact.created_at,
        last_reinforced_at: fact.last_reinforced_at,
        last_contradicted_at: fact.last_contradicted_at,
        source: fact.source,
      });
    } catch (err) {
      return c.json(
        { error: err instanceof Error ? err.message : "Unknown error" },
        500,
      );
    }
  });

  // ── GET /api/sessions ──────────────────────────────────────────────
  app.get("/api/sessions", (c) => {
    const limit = Number.parseInt(c.req.query("limit") ?? "10", 10);

    try {
      const sessions = deps.loadRecentSessions(limit);
      return c.json({
        sessions: sessions.map((s) => ({
          session_id: s.session_id,
          started_at: s.started_at,
          ended_at: s.ended_at,
          duration_ms: s.duration_ms,
          tool_calls: s.tool_calls,
          chains: s.chains,
          files_modified: s.files_modified.length,
          facts_recorded: s.facts_recorded,
          revert_count: s.revert_count,
          branch: s.branch,
        })),
        total: sessions.length,
      });
    } catch (err) {
      return c.json(
        { error: err instanceof Error ? err.message : "Unknown error" },
        500,
      );
    }
  });

  // ── POST /api/facts/:id/reinforce ──────────────────────────────────
  app.post("/api/facts/:id/reinforce", async (c) => {
    if (!deps.factStore) {
      return c.json({ error: "Fact store not available" }, 503);
    }

    const factId = c.req.param("id");

    try {
      await deps.factStore.reinforceFact(factId, {
        session_id: "dashboard-manual",
        action: "reinforced",
        timestamp: Date.now(),
      });

      deps.emitEvent("fact:reinforced", {
        fact_id: factId,
        source: "dashboard",
      });

      return c.json({ success: true, fact_id: factId, action: "reinforced" });
    } catch (err) {
      return c.json(
        { error: err instanceof Error ? err.message : "Unknown error" },
        500,
      );
    }
  });

  // ── DELETE /api/facts/:id ──────────────────────────────────────────
  app.delete("/api/facts/:id", async (c) => {
    if (!deps.factStore) {
      return c.json({ error: "Fact store not available" }, 503);
    }

    const factId = c.req.param("id");

    try {
      await deps.factStore.contradictFact(
        factId,
        "Manually dismissed from dashboard",
      );

      deps.emitEvent("fact:expired", {
        fact_id: factId,
        source: "dashboard_dismiss",
      });

      return c.json({ success: true, fact_id: factId, action: "dismissed" });
    } catch (err) {
      return c.json(
        { error: err instanceof Error ? err.message : "Unknown error" },
        500,
      );
    }
  });

  return app;
}
