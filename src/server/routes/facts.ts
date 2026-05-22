/**
 * Sidekick Memory facts API — Phase 3 Sprint 11.
 *
 * Read + mutate routes for the Sidekick Memory dashboard page. Mounted
 * at `/api/facts-v2` so it sits alongside the existing `/api/facts`
 * routes (temporal.ts) without disturbing them — the existing Project
 * Memory page keeps reading from `/api/facts` unchanged.
 *
 *   GET    /api/facts-v2/list?source=user_fed|auto|all
 *   GET    /api/facts-v2/:id/provenance
 *   PATCH  /api/facts-v2/:id              { content: string }
 *   POST   /api/facts-v2/:id/disable
 *   POST   /api/facts-v2/:id/reinforce    (alias for re-enable / restore)
 *
 * Drift badge: caller-supplied via `dirtyFiles` — when a fact's `scope`
 * or any `applies_to` path matches a dirty file, the response carries
 * `drift: true`. Sprint 8's drift detector remains the source of truth;
 * this route does NOT compute drift itself.
 */

import { Hono } from "hono";
import type { TemporalFactStore } from "../../intelligence/temporal-facts.js";

export interface FactsRouteDeps {
  factStore: TemporalFactStore | null;
  /** Caller-provided set of files known to be dirty/modified-since-last-seen.
   *  Used to flag facts whose scope or applies_to references one of them. */
  getDirtyFiles?: () => Set<string>;
  emitEvent?: (type: string, data: unknown) => void;
}

const AUTO_SOURCES = [
  "convention_detector",
  "negative_knowledge",
  "causal_bridge",
  "session_analysis",
  "agent_explicit",
] as const;

function appliesToFromProvenance(
  scope: string,
  applies_to: string[]
): string[] {
  const targets = new Set<string>([scope, ...applies_to]);
  targets.delete("project");
  return [...targets].filter(Boolean);
}

function hasDrift(targets: string[], dirty: Set<string>): boolean {
  if (dirty.size === 0) return false;
  for (const t of targets) {
    if (dirty.has(t)) return true;
    // dir-prefix match: "src/proxy/" matches any dirty file under it
    if (t.endsWith("/")) {
      for (const f of dirty) if (f.startsWith(t)) return true;
    }
  }
  return false;
}

export function createFactsRoutes(deps: FactsRouteDeps): Hono {
  const app = new Hono();

  // ── GET /list — list facts by source ─────────────────────────────
  app.get("/list", async (c) => {
    const start = performance.now();
    if (!deps.factStore) {
      return c.json({ data: [], total: 0, message: "fact_store_unavailable" });
    }
    const sourceQ = c.req.query("source") ?? "all";
    const minConf = Number.parseFloat(c.req.query("min_confidence") ?? "0");
    const dirty = deps.getDirtyFiles?.() ?? new Set<string>();

    let facts: Awaited<ReturnType<TemporalFactStore["listFactsBySource"]>> = [];
    try {
      if (sourceQ === "user_fed") {
        facts = await deps.factStore.listFactsBySource("user_fed", minConf);
      } else if (sourceQ === "auto" || sourceQ === "all") {
        const buckets = await Promise.all(
          AUTO_SOURCES.map((s) => deps.factStore!.listFactsBySource(s, minConf))
        );
        facts = buckets.flat();
        if (sourceQ === "all") {
          const user = await deps.factStore.listFactsBySource(
            "user_fed",
            minConf
          );
          facts = [...user, ...facts];
        }
      } else {
        facts = await deps.factStore.listFactsBySource(
          sourceQ as Parameters<TemporalFactStore["listFactsBySource"]>[0],
          minConf
        );
      }
    } catch (err) {
      return c.json(
        { error: err instanceof Error ? err.message : "unknown" },
        500
      );
    }

    const rows = facts.map((f) => {
      const targets = appliesToFromProvenance(f.scope, f.applies_to);
      return {
        fact_id: f.fact_id,
        fact_type: f.fact_type,
        scope: f.scope,
        subject: f.subject,
        content: f.content,
        source: f.source,
        source_quote: f.source_quote,
        applies_to: f.applies_to,
        base_confidence: f.base_confidence,
        effective_confidence: Math.round(f.effective_confidence * 1000) / 1000,
        reinforcement_count: f.reinforcement_count,
        created_at: f.created_at,
        last_reinforced_at: f.last_reinforced_at,
        last_contradicted_at: f.last_contradicted_at,
        disabled: f.base_confidence < 0.05,
        drift: hasDrift(targets, dirty),
      };
    });

    return c.json({
      data: rows,
      total: rows.length,
      _meta: {
        latency_ms: Math.round((performance.now() - start) * 100) / 100,
      },
    });
  });

  // ── GET /:id/provenance ──────────────────────────────────────────
  app.get("/:id/provenance", async (c) => {
    if (!deps.factStore)
      return c.json({ error: "fact_store_unavailable" }, 503);
    const id = c.req.param("id");
    try {
      const prov = await deps.factStore.readProvenance(id);
      return c.json({ data: { fact_id: id, ...prov } });
    } catch (err) {
      return c.json(
        { error: err instanceof Error ? err.message : "unknown" },
        500
      );
    }
  });

  // ── PATCH /:id — edit content ────────────────────────────────────
  app.patch("/:id", async (c) => {
    if (!deps.factStore)
      return c.json({ error: "fact_store_unavailable" }, 503);
    const id = c.req.param("id");
    let body: { content?: string; quote?: string } = {};
    try {
      body = (await c.req.json()) as typeof body;
    } catch {
      return c.json({ error: "invalid_body" }, 400);
    }
    if (typeof body.content !== "string" || body.content.trim().length === 0) {
      return c.json({ error: "content_required" }, 400);
    }
    try {
      const ok = await deps.factStore.editFactContent(id, body.content, {
        session_id: "dashboard-edit",
        quote: body.quote,
      });
      if (!ok) return c.json({ error: "not_found" }, 404);
      deps.emitEvent?.("fact:edited", { fact_id: id });
      return c.json({ success: true, fact_id: id, action: "edited" });
    } catch (err) {
      return c.json(
        { error: err instanceof Error ? err.message : "unknown" },
        500
      );
    }
  });

  // ── POST /:id/disable ────────────────────────────────────────────
  app.post("/:id/disable", async (c) => {
    if (!deps.factStore)
      return c.json({ error: "fact_store_unavailable" }, 503);
    const id = c.req.param("id");
    try {
      const ok = await deps.factStore.disableFact(id);
      if (!ok) return c.json({ error: "not_found" }, 404);
      deps.emitEvent?.("fact:disabled", { fact_id: id });
      return c.json({ success: true, fact_id: id, action: "disabled" });
    } catch (err) {
      return c.json(
        { error: err instanceof Error ? err.message : "unknown" },
        500
      );
    }
  });

  // ── POST /:id/reinforce — re-enable / strengthen ─────────────────
  app.post("/:id/reinforce", async (c) => {
    if (!deps.factStore)
      return c.json({ error: "fact_store_unavailable" }, 503);
    const id = c.req.param("id");
    try {
      await deps.factStore.reinforceFact(id, {
        session_id: "dashboard-reinforce",
        action: "reinforced",
        timestamp: Date.now(),
      });
      deps.emitEvent?.("fact:reinforced", { fact_id: id });
      return c.json({ success: true, fact_id: id, action: "reinforced" });
    } catch (err) {
      return c.json(
        { error: err instanceof Error ? err.message : "unknown" },
        500
      );
    }
  });

  // ── DELETE /:id — hard contradict (same as /api/facts DELETE) ────
  app.delete("/:id", async (c) => {
    if (!deps.factStore)
      return c.json({ error: "fact_store_unavailable" }, 503);
    const id = c.req.param("id");
    try {
      await deps.factStore.contradictFact(id, "Dismissed via Sidekick Memory");
      deps.emitEvent?.("fact:expired", { fact_id: id });
      return c.json({ success: true, fact_id: id, action: "dismissed" });
    } catch (err) {
      return c.json(
        { error: err instanceof Error ? err.message : "unknown" },
        500
      );
    }
  });

  return app;
}
