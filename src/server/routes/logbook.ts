/**
 * Logbook API — Phase 3 Sprint 9 (Surface 1 dashboard).
 *
 * Reads the Sprint 1 `readNamedEvents` projection over the existing
 * `behavior_events` and `token_flow_events` tables and renders the
 * story-first archive: a generated paragraph, a featured "biggest moment"
 * replay, a reverse-chron event timeline, and right-rail counters.
 *
 * Additive only — this route does NOT modify any existing reader, does
 * NOT introduce a new table, and does NOT reroute any existing emitter.
 * The dashboard's existing landing, Token Trace, Reasoning Quality and
 * every other pane continue to read their endpoints unchanged.
 *
 *   GET /api/logbook/story          → generated paragraph + counts + featured
 *   GET /api/logbook/timeline       → reverse-chron paginated NamedEvents
 *   GET /api/logbook/event/:idx     → drill view (single event by timeline idx)
 *
 * Query params:
 *   period=today|week|all|since_install   (default today)
 *   agent=<agentName>                     (optional filter)
 *   session_id=<sid>                      (optional filter)
 *   event_type=<type>                     (timeline filter only)
 *
 * Honest-zero contract: when the projection is empty, the story falls
 * back to "<period>: unerr was quiet — no catches recorded." Counts in
 * the right rail are reported as their literal value (often 0), never
 * suppressed.
 */

import { Hono } from "hono";
import {
  type NamedEvent,
  type NamedEventFilter,
  countNamedEventsByType,
  readNamedEvents,
  totalNamedEvents,
} from "../../tracking/named-events.js";

export interface LogbookRouteDeps {
  unerrDir: string;
  /** Resolve the current agent name (used to personalize the story). */
  getAgentName?: () => string | null;
}

// ── Period helpers ────────────────────────────────────────────────────

type Period = "today" | "week" | "all" | "since_install";

function periodLabel(p: Period): string {
  switch (p) {
    case "today":
      return "Today";
    case "week":
      return "This week";
    case "since_install":
      return "Since install";
    default:
      return "All time";
  }
}

/** Resolve a window from either explicit ISO bounds OR the bucketed period.
 *  Explicit `from_ts`/`to_ts` (when either is non-empty) wins — letting the
 *  redesigned UI pick a single calendar day or a custom range without
 *  bouncing through the period enum. */
function periodFilter(
  p: Period,
  fromTs?: string | null,
  toTs?: string | null
): { from_ts?: string; to_ts?: string } {
  if ((fromTs && fromTs.length > 0) || (toTs && toTs.length > 0)) {
    return {
      from_ts: fromTs && fromTs.length > 0 ? fromTs : undefined,
      to_ts: toTs && toTs.length > 0 ? toTs : undefined,
    };
  }
  const now = new Date();
  if (p === "today") {
    const start = new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate(),
      0,
      0,
      0,
      0
    );
    return { from_ts: start.toISOString() };
  }
  if (p === "week") {
    const start = new Date(now);
    start.setDate(start.getDate() - 7);
    return { from_ts: start.toISOString() };
  }
  return {};
}

// ── Emotional weight + featured event selection ──────────────────────

/**
 * Emotional weight per event_type — heavier = more "interesting" to feature.
 * Tuned for the story-paragraph "riskiest moment" call-out: things the
 * user actively cares about (stale edits caught, loops broken, cascade
 * guards) rank above passive savings (cache hits, dedup).
 */
const EMOTIONAL_WEIGHT: Record<string, number> = {
  // Interventions land hardest — these are catches the agent would have
  // executed otherwise.
  stale_edit_prevented: 100,
  cascade_guard: 95,
  intervention_halted: 92,
  loop_broken: 90,
  cascade_warning_consumed: 78,
  intervention_warned: 75,

  // Steering — fact recall, conventions, drift consumption.
  fact_stored_user_fed: 70,
  fact_recalled: 60,
  convention_applied: 58,
  caller_check_enforced: 55,
  drift_consumed: 50,
  fact_stored_auto: 45,
  cross_session_resume: 42,
  confirmation_expired: 35,
  fact_capture_abandoned: 25,

  // Passive savings — present but quieter.
  full_read_avoided: 30,
  graph_query_served: 18,
  cache_hit: 14,
  defuddle_selector_skipped: 10,
};

const TOKEN_FLOW_WEIGHT: Record<string, number> = {
  shell_compression: 22,
  file_read: 20,
  fetch_url: 18,
  graph_query: 16,
  session_dedup: 14,
  format_encoding: 10,
  smart_truncation: 8,
  behavior_automation: 26,
  persistent_memory: 28,
};

function weightFor(eventType: string): number {
  if (eventType.startsWith("tokenflow.")) {
    return TOKEN_FLOW_WEIGHT[eventType.slice("tokenflow.".length)] ?? 5;
  }
  return EMOTIONAL_WEIGHT[eventType] ?? 5;
}

/** Sort events by emotional weight desc, ts desc as tie-breaker. */
export function sortByEmotionalWeight(events: NamedEvent[]): NamedEvent[] {
  return [...events].sort((a, b) => {
    const wa = weightFor(a.event_type);
    const wb = weightFor(b.event_type);
    if (wa !== wb) return wb - wa;
    return a.ts < b.ts ? 1 : -1;
  });
}

// ── Story paragraph template ─────────────────────────────────────────

interface StoryRow {
  /** Lower bound on the count to include this clause. */
  threshold: number;
  /** Renderer producing the clause from the count. */
  render: (count: number, scope: string) => string;
  /** Which scope-derivation strategy applies — `agent` substitutes the
   *  active agent name, `commonScope` lists the most-common file path. */
  scopeStrategy?: "agent" | "commonScope" | "none";
}

const STORY_TEMPLATES: Record<string, StoryRow> = {
  full_read_avoided: {
    threshold: 1,
    scopeStrategy: "agent",
    render: (n, agent) =>
      `kept ${agent} on rails through ${n} file ${n === 1 ? "read" : "reads"} it didn't need`,
  },
  stale_edit_prevented: {
    threshold: 1,
    scopeStrategy: "commonScope",
    render: (n, scope) =>
      scope
        ? `caught ${n} stale-edit ${n === 1 ? "attempt" : "attempts"} in ${scope}`
        : `caught ${n} stale-edit ${n === 1 ? "attempt" : "attempts"}`,
  },
  fact_recalled: {
    threshold: 1,
    render: (n) =>
      `remembered ${n} ${n === 1 ? "fact" : "facts"} so the agent didn't have to ask twice`,
  },
  fact_stored_user_fed: {
    threshold: 1,
    render: (n) =>
      `stored ${n} new user-asserted ${n === 1 ? "memory" : "memories"}`,
  },
  convention_applied: {
    threshold: 1,
    render: (n) =>
      `applied ${n} project ${n === 1 ? "convention" : "conventions"}`,
  },
  cascade_guard: {
    threshold: 1,
    render: (n) => `guarded ${n} cascading ${n === 1 ? "edit" : "edits"}`,
  },
  cascade_warning_consumed: {
    threshold: 1,
    render: (n) =>
      `surfaced ${n} cascade ${n === 1 ? "warning" : "warnings"} the agent acted on`,
  },
  loop_broken: {
    threshold: 1,
    render: (n) =>
      `broke ${n} retry ${n === 1 ? "loop" : "loops"} before it spiraled`,
  },
  drift_consumed: {
    threshold: 1,
    render: (n) =>
      `surfaced ${n} drift ${n === 1 ? "signal" : "signals"} the agent applied`,
  },
  caller_check_enforced: {
    threshold: 1,
    render: (n) =>
      `enforced ${n} caller ${n === 1 ? "check" : "checks"} before edit`,
  },
  intervention_halted: {
    threshold: 1,
    render: (n) =>
      `halted ${n} tool ${n === 1 ? "call" : "calls"} that were heading off course`,
  },
  intervention_warned: {
    threshold: 1,
    render: (n) => `warned about ${n} risky ${n === 1 ? "call" : "calls"}`,
  },
  cross_session_resume: {
    threshold: 1,
    render: (n) =>
      `resumed ${n} ${n === 1 ? "thread" : "threads"} of prior work without re-discovery`,
  },
};

function pickCommonScope(events: NamedEvent[]): string {
  const counts = new Map<string, number>();
  for (const e of events) {
    const k = e.file_path ?? e.entity_key;
    if (!k) continue;
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  let best: string | null = null;
  let bestCount = 0;
  for (const [k, c] of counts) {
    if (c > bestCount) {
      best = k;
      bestCount = c;
    }
  }
  return best ?? "";
}

function joinWithCommas(parts: string[]): string {
  if (parts.length === 0) return "";
  if (parts.length === 1) return parts[0]!;
  if (parts.length === 2) return `${parts[0]} and ${parts[1]}`;
  return `${parts.slice(0, -1).join(", ")}, and ${parts[parts.length - 1]}`;
}

function shortTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${hh}:${mm}`;
}

export interface StoryParagraph {
  paragraph: string;
  featured: NamedEvent | null;
  honest_zero: boolean;
}

/**
 * Render the story paragraph for a period. Pure — no IO.
 *
 * Honest-zero: when no clauses fire, returns the "unerr was quiet" line
 * with `honest_zero: true` so the renderer can apply distinct styling.
 */
export function renderStoryParagraph(
  events: NamedEvent[],
  label: string,
  agentName: string
): StoryParagraph {
  if (events.length === 0) {
    return {
      paragraph: `${label}: unerr was quiet — no catches recorded.`,
      featured: null,
      honest_zero: true,
    };
  }

  const counts = countNamedEventsByType(events);
  const eventsByType = new Map<string, NamedEvent[]>();
  for (const e of events) {
    if (!eventsByType.has(e.event_type)) eventsByType.set(e.event_type, []);
    eventsByType.get(e.event_type)!.push(e);
  }

  const parts: string[] = [];
  for (const [eventType, row] of Object.entries(STORY_TEMPLATES)) {
    const c = counts[eventType] ?? 0;
    if (c < row.threshold) continue;
    let scope = "";
    if (row.scopeStrategy === "agent") {
      scope = agentName || "the agent";
    } else if (row.scopeStrategy === "commonScope") {
      scope = pickCommonScope(eventsByType.get(eventType) ?? []);
    }
    parts.push(row.render(c, scope));
  }

  if (parts.length === 0) {
    return {
      paragraph: `${label}: unerr was quiet — no catches recorded.`,
      featured: null,
      honest_zero: true,
    };
  }

  const featured = sortByEmotionalWeight(events)[0] ?? null;
  let paragraph = `${label} unerr ${joinWithCommas(parts)}.`;
  if (featured) {
    const where = featured.file_path ?? featured.object;
    paragraph += ` The riskiest moment was ${shortTime(featured.ts)} on ${where} — replayed below.`;
  }
  return { paragraph, featured, honest_zero: false };
}

// ── Right-rail counters ──────────────────────────────────────────────

export interface RightRail {
  total_events: number;
  by_type: Record<string, number>;
  total_tokens_saved: number;
}

function buildRightRail(events: NamedEvent[]): RightRail {
  const byType = countNamedEventsByType(events);
  let saved = 0;
  for (const e of events) {
    if (e.event_type.startsWith("tokenflow.")) {
      const v = (e.metadata as { tokens_saved?: number }).tokens_saved;
      if (typeof v === "number") saved += v;
    }
  }
  return {
    total_events: totalNamedEvents(events),
    by_type: byType,
    total_tokens_saved: saved,
  };
}

// ── Route factory ────────────────────────────────────────────────────

export function createLogbookRoutes(deps: LogbookRouteDeps): Hono {
  const app = new Hono();

  // ── /story — generated paragraph + counts + featured ──────────────
  app.get("/story", (c) => {
    const start = performance.now();
    const period = (c.req.query("period") ?? "today") as Period;
    const agent = c.req.query("agent");
    const sessionId = c.req.query("session_id");
    const fromTs = c.req.query("from_ts");
    const toTs = c.req.query("to_ts");

    const filter: NamedEventFilter = {
      ...periodFilter(period, fromTs, toTs),
      agent: agent ?? undefined,
      session_id: sessionId ?? undefined,
    };
    const events = readNamedEvents(deps.unerrDir, filter);
    const agentName = agent ?? deps.getAgentName?.() ?? "";
    const story = renderStoryParagraph(events, periodLabel(period), agentName);
    const rail = buildRightRail(events);

    return c.json({
      data: {
        period,
        period_label: periodLabel(period),
        story: story.paragraph,
        honest_zero: story.honest_zero,
        featured: story.featured,
        right_rail: rail,
      },
      _meta: {
        latency_ms: Math.round((performance.now() - start) * 100) / 100,
      },
    });
  });

  // ── /timeline — reverse-chron filterable timeline ─────────────────
  app.get("/timeline", (c) => {
    const start = performance.now();
    const period = (c.req.query("period") ?? "today") as Period;
    const agent = c.req.query("agent");
    const sessionId = c.req.query("session_id");
    const eventType = c.req.query("event_type");
    const fromTs = c.req.query("from_ts");
    const toTs = c.req.query("to_ts");
    const limit = Math.min(Number(c.req.query("limit") ?? 100), 500);
    const offset = Math.max(Number(c.req.query("offset") ?? 0), 0);

    const filter: NamedEventFilter = {
      ...periodFilter(period, fromTs, toTs),
      agent: agent ?? undefined,
      session_id: sessionId ?? undefined,
      event_type: eventType ?? undefined,
    };
    const eventsAsc = readNamedEvents(deps.unerrDir, filter);
    const events = [...eventsAsc].reverse();
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

  // ── /facets — distinct agents / sessions / event types for filters ─
  //
  // Populates the UI filter dropdowns. Counts are scoped to the same
  // window the user is currently viewing so the dropdown options reflect
  // what's actually selectable — selecting an agent that only appears in
  // older data should not silently empty the list.
  app.get("/facets", (c) => {
    const start = performance.now();
    const period = (c.req.query("period") ?? "today") as Period;
    const fromTs = c.req.query("from_ts");
    const toTs = c.req.query("to_ts");

    const filter: NamedEventFilter = periodFilter(period, fromTs, toTs);
    const events = readNamedEvents(deps.unerrDir, filter);

    const agents = new Map<string, number>();
    const sessions = new Map<
      string,
      { count: number; first_ts: string; last_ts: string; agent: string }
    >();
    const eventTypes = new Map<string, number>();

    for (const ev of events) {
      agents.set(ev.agent, (agents.get(ev.agent) ?? 0) + 1);
      eventTypes.set(ev.event_type, (eventTypes.get(ev.event_type) ?? 0) + 1);
      const existing = sessions.get(ev.session_id);
      if (existing) {
        existing.count++;
        if (ev.ts < existing.first_ts) existing.first_ts = ev.ts;
        if (ev.ts > existing.last_ts) existing.last_ts = ev.ts;
      } else {
        sessions.set(ev.session_id, {
          count: 1,
          first_ts: ev.ts,
          last_ts: ev.ts,
          agent: ev.agent,
        });
      }
    }

    return c.json({
      data: {
        agents: [...agents.entries()]
          .map(([name, count]) => ({ name, count }))
          .sort((a, b) => b.count - a.count),
        sessions: [...sessions.entries()]
          .map(([id, s]) => ({
            id,
            count: s.count,
            started_ts: s.first_ts,
            last_ts: s.last_ts,
            agent: s.agent,
          }))
          .sort((a, b) => (a.last_ts < b.last_ts ? 1 : -1)),
        event_types: [...eventTypes.entries()]
          .map(([type, count]) => ({ type, count }))
          .sort((a, b) => b.count - a.count),
        total: events.length,
      },
      _meta: {
        latency_ms: Math.round((performance.now() - start) * 100) / 100,
      },
    });
  });

  // ── /event/:idx — drill view for a single event ───────────────────
  app.get("/event/:idx", (c) => {
    const start = performance.now();
    const period = (c.req.query("period") ?? "today") as Period;
    const idx = Number(c.req.param("idx"));
    if (!Number.isFinite(idx) || idx < 0) {
      return c.json({ error: "invalid_index" }, 400);
    }

    const filter: NamedEventFilter = {
      ...periodFilter(period, c.req.query("from_ts"), c.req.query("to_ts")),
      agent: c.req.query("agent") ?? undefined,
      session_id: c.req.query("session_id") ?? undefined,
    };
    const eventsAsc = readNamedEvents(deps.unerrDir, filter);
    const events = [...eventsAsc].reverse();
    const ev = events[idx];
    if (!ev) return c.json({ error: "not_found" }, 404);

    return c.json({
      data: ev,
      _meta: {
        latency_ms: Math.round((performance.now() - start) * 100) / 100,
      },
    });
  });

  return app;
}
