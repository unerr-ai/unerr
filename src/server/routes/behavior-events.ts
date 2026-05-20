/**
 * Behavior Events API — verb-noun counters for PREVENT-class mechanisms.
 *
 * GET /api/behavior-events/session   → Current session counts by type + tool
 * GET /api/behavior-events/global    → Cross-session aggregate counts
 * GET /api/behavior-events/events    → Raw events with filters
 *
 * Companion to /api/token-flow. Token flow records *byte savings* for
 * COMPRESS-class mechanisms (fetch_url, file_read, ...). Behavior events
 * record *discrete named counts* for PREVENT-class mechanisms (graph
 * queries served, file reads avoided, loops broken, ...) where the
 * counterfactual byte count cannot be honestly measured.
 */

import { Hono } from "hono";
import {
  type BehaviorEvent,
  type BehaviorEventType,
  type BehaviorEventWriter,
  aggregateBehaviorCounts,
  readBehaviorEvents,
} from "../../tracking/behavior-events.js";

export interface BehaviorEventRouteDeps {
  unerrDir: string;
  getBehaviorEventWriter: () => BehaviorEventWriter | null;
}

export function createBehaviorEventRoutes(
  deps: BehaviorEventRouteDeps
): Hono {
  const app = new Hono();

  // ── /session — Current-session counts ──────────────────────────────
  app.get("/session", (c) => {
    const start = performance.now();
    const writer = deps.getBehaviorEventWriter();
    const querySessionId = c.req.query("session_id");
    const sessionId = querySessionId ?? writer?.sessionId ?? null;

    const allEvents = readBehaviorEvents(deps.unerrDir);
    if (!sessionId || allEvents.length === 0) {
      return c.json({
        data: {
          session_id: sessionId,
          counts: aggregateBehaviorCounts([]),
        },
        _meta: {
          latency_ms: Math.round((performance.now() - start) * 100) / 100,
        },
      });
    }

    const sessionEvents = allEvents.filter((e) => e.session_id === sessionId);
    return c.json({
      data: {
        session_id: sessionId,
        counts: aggregateBehaviorCounts(sessionEvents),
      },
      _meta: {
        latency_ms: Math.round((performance.now() - start) * 100) / 100,
      },
    });
  });

  // ── /global — Aggregate across all sessions ─────────────────────────
  app.get("/global", (c) => {
    const start = performance.now();
    const fromTs = c.req.query("from_ts");
    const toTs = c.req.query("to_ts");

    const allEvents = readBehaviorEvents(deps.unerrDir, {
      from_ts: fromTs ?? undefined,
      to_ts: toTs ?? undefined,
    });

    const sessions = new Set<string>();
    for (const e of allEvents) sessions.add(e.session_id);

    return c.json({
      data: {
        total_sessions: sessions.size,
        counts: aggregateBehaviorCounts(allEvents),
      },
      _meta: {
        latency_ms: Math.round((performance.now() - start) * 100) / 100,
      },
    });
  });

  // ── /events — Raw events with filters ───────────────────────────────
  // Supports: ?session_id=X&type=Y&tool=Z&from_ts=ISO&to_ts=ISO&limit=N&offset=N
  app.get("/events", (c) => {
    const start = performance.now();
    const sessionFilter = c.req.query("session_id");
    const typeFilter = c.req.query("type") as BehaviorEventType | undefined;
    const toolFilter = c.req.query("tool");
    const turnFilter = c.req.query("turn");
    const fromTs = c.req.query("from_ts");
    const toTs = c.req.query("to_ts");
    const limit = Math.min(Number(c.req.query("limit") ?? 200), 500);
    const offset = Math.max(Number(c.req.query("offset") ?? 0), 0);

    let events: BehaviorEvent[] = readBehaviorEvents(deps.unerrDir, {
      session_id: sessionFilter ?? undefined,
      type: typeFilter,
      tool: toolFilter ?? undefined,
      from_ts: fromTs ?? undefined,
      to_ts: toTs ?? undefined,
    });

    if (turnFilter) {
      const turnNum = Number(turnFilter);
      if (!Number.isNaN(turnNum)) {
        events = events.filter((e) => e.turn === turnNum);
      }
    }

    // Default: current session only when no session_id given
    if (!sessionFilter) {
      const writer = deps.getBehaviorEventWriter();
      if (writer) {
        events = events.filter((e) => e.session_id === writer.sessionId);
      }
    }

    const paginated = events.slice(offset, offset + limit);
    return c.json({
      data: paginated,
      total: events.length,
      limit,
      offset,
      _meta: {
        latency_ms: Math.round((performance.now() - start) * 100) / 100,
      },
    });
  });

  return app;
}
