/**
 * Timeline API — routes for the new Session Timeline experience (ST-1 → ST-5).
 *
 * All routes are conditional on the timeline subsystem being active. When the
 * subsystem is off (UNERR_TIMELINE_V2=0) the dashboard never mounts these
 * routes, so the existing /api/session and /api/intelligence surfaces stay
 * completely untouched.
 *
 * Read-only against shadow ledger and timeline.db. No writes back to facts.db
 * or graph.db.
 */

import { Hono } from "hono";
import { runIntentStitch } from "../../timeline/intent-detector.js";
import { detectLoops } from "../../timeline/loop-miner.js";
import { computeOpenThreads } from "../../timeline/open-threads.js";
import type { CozoTimelineStore } from "../../timeline/timeline-store.js";
import type { LedgerEntry } from "../../tracking/shadow-ledger.js";

export interface TimelineRouteDeps {
  store: CozoTimelineStore;
  /** Recent ledger entries — feeds LoopMiner. */
  getRecentLedgerEntries?: (limit: number) => LedgerEntry[];
}

function parseLimit(
  raw: string | undefined,
  fallback: number,
  max: number
): number {
  const n = Number.parseInt(raw ?? "", 10);
  if (Number.isNaN(n) || n < 1) return fallback;
  return Math.min(n, max);
}

function parseInt0(raw: string | undefined, fallback: number, min = 0): number {
  const n = Number.parseInt(raw ?? "", 10);
  if (Number.isNaN(n) || n < min) return fallback;
  return n;
}

function parseTs(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const n = Number(raw);
  if (Number.isFinite(n) && n > 0) return n;
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function createTimelineRoutes(deps: TimelineRouteDeps): Hono {
  const app = new Hono();

  app.get("/health", (c) =>
    c.json({
      data: {
        ok: true,
        db_path: deps.store.dbPath,
        is_new: deps.store.isNew,
      },
    })
  );

  app.get("/turns", async (c) => {
    const sessionId = c.req.query("session_id");
    const fromTs = parseTs(c.req.query("from"));
    const toTs = parseTs(c.req.query("to"));
    const query = c.req.query("q");
    const limit = parseLimit(c.req.query("limit"), 50, 500);
    const offset = parseInt0(c.req.query("offset"), 0);

    const filter = {
      sessionId: sessionId || undefined,
      fromTs,
      toTs,
      query: query || undefined,
    };

    const [turns, total] = await Promise.all([
      deps.store.listTurns({ ...filter, limit, offset }),
      deps.store.countTurns(filter),
    ]);

    return c.json({
      data: turns,
      total,
      returned: turns.length,
      offset,
      limit,
    });
  });

  app.get("/sessions", async (c) => {
    const fromTs = parseTs(c.req.query("from"));
    const toTs = parseTs(c.req.query("to"));
    const limit = parseLimit(c.req.query("limit"), 200, 1000);
    const agentFilter = c.req.query("agent");
    let sessions = await deps.store.listSessions({ fromTs, toTs, limit });
    if (agentFilter && agentFilter.length > 0) {
      sessions = sessions.filter((s) => s.agent_name === agentFilter);
    }
    return c.json({
      data: sessions,
      total: sessions.length,
      returned: sessions.length,
    });
  });

  app.get("/agents", async (c) => {
    const agents = await deps.store.listAgents();
    return c.json({
      data: agents,
      total: agents.length,
      returned: agents.length,
    });
  });

  app.get("/heatmap", async (c) => {
    const days = Math.max(1, Math.min(parseInt0(c.req.query("days"), 30), 365));
    const bucketMs = 24 * 60 * 60_000;
    const toTs = Date.now();
    const fromTs = toTs - (days - 1) * bucketMs;
    const buckets = await deps.store.getActivityBuckets({
      fromTs,
      toTs,
      bucketMs,
    });
    return c.json({
      data: buckets,
      total: buckets.length,
      returned: buckets.length,
      from_ts: fromTs,
      to_ts: toTs,
    });
  });

  app.get("/markers", async (c) => {
    const sessionId = c.req.query("session_id");
    const type = c.req.query("type");
    const limit = parseLimit(c.req.query("limit"), 100, 500);
    const markers = await deps.store.listMarkers({
      sessionId: sessionId || undefined,
      type: type || undefined,
      limit,
    });
    return c.json({
      data: markers,
      total: markers.length,
      returned: markers.length,
    });
  });

  app.get("/loops", (c) => {
    if (!deps.getRecentLedgerEntries) {
      return c.json({ data: [], total: 0, returned: 0 });
    }
    const entries = deps.getRecentLedgerEntries(200);
    const loops = detectLoops(entries);
    return c.json({ data: loops, total: loops.length, returned: loops.length });
  });

  app.get("/open-threads", async (c) => {
    const sessionId = c.req.query("session_id");
    const markers = await deps.store.listMarkers({
      sessionId: sessionId || undefined,
      limit: 500,
    });
    const threads = computeOpenThreads(markers);
    return c.json({
      data: threads,
      total: threads.length,
      returned: threads.length,
    });
  });

  app.get("/signals", async (c) => {
    const type = c.req.query("type");
    const minConfidence = c.req.query("min_confidence");
    const limit = parseLimit(c.req.query("limit"), 50, 500);
    const signals = await deps.store.listSignals({
      type: type || undefined,
      minConfidence:
        minConfidence !== undefined ? Number(minConfidence) : undefined,
      limit,
    });
    return c.json({
      data: signals,
      total: signals.length,
      returned: signals.length,
    });
  });

  app.get("/signals/:id/history", async (c) => {
    const id = c.req.param("id");
    const limit = parseLimit(c.req.query("limit"), 10, 100);
    const history = await deps.store.getReinforcementHistory(id, limit);
    return c.json({
      data: history,
      total: history.length,
      returned: history.length,
    });
  });

  app.get("/intents", async (c) => {
    const status = c.req.query("status");
    const limit = parseLimit(c.req.query("limit"), 100, 500);
    const intents = await deps.store.listIntents({
      status: status || undefined,
      limit,
    });
    return c.json({
      data: intents,
      total: intents.length,
      returned: intents.length,
    });
  });

  app.get("/intents/:id", async (c) => {
    const intentId = c.req.param("id");
    const all = await deps.store.listIntents({ limit: 500 });
    const intent = all.find((i) => i.intent_id === intentId);
    if (!intent) return c.json({ error: "not_found" }, 404);
    const sessions = await deps.store.listIntentSessions(intentId);
    return c.json({ data: { intent, sessions } });
  });

  app.post("/intents/stitch", async (c) => {
    const summary = await runIntentStitch(deps.store);
    return c.json({ data: summary });
  });

  /**
   * Resume strip: dominant intent + open blockers + hot files from the most
   * recent turn(s), provided that turn closed within 7 days. Returns `null`
   * when nothing useful is available — the UI hides the strip.
   */
  app.get("/resume", async (c) => {
    const SEVEN_DAYS_MS = 7 * 24 * 60 * 60_000;
    const now = Date.now();

    const turns = await deps.store.listTurns({ limit: 10 });
    const latestActive = turns.find((t) => now - t.ended_at < SEVEN_DAYS_MS);
    if (!latestActive) {
      return c.json({ data: null });
    }

    const markers = await deps.store.listMarkers({
      sessionId: latestActive.session_id,
      limit: 500,
    });
    const openThreads = computeOpenThreads(markers);
    const intent =
      markers.find((m) => m.type === "mark_intent")?.text ??
      latestActive.title ??
      "";

    return c.json({
      data: {
        session_id: latestActive.session_id,
        last_turn_id: latestActive.turn_id,
        last_active_at: latestActive.ended_at,
        elapsed_ms: now - latestActive.ended_at,
        intent,
        open_threads: openThreads,
      },
    });
  });

  return app;
}
