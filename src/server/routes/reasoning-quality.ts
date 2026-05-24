/**
 * Reasoning Quality API routes for the dashboard.
 *
 * Derives quality/reasoning metrics from existing token flow data.
 * No new tracking infrastructure — all computed from TokenFlowEvent records.
 *
 * GET /api/reasoning-quality/global    → Cross-session quality metrics
 * GET /api/reasoning-quality/session   → Single session quality metrics
 * GET /api/reasoning-quality/sessions  → Per-session quality scores for list view
 */

import { Hono } from "hono";
import {
  type BehaviorEvent,
  readBehaviorEvents,
} from "../../tracking/behavior-events.js";
import { readSessionHistory } from "../../tracking/session-history.js";
import { getPromptForTurn } from "../../tracking/prompt-trace.js";
import type { TokenFlowWriter } from "../../tracking/token-flow.js";
import {
  type TokenFlowEvent,
  readTokenFlowEvents,
} from "../../tracking/token-flow.js";

export interface ReasoningQualityRouteDeps {
  unerrDir: string;
  getTokenFlowWriter: () => TokenFlowWriter | null;
  getAgentName?: (sessionId: string) => string | undefined;
}

/** Mechanisms that indicate graph-backed precision queries.
 *  `graph_query` was retired — graph hits are now counted from
 *  behavior_events (`graph_query_served`) since they produce no
 *  measurable byte savings, only a counter. */
const GRAPH_MECHANISMS = new Set(["file_read"]);

/** Mechanisms that indicate shell/exec compression */
const SHELL_MECHANISMS = new Set(["shell_compression"]);

/** Behavior event types that prevent breakages / save the user from a
 *  failed call. Counted alongside file_read graph hits. */
const SAFETY_BEHAVIOR_TYPES = new Set([
  "intervention_halted",
  "intervention_warned",
  "cascade_guard",
  "loop_broken",
]);

/** Behavior event type for graph queries served (the replacement for
 *  the deleted `graph_query` token_flow mechanism). */
const GRAPH_QUERY_BEHAVIOR_TYPE = "graph_query_served";

/** Mechanism that carries persistent-memory effectiveness verdicts */
const PERSISTENT_MEMORY_MECHANISM = "persistent_memory";

interface QualityMetrics {
  // ── Category 1: Context Quality ──────────────────────────────
  /** Signal-to-Noise Ratio: tokens_with / tokens_without (lower = cleaner signal) */
  signal_to_noise_ratio: number;
  /** Human-friendly: what % of original noise was removed */
  noise_removed_pct: number;
  /** Entities resolved per 1K tokens delivered */
  context_density: number;
  /** Total graph/file_read events (each = 1 entity resolved) */
  entities_resolved: number;
  /** Total tokens delivered via graph mechanisms */
  graph_tokens_delivered: number;
  /** Attention budget reclaimed: estimated quality multiplier from removed tokens */
  attention_multiplier: number;

  // ── Category 2: Fewer Turns ──────────────────────────────────
  /** % of tool calls resolved via graph (1 call vs 3-5 grep/glob cycles) */
  first_call_resolution_rate: number;
  /** Total graph-backed tool calls */
  graph_calls: number;
  /** Total tool call events */
  total_tool_calls: number;
  /** Estimated turns saved (each graph call saves ~2-3 grep/glob cycles) */
  turns_saved: number;
  /** Hook redirects that prevented exploration loops */
  exploration_loops_prevented: number;

  // ── Category 3: Fewer Breakages ──────────────────────────────
  /** Blast radius / convention / drift warnings auto-injected */
  blast_radius_warnings: number;
  /** Circuit breaker activations (doom spiral prevention) */
  circuit_breaker_activations: number;
  /** Convention/rule injections before code was written */
  convention_injections: number;
  /** Total breakage prevention score */
  prevention_score: number;

  // ── Category 4: Compound Story ───────────────────────────────
  /** Composite: compression × precision */
  reasoning_quality_multiplier: number;
  /** Session metadata */
  total_sessions: number;
  total_turns: number;
  total_events: number;

  // ── Category 5: Persistent Memory ────────────────────────────
  /** Facts injected into tool responses via ur|fct prefix lines */
  facts_surfaced: number;
  /** Explicit `recall_facts` tool calls */
  facts_recalled: number;
  /** Explicit `record_fact` tool calls */
  facts_recorded: number;
  /** Conventions auto-injected into _context */
  conventions_surfaced: number;
  /** Session-resume payloads emitted (cross-session continuity) */
  resume_hits: number;
  /** Negative-fact warnings emitted via ur|wrn */
  negative_warnings: number;
  /** Distinct signals fired (denominator for effectiveness) */
  memory_signals_fired: number;
  /** Signals whose observation window classified as reinforced */
  verdicts_reinforced: number;
  /** Signals whose observation window classified as acted_on */
  verdicts_acted_on: number;
  /** Signals whose observation window classified as ignored */
  verdicts_ignored: number;
  /** Signals whose observation window classified as corrected */
  verdicts_corrected: number;
  /** Negative-fact warnings that observed no recurrence (caught) */
  verdicts_caught: number;
  /** Total verdicts resolved this window */
  memory_verdicts_total: number;
  /** % of verdicts that were load-bearing: (reinforced + acted_on + caught) / verdicts */
  memory_effectiveness_pct: number;
}

function computeQualityMetrics(
  events: TokenFlowEvent[],
  behaviorRows: BehaviorEvent[] = []
): QualityMetrics {
  if (events.length === 0 && behaviorRows.length === 0) {
    return {
      signal_to_noise_ratio: 0,
      noise_removed_pct: 0,
      context_density: 0,
      entities_resolved: 0,
      graph_tokens_delivered: 0,
      attention_multiplier: 1,
      first_call_resolution_rate: 0,
      graph_calls: 0,
      total_tool_calls: 0,
      turns_saved: 0,
      exploration_loops_prevented: 0,
      blast_radius_warnings: 0,
      circuit_breaker_activations: 0,
      convention_injections: 0,
      prevention_score: 0,
      reasoning_quality_multiplier: 0,
      total_sessions: 0,
      total_turns: 0,
      total_events: 0,
      facts_surfaced: 0,
      facts_recalled: 0,
      facts_recorded: 0,
      conventions_surfaced: 0,
      resume_hits: 0,
      negative_warnings: 0,
      memory_signals_fired: 0,
      verdicts_reinforced: 0,
      verdicts_acted_on: 0,
      verdicts_ignored: 0,
      verdicts_corrected: 0,
      verdicts_caught: 0,
      memory_verdicts_total: 0,
      memory_effectiveness_pct: 0,
    };
  }

  let totalWithout = 0;
  let totalWith = 0;
  let graphCalls = 0;
  let graphTokensDelivered = 0;
  let shellCompressionEvents = 0;
  let behaviorEvents = 0;
  let blastRadiusWarnings = 0;
  let circuitBreakerActivations = 0;
  let conventionInjections = 0;
  let explorationLoopsPrevented = 0;
  let dedupEvents = 0;

  // Persistent-memory counters
  let factsSurfaced = 0;
  let factsRecalled = 0;
  let factsRecorded = 0;
  let conventionsSurfaced = 0;
  let resumeHits = 0;
  let negativeWarnings = 0;
  let memorySignalsFired = 0;
  let verdictsReinforced = 0;
  let verdictsActedOn = 0;
  let verdictsIgnored = 0;
  let verdictsCorrected = 0;
  let verdictsCaught = 0;

  const sessions = new Set<string>();
  const turns = new Set<string>();

  for (const e of events) {
    totalWithout += e.tokens_without;
    totalWith += e.tokens_with;
    sessions.add(e.session_id);
    turns.add(`${e.session_id}:${e.turn}`);

    if (GRAPH_MECHANISMS.has(e.mechanism)) {
      graphCalls++;
      graphTokensDelivered += e.tokens_with;
    }

    if (SHELL_MECHANISMS.has(e.mechanism)) {
      shellCompressionEvents++;
    }

    // Extract detail-based counts
    const d = e.detail;
    if (d) {
      // Blast radius warnings: file_read events with callers/references injected
      if (d.counterfactual === "blast_radius" || d.blast_radius) {
        blastRadiusWarnings++;
      }
      // Circuit breaker activations
      if (d.circuit_breaker || d.counterfactual === "circuit_breaker") {
        circuitBreakerActivations++;
      }
      // Convention injections: file_read with conventions injected
      if (
        d.conventions_injected ||
        d.counterfactual === "convention_injection"
      ) {
        conventionInjections++;
      }
      // Hook redirects (exploration loop prevention)
      if (d.hook_redirect || d.counterfactual === "hook_redirect") {
        explorationLoopsPrevented++;
      }
    }

    if (e.mechanism === "session_dedup") {
      dedupEvents++;
    }

    if (e.mechanism === PERSISTENT_MEMORY_MECHANISM && d) {
      const kind = d.kind as string | undefined;
      const verdict = d.verdict as string | undefined;
      if (verdict === "fired") {
        memorySignalsFired++;
        switch (kind) {
          case "fact_injected":
            factsSurfaced++;
            break;
          case "fact_recalled":
            factsRecalled++;
            break;
          case "fact_recorded":
            factsRecorded++;
            break;
          case "convention_injected":
            conventionsSurfaced++;
            break;
          case "resume_injected":
            resumeHits++;
            break;
          case "negative_warned":
            negativeWarnings++;
            break;
        }
      } else {
        switch (verdict) {
          case "reinforced":
            verdictsReinforced++;
            break;
          case "acted_on":
            verdictsActedOn++;
            break;
          case "ignored":
            verdictsIgnored++;
            break;
          case "corrected":
            verdictsCorrected++;
            break;
          case "caught":
            verdictsCaught++;
            break;
        }
      }
    }
  }

  // Fold behavior_event counts in. graph_query_served = a graph hit;
  // intervention_halted/warned + cascade_guard + loop_broken = safety
  // wins. No bytes attributed (PREVENT-class) — counters only.
  for (const b of behaviorRows) {
    sessions.add(b.session_id);
    turns.add(`${b.session_id}:${b.turn}`);
    if (b.type === GRAPH_QUERY_BEHAVIOR_TYPE) {
      graphCalls++;
    }
    if (SAFETY_BEHAVIOR_TYPES.has(b.type)) {
      behaviorEvents++;
    }
  }

  const totalSaved = totalWithout - totalWith;
  const totalToolCalls = events.length + behaviorRows.length;

  // ── Category 1: Context Quality ──
  // SNR: what fraction of original content was signal (delivered / original)
  const snr = totalWithout > 0 ? totalWith / totalWithout : 0;
  const noiseRemovedPct =
    totalWithout > 0
      ? Math.round(((totalWithout - totalWith) / totalWithout) * 100)
      : 0;

  // Context density: graph events per 1K tokens delivered
  const contextDensity =
    graphTokensDelivered > 0
      ? Math.round((graphCalls / (graphTokensDelivered / 1000)) * 10) / 10
      : 0;

  // Attention multiplier: based on the insight that removing N tokens from a
  // context of size C improves attention quality by approximately C/(C-N).
  // Conservative estimate: sqrt of compression ratio.
  const compressionRatio = totalWith > 0 ? totalWithout / totalWith : 1;
  const attentionMultiplier =
    Math.round(Math.sqrt(compressionRatio) * 100) / 100;

  // ── Category 2: Fewer Turns ──
  const firstCallRate =
    totalToolCalls > 0 ? Math.round((graphCalls / totalToolCalls) * 100) : 0;

  // Each graph call saves ~2.5 turns on average (vs grep→read→grep→read cycle)
  const turnsSaved = Math.round(graphCalls * 2.5);

  // ── Category 3: Fewer Breakages ──
  // Safety behavior events (intervention_halted/warned, cascade_guard,
  // loop_broken) roll into the convention-injections count.
  const totalConventionInjections = conventionInjections + behaviorEvents;
  const preventionScore =
    blastRadiusWarnings +
    circuitBreakerActivations * 10 +
    totalConventionInjections;

  // ── Category 4: Compound ──
  const firstCallRateDecimal = firstCallRate / 100;
  const reasoningMultiplier =
    compressionRatio > 0 && firstCallRateDecimal > 0
      ? Math.round(compressionRatio * (1 + firstCallRateDecimal) * 100) / 100
      : 0;

  // ── Category 5: Persistent Memory ──
  const verdictsTotal =
    verdictsReinforced +
    verdictsActedOn +
    verdictsIgnored +
    verdictsCorrected +
    verdictsCaught;
  const loadBearing = verdictsReinforced + verdictsActedOn + verdictsCaught;
  const memoryEffectivenessPct =
    verdictsTotal > 0 ? Math.round((loadBearing / verdictsTotal) * 100) : 0;

  return {
    signal_to_noise_ratio: Math.round(snr * 1000) / 1000,
    noise_removed_pct: noiseRemovedPct,
    context_density: contextDensity,
    entities_resolved: graphCalls,
    graph_tokens_delivered: graphTokensDelivered,
    attention_multiplier: attentionMultiplier,
    first_call_resolution_rate: firstCallRate,
    graph_calls: graphCalls,
    total_tool_calls: totalToolCalls,
    turns_saved: turnsSaved,
    exploration_loops_prevented: explorationLoopsPrevented,
    blast_radius_warnings: blastRadiusWarnings,
    circuit_breaker_activations: circuitBreakerActivations,
    convention_injections: totalConventionInjections,
    prevention_score: preventionScore,
    reasoning_quality_multiplier: reasoningMultiplier,
    total_sessions: sessions.size,
    total_turns: turns.size,
    total_events: events.length,
    facts_surfaced: factsSurfaced,
    facts_recalled: factsRecalled,
    facts_recorded: factsRecorded,
    conventions_surfaced: conventionsSurfaced,
    resume_hits: resumeHits,
    negative_warnings: negativeWarnings,
    memory_signals_fired: memorySignalsFired,
    verdicts_reinforced: verdictsReinforced,
    verdicts_acted_on: verdictsActedOn,
    verdicts_ignored: verdictsIgnored,
    verdicts_corrected: verdictsCorrected,
    verdicts_caught: verdictsCaught,
    memory_verdicts_total: verdictsTotal,
    memory_effectiveness_pct: memoryEffectivenessPct,
  };
}

export function createReasoningQualityRoutes(
  deps: ReasoningQualityRouteDeps
): Hono {
  const app = new Hono();

  // ── /global — Cross-session quality metrics ─────────────────────
  app.get("/global", (c) => {
    const start = performance.now();
    const fromTs = c.req.query("from_ts");
    const toTs = c.req.query("to_ts");

    const events = readTokenFlowEvents(deps.unerrDir, {
      from_ts: fromTs || undefined,
      to_ts: toTs || undefined,
    });
    const behaviorRows = readBehaviorEvents(deps.unerrDir, {
      from_ts: fromTs ?? undefined,
      to_ts: toTs ?? undefined,
    });

    const metrics = computeQualityMetrics(events, behaviorRows);

    return c.json({
      data: metrics,
      _meta: {
        latency_ms: Math.round((performance.now() - start) * 100) / 100,
      },
    });
  });

  // ── /session — Single session quality metrics ───────────────────
  app.get("/session", (c) => {
    const start = performance.now();
    const querySessionId = c.req.query("session_id");
    const writer = deps.getTokenFlowWriter();

    const allEvents = readTokenFlowEvents(deps.unerrDir);
    if (allEvents.length === 0) {
      return c.json({ data: null, _meta: { latency_ms: 0 } });
    }

    let sessionId = querySessionId || writer?.sessionId;
    if (!sessionId) {
      sessionId = allEvents[allEvents.length - 1]?.session_id;
    }
    if (!sessionId) {
      return c.json({ data: null, _meta: { latency_ms: 0 } });
    }

    const sessionEvents = querySessionId
      ? allEvents.filter((e) => e.session_id === sessionId)
      : allEvents.filter(
          (e) => e.session_id === sessionId || e.session_id === "unknown"
        );
    const sessionBehavior = readBehaviorEvents(deps.unerrDir, {
      session_id: sessionId,
    });

    const metrics = computeQualityMetrics(sessionEvents, sessionBehavior);

    // Per-turn quality trajectory (for session health chart)
    const turnGroups = new Map<number, TokenFlowEvent[]>();
    for (const e of sessionEvents) {
      const group = turnGroups.get(e.turn) ?? [];
      group.push(e);
      turnGroups.set(e.turn, group);
    }

    const trajectory: Array<{
      turn: number;
      snr: number;
      cumulative_noise_removed_pct: number;
      graph_calls_this_turn: number;
      context_density: number;
      /** Fix J — verbatim prompt for this turn (redacted at READ time).
       *  Null when capture is off or no row exists. */
      prompt: ReturnType<typeof getPromptForTurn>;
    }> = [];

    let cumWithout = 0;
    let cumWith = 0;

    for (const [turn, turnEvents] of [...turnGroups.entries()].sort(
      ([a], [b]) => a - b
    )) {
      let turnGraphCalls = 0;
      let turnGraphDelivered = 0;

      for (const e of turnEvents) {
        cumWithout += e.tokens_without;
        cumWith += e.tokens_with;
        if (GRAPH_MECHANISMS.has(e.mechanism)) {
          turnGraphCalls++;
          turnGraphDelivered += e.tokens_with;
        }
      }

      trajectory.push({
        turn,
        snr:
          cumWithout > 0 ? Math.round((cumWith / cumWithout) * 1000) / 1000 : 0,
        cumulative_noise_removed_pct:
          cumWithout > 0
            ? Math.round(((cumWithout - cumWith) / cumWithout) * 100)
            : 0,
        graph_calls_this_turn: turnGraphCalls,
        context_density:
          turnGraphDelivered > 0
            ? Math.round((turnGraphCalls / (turnGraphDelivered / 1000)) * 10) /
              10
            : 0,
        // Fix J — LEFT JOIN on {session_id, turn}.
        prompt: getPromptForTurn(deps.unerrDir, sessionId, turn),
      });
    }

    return c.json({
      data: {
        ...metrics,
        session_id: sessionId,
        trajectory,
      },
      _meta: {
        latency_ms: Math.round((performance.now() - start) * 100) / 100,
      },
    });
  });

  // ── /sessions — Quality scores per session for list view ────────
  app.get("/sessions", (c) => {
    const start = performance.now();
    const fromTs = c.req.query("from_ts");
    const toTs = c.req.query("to_ts");
    const limit = Math.min(Number(c.req.query("limit") ?? 50), 200);
    const offset = Math.max(Number(c.req.query("offset") ?? 0), 0);

    const allEvents = readTokenFlowEvents(deps.unerrDir, {
      from_ts: fromTs || undefined,
      to_ts: toTs || undefined,
    });

    // Build agent lookup
    const historyEntries = readSessionHistory(deps.unerrDir);
    const agentBySession = new Map<string, string>();
    for (const h of historyEntries) {
      if (h.agentName) agentBySession.set(h.sessionId, h.agentName);
    }

    // Group events by session
    const sessionMap = new Map<string, TokenFlowEvent[]>();
    for (const e of allEvents) {
      const group = sessionMap.get(e.session_id) ?? [];
      group.push(e);
      sessionMap.set(e.session_id, group);
    }
    const allBehavior = readBehaviorEvents(deps.unerrDir);
    const behaviorBySession = new Map<string, BehaviorEvent[]>();
    for (const b of allBehavior) {
      const group = behaviorBySession.get(b.session_id) ?? [];
      group.push(b);
      behaviorBySession.set(b.session_id, group);
    }

    const allSessions = [...sessionMap.entries()]
      .map(([sessionId, events]) => {
        const m = computeQualityMetrics(
          events,
          behaviorBySession.get(sessionId) ?? []
        );
        const lastTs = events.reduce(
          (max, e) => (e.ts > max ? e.ts : max),
          events[0]!.ts
        );
        const firstTs = events.reduce(
          (min, e) => (e.ts < min ? e.ts : min),
          events[0]!.ts
        );
        return {
          session_id: sessionId,
          first_ts: firstTs,
          last_ts: lastTs,
          agent_name:
            agentBySession.get(sessionId) ??
            deps.getAgentName?.(sessionId) ??
            null,
          noise_removed_pct: m.noise_removed_pct,
          first_call_resolution_rate: m.first_call_resolution_rate,
          prevention_score: m.prevention_score,
          reasoning_quality_multiplier: m.reasoning_quality_multiplier,
          context_density: m.context_density,
          turns_saved: m.turns_saved,
          total_events: m.total_events,
          total_turns: m.total_turns,
          memory_effectiveness_pct: m.memory_effectiveness_pct,
          memory_signals_fired: m.memory_signals_fired,
          memory_verdicts_total: m.memory_verdicts_total,
        };
      })
      .sort((a, b) => (b.last_ts ?? "").localeCompare(a.last_ts ?? ""));

    const paginated = allSessions.slice(offset, offset + limit);

    return c.json({
      data: paginated,
      total: allSessions.length,
      limit,
      offset,
      _meta: {
        latency_ms: Math.round((performance.now() - start) * 100) / 100,
      },
    });
  });

  // ── /trend — Quality metrics over time (per-session chronological) ─
  // Powers the "Quality Over Time" temporal chart in the global view.
  app.get("/trend", (c) => {
    const start = performance.now();
    const fromTs = c.req.query("from_ts");
    const toTs = c.req.query("to_ts");

    const allEvents = readTokenFlowEvents(deps.unerrDir, {
      from_ts: fromTs || undefined,
      to_ts: toTs || undefined,
    });

    // Group by session
    const sessionMap = new Map<string, TokenFlowEvent[]>();
    for (const e of allEvents) {
      const group = sessionMap.get(e.session_id) ?? [];
      group.push(e);
      sessionMap.set(e.session_id, group);
    }
    const allBehaviorTrend = readBehaviorEvents(deps.unerrDir, {
      from_ts: fromTs ?? undefined,
      to_ts: toTs ?? undefined,
    });
    const behaviorBySessionTrend = new Map<string, BehaviorEvent[]>();
    for (const b of allBehaviorTrend) {
      const group = behaviorBySessionTrend.get(b.session_id) ?? [];
      group.push(b);
      behaviorBySessionTrend.set(b.session_id, group);
    }

    // Build chronological trend — one data point per session, ordered by time
    const trend = [...sessionMap.entries()]
      .map(([sessionId, events]) => {
        const m = computeQualityMetrics(
          events,
          behaviorBySessionTrend.get(sessionId) ?? []
        );
        const firstTs = events.reduce(
          (min, e) => (e.ts < min ? e.ts : min),
          events[0]!.ts
        );
        const lastTs = events.reduce(
          (max, e) => (e.ts > max ? e.ts : max),
          events[0]!.ts
        );
        return {
          session_id: sessionId,
          first_ts: firstTs,
          last_ts: lastTs,
          noise_removed_pct: m.noise_removed_pct,
          first_call_resolution_rate: m.first_call_resolution_rate,
          prevention_score: m.prevention_score,
          reasoning_quality_multiplier: m.reasoning_quality_multiplier,
          context_density: m.context_density,
          attention_multiplier: m.attention_multiplier,
          turns_saved: m.turns_saved,
          total_events: m.total_events,
          memory_effectiveness_pct: m.memory_effectiveness_pct,
          memory_signals_fired: m.memory_signals_fired,
        };
      })
      .sort((a, b) => a.first_ts.localeCompare(b.first_ts));

    return c.json({
      data: trend,
      total: trend.length,
      _meta: {
        latency_ms: Math.round((performance.now() - start) * 100) / 100,
      },
    });
  });

  return app;
}
