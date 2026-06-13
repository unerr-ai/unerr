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

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Hono } from "hono";
import { readNudgeState } from "../../proxy/nudge-state.js";
import { extractReceiptAttribution } from "../../proxy/receipt-attribution.js";
import { openMetricsStore } from "../../tracking/metrics-store.js";
import {
  type NamedEvent,
  type NamedEventFilter,
  countNamedEventsByType,
  readNamedEvents,
  totalNamedEvents,
} from "../../tracking/named-events.js";
import {
  getPromptForTurn,
  getPromptsForSession,
} from "../../tracking/prompt-trace.js";
import { computeRuntimeJoins } from "../../tracking/runtime-joins.js";
import type { LedgerEntry } from "../../tracking/shadow-ledger.js";
import { materializeTranscripts } from "../../tracking/transcript-materializer.js";

// ── Shadow Ledger Reader ─────────────────────────────────────────────
// Reads shadow.jsonl directly (no CozoDB needed). Each line is one
// LedgerEntry — every MCP tool call and every session marker.

function readLedgerForSession(
  unerrDir: string,
  sessionId: string
): LedgerEntry[] {
  const ledgerPath = join(unerrDir, "ledger", "shadow.jsonl");
  if (!existsSync(ledgerPath)) return [];
  try {
    const raw = readFileSync(ledgerPath, "utf-8");
    const out: LedgerEntry[] = [];
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const entry = JSON.parse(trimmed) as LedgerEntry;
        if (entry.session_id === sessionId) out.push(entry);
      } catch {
        /* skip malformed */
      }
    }
    return out;
  } catch {
    return [];
  }
}

export interface LogbookRouteDeps {
  unerrDir: string;
  /** Repo working dir — needed for query-time transcript materialization. */
  repoCwd?: string;
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

// ── Compliance ribbon (Fix H) ────────────────────────────────────────

/** Four-counter directive-compliance ribbon. Surfaces how reliably the
 *  agent is honouring the per-turn unerr contracts:
 *    - Surface 2 (loaded-note line via `unerr_surface2_line`)
 *    - Surface 3 (close-out receipt via `unerr_turn_summary`)
 *    - mark_intent (first-tool-call commitment)
 *    - skill invocation (Path A dispatch acknowledged)
 *  Data: per-counter pairs read from `nudge-state.json` (required vs
 *  called) plus `behavior_events` for the skill-invoked side. No new
 *  schema, no new tables. */
export interface ComplianceCounter {
  required: number;
  called: number;
  ratio: number;
  ratio_label: string;
  consecutive_misses: number;
}

export interface ComplianceRibbon {
  surface2: ComplianceCounter;
  surface3: ComplianceCounter;
  mark_intent: ComplianceCounter;
  skill: ComplianceCounter;
  /** Fix L — cross-tier runtime joins aggregated across the window:
   *  memory↔graph, graph↔drift, three-way. Surfaced as a fourth row in
   *  the ribbon ("Runtime joins · memory→graph N · graph→drift M ·
   *  three-way K"). The user reads this as the positioning artefact —
   *  no point tool can produce it because the join requires per-repo
   *  runtime context. */
  runtime_joins: {
    memory_to_graph: number;
    graph_to_drift: number;
    three_way: number;
    total: number;
  };
}

function ratio(called: number, required: number): number {
  if (required <= 0) return 1;
  return Math.round((called / required) * 1000) / 1000;
}

export function formatComplianceRatio(ratio: number): string {
  return `${Math.round(ratio * 100)}%`;
}

export function buildComplianceRibbon(
  unerrDir: string,
  events: NamedEvent[]
): ComplianceRibbon {
  const cwd = dirname(unerrDir);
  const state = readNudgeState(cwd);

  // The skill-invoked side comes from behavior events (Path A nudges
  // emit a Skill() invocation which the runner records as a tool call).
  // We approximate skill calls as the count of `cascade_warning_consumed`
  // and `intervention_warned` rows that mention a Skill — proxy for "the
  // agent ran a Skill in response to a directive". Falls back to 0 cleanly
  // when telemetry is empty.
  let skillCalls = 0;
  for (const ev of events) {
    if (ev.event_type === "intervention_warned") {
      const tool = (ev.metadata as { tool?: unknown }).tool;
      if (typeof tool === "string" && tool === "Skill") {
        skillCalls += 1;
      }
    }
  }

  return {
    surface2: {
      required: state.surface2_required_count,
      called: state.surface2_called_count,
      ratio: ratio(state.surface2_called_count, state.surface2_required_count),
      ratio_label: formatComplianceRatio(
        ratio(state.surface2_called_count, state.surface2_required_count)
      ),
      consecutive_misses: state.consecutive_surface2_misses,
    },
    surface3: {
      required: state.turn_summary_required_count,
      called: state.turn_summary_emitted_count,
      ratio: ratio(
        state.turn_summary_emitted_count,
        state.turn_summary_required_count
      ),
      ratio_label: formatComplianceRatio(
        ratio(
          state.turn_summary_emitted_count,
          state.turn_summary_required_count
        )
      ),
      consecutive_misses: state.consecutive_receipt_misses,
    },
    mark_intent: {
      required: state.mark_intent_required_count,
      called: state.mark_intent_compliant_count,
      ratio: ratio(
        state.mark_intent_compliant_count,
        state.mark_intent_required_count
      ),
      ratio_label: formatComplianceRatio(
        ratio(
          state.mark_intent_compliant_count,
          state.mark_intent_required_count
        )
      ),
      consecutive_misses: 0,
    },
    skill: {
      required: state.mark_intent_required_count,
      called: skillCalls,
      ratio: ratio(skillCalls, state.mark_intent_required_count),
      ratio_label: formatComplianceRatio(
        ratio(skillCalls, state.mark_intent_required_count)
      ),
      consecutive_misses: 0,
    },
    runtime_joins: computeWindowJoins(events),
  };
}

/** Fix L — aggregate cross-tier joins across the entire window
 *  (every `{session_id, turn}` pair represented in `events`). Returns
 *  the summed counts plus a `total` so the ribbon can show a single
 *  headline number alongside the per-axis breakdown. */
function computeWindowJoins(events: NamedEvent[]): {
  memory_to_graph: number;
  graph_to_drift: number;
  three_way: number;
  total: number;
} {
  const buckets = new Map<string, NamedEvent[]>();
  for (const ev of events) {
    const key = `${ev.session_id}::${ev.turn}`;
    const arr = buckets.get(key) ?? [];
    arr.push(ev);
    buckets.set(key, arr);
  }
  let mg = 0;
  let gd = 0;
  let tw = 0;
  for (const [key, bucket] of buckets) {
    const [sid, turnStr] = key.split("::");
    if (!sid) continue;
    const turn = Number(turnStr);
    if (!Number.isFinite(turn)) continue;
    const j = computeRuntimeJoins(bucket, sid, turn);
    mg += j.memory_to_graph;
    gd += j.graph_to_drift;
    tw += j.three_way;
  }
  return {
    memory_to_graph: mg,
    graph_to_drift: gd,
    three_way: tw,
    total: mg + gd + tw,
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

    // Fix J — attach per-turn verbatim prompt to each row (LEFT JOIN
    // behavior_events ON session_id+turn AND type='user_prompt_received').
    // Null `prompt` when capture is off (operational metadata only) or
    // when no row exists for the session.
    const enriched = paginated.map((ev) => ({
      ...ev,
      prompt: getPromptForTurn(deps.unerrDir, ev.session_id, ev.turn),
    }));

    return c.json({
      data: enriched,
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

  // ── /compliance — directive-compliance ribbon (Fix H) ─────────────
  app.get("/compliance", (c) => {
    const start = performance.now();
    const period = (c.req.query("period") ?? "today") as Period;
    const agent = c.req.query("agent");
    const sessionId = c.req.query("session_id");
    const filter: NamedEventFilter = {
      ...periodFilter(period, c.req.query("from_ts"), c.req.query("to_ts")),
      agent: agent ?? undefined,
      session_id: sessionId ?? undefined,
    };
    const events = readNamedEvents(deps.unerrDir, filter);
    const ribbon = buildComplianceRibbon(deps.unerrDir, events);
    return c.json({
      data: ribbon,
      _meta: {
        latency_ms: Math.round((performance.now() - start) * 100) / 100,
      },
    });
  });

  // ── /prompt/:session/:turn — Fix J per-turn verbatim prompt lookup
  // Returns the captured `user_prompt_received` row for `{session_id,
  // turn}` (read-redacted). Null `data` when no row exists (agent does
  // not emit the UserPromptSubmit hook, or capture happened before the
  // hook landed). Consumed by Token Flow + Reasoning Quality + Logbook.
  app.get("/prompt/:session/:turn", (c) => {
    const start = performance.now();
    const session = c.req.param("session");
    const turn = Number(c.req.param("turn"));
    if (!session || !Number.isFinite(turn) || turn < 0) {
      return c.json({ error: "invalid_params" }, 400);
    }
    const data = getPromptForTurn(deps.unerrDir, session, turn);
    return c.json({
      data,
      _meta: {
        latency_ms: Math.round((performance.now() - start) * 100) / 100,
      },
    });
  });

  // ── /prompts/:session — every captured prompt for one session
  app.get("/prompts/:session", (c) => {
    const start = performance.now();
    const session = c.req.param("session");
    if (!session) return c.json({ error: "invalid_params" }, 400);
    const data = getPromptsForSession(deps.unerrDir, session);
    return c.json({
      data,
      _meta: {
        latency_ms: Math.round((performance.now() - start) * 100) / 100,
      },
    });
  });

  // ── /prompt-feed — prompt-grouped event summaries ───────────────────
  //
  // Groups events by {session_id, turn} and attaches the captured prompt
  // plus a compact summary per group. Primary data source for the
  // prompt-centric logbook redesign (docs/logbook-page-redesign.md).
  app.get("/prompt-feed", (c) => {
    const start = performance.now();
    const period = (c.req.query("period") ?? "today") as Period;
    const agent = c.req.query("agent");
    const sessionId = c.req.query("session_id");
    const fromTs = c.req.query("from_ts");
    const toTs = c.req.query("to_ts");
    const limit = Math.min(Number(c.req.query("limit") ?? 50), 200);
    const offset = Math.max(Number(c.req.query("offset") ?? 0), 0);

    const filter: NamedEventFilter = {
      ...periodFilter(period, fromTs, toTs),
      agent: agent ?? undefined,
      session_id: sessionId ?? undefined,
    };
    const events = readNamedEvents(deps.unerrDir, filter);

    // Group events by session+turn buckets
    const buckets = new Map<
      string,
      { session_id: string; turn: number; events: NamedEvent[] }
    >();
    for (const ev of events) {
      const key = `${ev.session_id}::${ev.turn}`;
      const existing = buckets.get(key);
      if (existing) {
        existing.events.push(ev);
      } else {
        buckets.set(key, {
          session_id: ev.session_id,
          turn: ev.turn,
          events: [ev],
        });
      }
    }

    // Sort buckets by latest event timestamp (newest first)
    const sorted = [...buckets.values()].sort((a, b) => {
      const latestA = a.events.reduce(
        (max, e) => (e.ts > max ? e.ts : max),
        ""
      );
      const latestB = b.events.reduce(
        (max, e) => (e.ts > max ? e.ts : max),
        ""
      );
      return latestB < latestA ? -1 : latestB > latestA ? 1 : 0;
    });

    const total = sorted.length;
    const page = sorted.slice(offset, offset + limit);

    // Pre-compute ledger stats per session (read once, share across buckets)
    const MARKER_SET = new Set([
      "mark_intent",
      "mark_decision",
      "mark_blocker",
      "mark_resolution",
    ]);
    const ledgerStatsCache = new Map<
      string,
      { tool_call_count: number; marker_count: number }
    >();
    function getLedgerStats(sessionId: string) {
      let cached = ledgerStatsCache.get(sessionId);
      if (!cached) {
        const entries = readLedgerForSession(deps.unerrDir, sessionId);
        cached = {
          tool_call_count: entries.filter((e) => !MARKER_SET.has(e.tool))
            .length,
          marker_count: entries.filter((e) => MARKER_SET.has(e.tool)).length,
        };
        ledgerStatsCache.set(sessionId, cached);
      }
      return cached;
    }

    const feed = page.map((bucket) => {
      const prompt = getPromptForTurn(
        deps.unerrDir,
        bucket.session_id,
        bucket.turn
      );
      const byType = countNamedEventsByType(bucket.events);
      let tokensSaved = 0;
      for (const ev of bucket.events) {
        if (ev.event_type.startsWith("tokenflow.")) {
          const v = (ev.metadata as { tokens_saved?: number }).tokens_saved;
          if (typeof v === "number") tokensSaved += v;
        }
      }
      const agents = new Set(bucket.events.map((e) => e.agent));
      const earliest = bucket.events.reduce(
        (min, e) => (e.ts < min ? e.ts : min),
        bucket.events[0]!.ts
      );
      const latest = bucket.events.reduce(
        (max, e) => (e.ts > max ? e.ts : max),
        bucket.events[0]!.ts
      );
      const featured = sortByEmotionalWeight(bucket.events)[0] ?? null;
      const ledgerStats = getLedgerStats(bucket.session_id);

      return {
        session_id: bucket.session_id,
        turn: bucket.turn,
        prompt: prompt
          ? {
              text: prompt.prompt,
              length: prompt.length,
              classified_as: prompt.classified_as,
            }
          : null,
        summary: {
          event_count: bucket.events.length,
          by_type: byType,
          tokens_saved: tokensSaved,
          agents: [...agents],
          featured_event_type: featured?.event_type ?? null,
          featured_verb: featured?.verb ?? null,
          tool_call_count: ledgerStats.tool_call_count,
          marker_count: ledgerStats.marker_count,
        },
        ts_start: earliest,
        ts_end: latest,
      };
    });

    return c.json({
      data: feed,
      total,
      limit,
      offset,
      _meta: {
        latency_ms: Math.round((performance.now() - start) * 100) / 100,
      },
    });
  });

  // ── /prompt-detail/:session/:turn — full detail for one prompt ─────
  //
  // Returns all events for a session+turn pair, the captured prompt,
  // attribution, and any materialized agent transcript rows.
  // Includes query-time transcript materialization: if no rows exist
  // in agent_transcripts for this session, we try to read + persist
  // them now (covers Cursor sessions where no hook fired).
  app.get("/prompt-detail/:session/:turn", async (c) => {
    const start = performance.now();
    const session = c.req.param("session");
    const turn = Number(c.req.param("turn"));
    if (!session || !Number.isFinite(turn) || turn < 0) {
      return c.json({ error: "invalid_params" }, 400);
    }

    const filter: NamedEventFilter = { session_id: session };
    const allSessionEvents = readNamedEvents(deps.unerrDir, filter);
    const turnEvents = allSessionEvents.filter((e) => e.turn === turn);
    const prompt = getPromptForTurn(deps.unerrDir, session, turn);
    const attribution = extractReceiptAttribution(allSessionEvents, turn);

    // Token savings breakdown for this turn
    let tokensSaved = 0;
    const mechanisms: Record<string, number> = {};
    for (const ev of turnEvents) {
      if (ev.event_type.startsWith("tokenflow.")) {
        const saved = (ev.metadata as { tokens_saved?: number }).tokens_saved;
        if (typeof saved === "number") {
          tokensSaved += saved;
          const mech = ev.event_type.slice("tokenflow.".length);
          mechanisms[mech] = (mechanisms[mech] ?? 0) + saved;
        }
      }
    }

    // Resolve agent name for this session from event data
    const agentName =
      deps.getAgentName?.() ??
      turnEvents.find((e) => e.agent && e.agent !== "unknown")?.agent ??
      allSessionEvents.find((e) => e.agent && e.agent !== "unknown")?.agent ??
      "unknown";

    // Agent transcript rows (materialized into metrics.db)
    let transcript: Array<{
      role: string;
      text: string | null;
      tools: string[] | null;
      files: string[] | null;
      model: string | null;
      tokens_input: number;
      tokens_output: number;
      ts: string;
    }> = [];
    try {
      const store = openMetricsStore(deps.unerrDir);

      // Query-time materialization: if no transcript rows exist for this
      // session yet, try to read from the agent's native logs and persist.
      // This covers Cursor (no hook to trigger materialization) and
      // late-arriving Claude JSONL (hook fired before transcript was written).
      if (!store.hasAgentTranscripts(session) && deps.repoCwd) {
        await materializeTranscripts({
          unerrDir: deps.unerrDir,
          repoCwd: deps.repoCwd,
          sessionId: session,
          agent: agentName,
        });
      }

      // Read all transcript rows for this session (not filtered by turn,
      // because agent turns and unerr turns use different numbering).
      const rows = store.getAgentTranscriptsForSession(session);
      transcript = rows.map((r) => ({
        role: r.role,
        text: r.text,
        tools: r.tools ? (JSON.parse(r.tools) as string[]) : null,
        files: r.files ? (JSON.parse(r.files) as string[]) : null,
        model: r.model,
        tokens_input: r.tokens_input,
        tokens_output: r.tokens_output,
        ts: r.ts,
      }));
    } catch {
      // best-effort: transcript unavailable is not fatal
    }

    // Shadow ledger — every MCP tool call the agent made to unerr
    const ledgerEntries = readLedgerForSession(deps.unerrDir, session);

    const MARKER_TOOLS = new Set([
      "mark_intent",
      "mark_decision",
      "mark_blocker",
      "mark_resolution",
    ]);

    // Tool calls (non-marker entries): what the LLM queried from unerr
    const toolCalls = ledgerEntries
      .filter((e) => !MARKER_TOOLS.has(e.tool))
      .map((e) => ({
        id: e.id,
        ts: e.ts,
        tool: e.tool,
        args_summary: e.args_summary,
        result_summary: e.result_summary,
        turn_id: e.turn_id ?? null,
        correlation_id: e.correlation_id,
      }));

    // Session markers: intent, decision, blocker, resolution
    const markers = ledgerEntries
      .filter((e) => MARKER_TOOLS.has(e.tool))
      .map((e) => ({
        id: e.id,
        ts: e.ts,
        type: e.tool,
        text:
          typeof e.args_summary?.text === "string" ? e.args_summary.text : "",
        turn_id: e.turn_id ?? null,
        alternatives: Array.isArray(e.args_summary?.alternatives)
          ? (e.args_summary.alternatives as string[])
          : null,
        blocker_ref:
          typeof e.args_summary?.blocker_ref === "string"
            ? e.args_summary.blocker_ref
            : null,
        file_path:
          typeof e.args_summary?.file_path === "string"
            ? e.args_summary.file_path
            : null,
      }));

    return c.json({
      data: {
        session_id: session,
        turn,
        prompt: prompt
          ? {
              text: prompt.prompt,
              length: prompt.length,
              classified_as: prompt.classified_as,
              ts: prompt.ts,
            }
          : null,
        events: turnEvents,
        attribution,
        token_optimization: {
          total_saved: tokensSaved,
          mechanisms,
        },
        transcript,
        has_transcript: transcript.length > 0,
        tool_calls: toolCalls,
        markers,
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

    // Fix J — attach the verbatim prompt to the drill view payload.
    // §10.7 — also attach this turn's attribution payload (recalls,
    // captures, drift) so the drill view surfaces the audit trail that
    // used to live in the deleted Surface 4 inline rows. Same extractor
    // the end-of-turn receipt uses; restricted to events from the same
    // session as the drilled event.
    const sessionEvents = eventsAsc.filter(
      (e) => e.session_id === ev.session_id
    );
    const attribution = extractReceiptAttribution(sessionEvents, ev.turn);
    const enriched = {
      ...ev,
      prompt: getPromptForTurn(deps.unerrDir, ev.session_id, ev.turn),
      attribution,
    };

    return c.json({
      data: enriched,
      _meta: {
        latency_ms: Math.round((performance.now() - start) * 100) / 100,
      },
    });
  });

  return app;
}
