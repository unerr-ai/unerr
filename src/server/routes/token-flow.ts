/**
 * Layer 10 TF-D.1: Token Flow API routes for the dashboard.
 *
 * GET /api/token-flow/session      → Current session summary with mechanism breakdown
 * GET /api/token-flow/sessions     → All session IDs with summary stats
 * GET /api/token-flow/history      → Last 20 sessions with tokenFlowSummary
 * GET /api/token-flow/events       → Events (optional ?turn=N, ?mechanism=X, ?session_id=Y)
 * GET /api/token-flow/cumulative   → Per-turn cumulative totals for chart rendering
 *
 * RC1 fix: All reads come from `.unerr/metrics.db` (readTokenFlowEvents), NOT
 * the proxy's in-memory buffer. The proxy process never handles tool calls —
 * `unerr --mcp` does. The proxy's TokenFlowWriter in-memory buffer is always
 * empty for tool-call events.
 */

import { Hono } from "hono";
import { readSessionHistory } from "../../tracking/session-history.js";
import type { TokenFlowWriter } from "../../tracking/token-flow.js";
import {
  type TokenFlowEvent,
  type TokenFlowMechanism,
  aggregateSession,
  readTokenFlowEvents,
} from "../../tracking/token-flow.js";

export interface TokenFlowRouteDeps {
  unerrDir: string;
  getTokenFlowWriter: () => TokenFlowWriter | null;
  /** Resolve agent name for a session ID (from MCP initialize handshake or history) */
  getAgentName?: (sessionId: string) => string | undefined;
}

/**
 * Token-trace surfaces *byte savings* — persistent_memory events carry
 * effectiveness verdicts (zero saved bytes by design) and belong exclusively
 * to the /reasoning page. Strip them from every read in this route.
 */
function stripPersistentMemory(events: TokenFlowEvent[]): TokenFlowEvent[] {
  return events.filter((e) => e.mechanism !== "persistent_memory");
}

export function createTokenFlowRoutes(deps: TokenFlowRouteDeps): Hono {
  const app = new Hono();

  // ── /session — Current session summary ───────────────────────────
  // RC1 fix: Read from disk JSONL, not in-memory buffer.
  // The proxy's writer has the correct sessionId but no events (tool calls
  // happen in the --mcp process). Disk has all events from all processes.
  app.get("/session", (c) => {
    const start = performance.now();
    const writer = deps.getTokenFlowWriter();
    const querySessionId = c.req.query("session_id");

    // Read ALL events from disk (persistent_memory excluded — /reasoning only)
    const allEvents = stripPersistentMemory(readTokenFlowEvents(deps.unerrDir));

    // Priority: query param > proxy writer > most recent from disk
    let sessionId = querySessionId || writer?.sessionId;
    if (!sessionId && allEvents.length > 0) {
      sessionId = allEvents[allEvents.length - 1]?.session_id;
    }

    // No events AND no resolvable session id — return zeroed summary
    // (empty shape, not null, so consumers can read fields uniformly).
    if (allEvents.length === 0 || !sessionId) {
      return c.json({
        data: {
          ...aggregateSession([], sessionId ?? "unknown"),
          event_count: 0,
        },
        _meta: {
          latency_ms: Math.round((performance.now() - start) * 100) / 100,
        },
      });
    }

    // Filter events for this session. When using query param (explicit selection),
    // don't include "unknown" events — only include them for current session.
    const sessionEvents = querySessionId
      ? allEvents.filter((e) => e.session_id === sessionId)
      : allEvents.filter(
          (e) => e.session_id === sessionId || e.session_id === "unknown",
        );
    const summary = aggregateSession(sessionEvents, sessionId);

    // If filtering by sessionId yields nothing, try aggregating all "unknown" events
    // as they likely belong to the current session
    if (summary.total_tokens_saved === 0) {
      const unknownEvents = allEvents.filter((e) => e.session_id === "unknown");
      if (unknownEvents.length > 0) {
        const fallbackSummary = aggregateSession(unknownEvents, "unknown");
        return c.json({
          data: {
            ...fallbackSummary,
            session_id: sessionId,
            event_count: unknownEvents.length,
          },
          _meta: {
            latency_ms: Math.round((performance.now() - start) * 100) / 100,
          },
        });
      }
    }

    return c.json({
      data: {
        ...summary,
        event_count: sessionEvents.length,
      },
      _meta: {
        latency_ms: Math.round((performance.now() - start) * 100) / 100,
      },
    });
  });

  // ── /global — Cross-session aggregate (all time or date range) ──
  // Powers the Global view KPIs: total saved/delivered across ALL sessions.
  // Supports: ?from_ts=ISO&to_ts=ISO
  app.get("/global", (c) => {
    const start = performance.now();
    const fromTs = c.req.query("from_ts");
    const toTs = c.req.query("to_ts");
    const allEvents = stripPersistentMemory(
      readTokenFlowEvents(deps.unerrDir, {
        from_ts: fromTs || undefined,
        to_ts: toTs || undefined,
      }),
    );

    const emptyCompound = {
      total_sessions: 0,
      total_turns: 0,
      total_tokens_without: 0,
      total_tokens_with: 0,
      total_tokens_saved: 0,
      efficiency_pct: 0,
      by_mechanism: {} as Record<
        string,
        {
          tokens_saved: number;
          tokens_delivered: number;
          event_count: number;
          pct_of_total: number;
        }
      >,
      event_count: 0,
      avg_context_reduction: 0,
      peak_context_reduction: 0,
      total_context_avoided: 0,
    };

    if (allEvents.length === 0) {
      return c.json({ data: emptyCompound, _meta: { latency_ms: 0 } });
    }

    let totalWithout = 0;
    let totalWith = 0;
    let totalSaved = 0;
    const sessions = new Set<string>();
    const turns = new Set<string>(); // "session:turn" for dedup
    const mechMap = new Map<
      string,
      { saved: number; delivered: number; count: number }
    >();

    for (const e of allEvents) {
      totalWithout += e.tokens_without;
      totalWith += e.tokens_with;
      totalSaved += e.tokens_saved;
      sessions.add(e.session_id);
      turns.add(`${e.session_id}:${e.turn}`);

      const m = mechMap.get(e.mechanism) ?? {
        saved: 0,
        delivered: 0,
        count: 0,
      };
      m.saved += e.tokens_saved;
      m.delivered += e.tokens_with;
      m.count++;
      mechMap.set(e.mechanism, m);
    }

    // Compound savings: per-session, per-turn cumulative sums.
    // Context resets between sessions, so compute independently per session.
    const sessionTurnSaved = new Map<string, Map<number, number>>();
    for (const e of allEvents) {
      let turnMap = sessionTurnSaved.get(e.session_id);
      if (!turnMap) {
        turnMap = new Map();
        sessionTurnSaved.set(e.session_id, turnMap);
      }
      turnMap.set(e.turn, (turnMap.get(e.turn) ?? 0) + e.tokens_saved);
    }
    let compoundTotal = 0;
    for (const turnMap of sessionTurnSaved.values()) {
      const sortedTurns = [...turnMap.entries()].sort(([a], [b]) => a - b);
      let cumSaved = 0;
      for (const [, saved] of sortedTurns) {
        cumSaved += saved;
        compoundTotal += cumSaved;
      }
    }

    const byMechanism: Record<
      string,
      {
        tokens_saved: number;
        tokens_delivered: number;
        event_count: number;
        pct_of_total: number;
      }
    > = {};
    for (const [mech, data] of mechMap) {
      byMechanism[mech] = {
        tokens_saved: data.saved,
        tokens_delivered: data.delivered,
        event_count: data.count,
        pct_of_total:
          totalSaved > 0 ? Math.round((data.saved / totalSaved) * 100) : 0,
      };
    }

    return c.json({
      data: {
        total_sessions: sessions.size,
        total_turns: turns.size,
        total_tokens_without: totalWithout,
        total_tokens_with: totalWith,
        total_tokens_saved: totalSaved,
        efficiency_pct:
          totalWithout > 0 ? Math.round((totalSaved / totalWithout) * 100) : 0,
        by_mechanism: byMechanism,
        event_count: allEvents.length,
        avg_context_reduction:
          turns.size > 0 ? Math.round(compoundTotal / turns.size) : 0,
        peak_context_reduction: totalSaved,
        total_context_avoided: compoundTotal,
      },
      _meta: {
        latency_ms: Math.round((performance.now() - start) * 100) / 100,
      },
    });
  });

  // ── /sessions — List all unique session IDs ─────────────────────
  // Supports: ?limit=N&offset=N&from_ts=ISO&to_ts=ISO
  app.get("/sessions", (c) => {
    const start = performance.now();
    const fromTs = c.req.query("from_ts");
    const toTs = c.req.query("to_ts");
    // Pagination is opt-in: callers without a `limit` get all sessions so they
    // can compute aggregates that match `/global`. UI clients pass an explicit
    // limit when they want a paginated view (capped at 200).
    const rawLimit = c.req.query("limit");
    const limit =
      rawLimit !== undefined
        ? Math.min(Math.max(Number(rawLimit), 1), 200)
        : Number.MAX_SAFE_INTEGER;
    const offset = Math.max(Number(c.req.query("offset") ?? 0), 0);

    const allEvents = stripPersistentMemory(
      readTokenFlowEvents(deps.unerrDir, {
        from_ts: fromTs || undefined,
        to_ts: toTs || undefined,
      }),
    );

    // Build agent lookup from session history
    const historyEntries = readSessionHistory(deps.unerrDir);
    const agentBySession = new Map<string, string>();
    for (const h of historyEntries) {
      if (h.agentName) agentBySession.set(h.sessionId, h.agentName);
    }

    const sessionMap = new Map<
      string,
      {
        event_count: number;
        total_saved: number;
        first_ts: string;
        last_ts: string;
        mechanisms: Set<string>;
        turnSaved: Map<number, number>;
      }
    >();

    for (const e of allEvents) {
      const entry = sessionMap.get(e.session_id) ?? {
        event_count: 0,
        total_saved: 0,
        first_ts: e.ts,
        last_ts: e.ts,
        mechanisms: new Set<string>(),
        turnSaved: new Map<number, number>(),
      };
      entry.event_count++;
      entry.total_saved += e.tokens_saved;
      if (e.ts < entry.first_ts) entry.first_ts = e.ts;
      if (e.ts > entry.last_ts) entry.last_ts = e.ts;
      entry.mechanisms.add(e.mechanism);
      entry.turnSaved.set(
        e.turn,
        (entry.turnSaved.get(e.turn) ?? 0) + e.tokens_saved,
      );
      sessionMap.set(e.session_id, entry);
    }

    const allSessions = [...sessionMap.entries()]
      .map(([id, data]) => {
        // Compute avg context reduction: compound total / num turns
        const sortedTurns = [...data.turnSaved.entries()].sort(
          ([a], [b]) => a - b,
        );
        let cumSaved = 0;
        let compoundTotal = 0;
        for (const [, saved] of sortedTurns) {
          cumSaved += saved;
          compoundTotal += cumSaved;
        }
        const numTurns = sortedTurns.length;
        return {
          session_id: id,
          event_count: data.event_count,
          total_saved: data.total_saved,
          total_turns: numTurns,
          avg_context_reduction:
            numTurns > 0 ? Math.round(compoundTotal / numTurns) : 0,
          first_ts: data.first_ts,
          last_ts: data.last_ts,
          mechanisms: [...data.mechanisms],
          agent_name: agentBySession.get(id) ?? deps.getAgentName?.(id) ?? null,
        };
      })
      .sort((a, b) => b.last_ts.localeCompare(a.last_ts));

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

  // ── /history — Recent sessions from session-history.jsonl ───────
  app.get("/history", (c) => {
    const start = performance.now();
    const limit = Math.min(Number(c.req.query("limit") ?? 20), 50);

    const entries = readSessionHistory(deps.unerrDir);
    const withFlow = entries
      .filter((e) => e.tokenFlowSummary)
      .slice(-limit)
      .reverse();

    return c.json({
      data: withFlow.map((e) => ({
        session_id: e.sessionId,
        started_at: e.startedAt,
        ended_at: e.endedAt,
        duration_ms: e.durationMs,
        tool_calls: e.toolCalls,
        tokens_saved: e.tokensSaved,
        efficiency: e.efficiency,
        token_flow: e.tokenFlowSummary,
      })),
      total: withFlow.length,
      _meta: {
        latency_ms: Math.round((performance.now() - start) * 100) / 100,
      },
    });
  });

  // ── /events — Events with filters ───────────────────────────────
  // Supports: ?session_id=X&turn=N&mechanism=X&from_ts=ISO&to_ts=ISO&limit=N&offset=N
  // RC1 fix: Always read from disk, not in-memory.
  app.get("/events", (c) => {
    const start = performance.now();
    const turnFilter = c.req.query("turn");
    const mechanismFilter = c.req.query("mechanism") as
      | TokenFlowMechanism
      | undefined;
    const sessionFilter = c.req.query("session_id");
    const fromTs = c.req.query("from_ts");
    const toTs = c.req.query("to_ts");
    const limit = Math.min(Number(c.req.query("limit") ?? 200), 500);
    const offset = Math.max(Number(c.req.query("offset") ?? 0), 0);

    // Always read from disk — the proxy process has no in-memory events
    let events = stripPersistentMemory(
      readTokenFlowEvents(deps.unerrDir, {
        session_id: sessionFilter || undefined,
        mechanism: mechanismFilter || undefined,
        from_ts: fromTs || undefined,
        to_ts: toTs || undefined,
      }),
    );

    // If no session filter provided, include current session + "unknown"
    if (!sessionFilter) {
      const writer = deps.getTokenFlowWriter();
      if (writer) {
        events = events.filter(
          (e) =>
            e.session_id === writer.sessionId || e.session_id === "unknown",
        );
      }
    }

    if (turnFilter) {
      const turnNum = Number(turnFilter);
      if (!Number.isNaN(turnNum)) {
        events = events.filter((e) => e.turn === turnNum);
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

  // ── /cumulative — Per-turn cumulative totals for charts ─────────
  app.get("/cumulative", (c) => {
    const start = performance.now();
    const sessionFilter = c.req.query("session_id");
    const writer = deps.getTokenFlowWriter();

    let events = stripPersistentMemory(readTokenFlowEvents(deps.unerrDir));

    // Filter to relevant session
    const targetSession = sessionFilter ?? writer?.sessionId;
    if (targetSession) {
      events = events.filter(
        (e) => e.session_id === targetSession || e.session_id === "unknown",
      );
    }

    // Sort by turn, then by timestamp within turn
    events.sort((a, b) => a.turn - b.turn || a.ts.localeCompare(b.ts));

    // Build cumulative per-turn data
    const turnData: Array<{
      turn: number;
      tools: string[];
      tokens_saved_this_turn: number;
      cumulative_tokens_saved: number;
      /** Context avoided at this turn = cumulative savings up to this point */
      context_avoided: number;
      mechanisms_this_turn: Record<string, number>;
      cumulative_by_mechanism: Record<string, number>;
      event_count: number;
    }> = [];

    const cumulativeMechanisms: Record<string, number> = {};
    let cumulativeSaved = 0;
    let contextTurnsTotal = 0; // sum of cumulative savings at each turn

    // Group events by turn
    const turnGroups = new Map<number, TokenFlowEvent[]>();
    for (const e of events) {
      const group = turnGroups.get(e.turn) ?? [];
      group.push(e);
      turnGroups.set(e.turn, group);
    }

    for (const [turn, turnEvents] of [...turnGroups.entries()].sort(
      ([a], [b]) => a - b,
    )) {
      let turnSaved = 0;
      const mechanismsThisTurn: Record<string, number> = {};
      const tools = new Set<string>();

      for (const e of turnEvents) {
        turnSaved += e.tokens_saved;
        mechanismsThisTurn[e.mechanism] =
          (mechanismsThisTurn[e.mechanism] ?? 0) + e.tokens_saved;
        cumulativeMechanisms[e.mechanism] =
          (cumulativeMechanisms[e.mechanism] ?? 0) + e.tokens_saved;
        if (e.tool) tools.add(e.tool);
      }

      cumulativeSaved += turnSaved;
      contextTurnsTotal += cumulativeSaved;

      turnData.push({
        turn,
        tools: [...tools],
        tokens_saved_this_turn: turnSaved,
        cumulative_tokens_saved: cumulativeSaved,
        context_avoided: cumulativeSaved,
        mechanisms_this_turn: mechanismsThisTurn,
        cumulative_by_mechanism: { ...cumulativeMechanisms },
        event_count: turnEvents.length,
      });
    }

    // Avg context reduction per turn: how much smaller context was on average
    const numTurns = turnData.length;
    const avgContextReduction =
      numTurns > 0 ? Math.round(contextTurnsTotal / numTurns) : 0;

    return c.json({
      data: turnData,
      total_turns: numTurns,
      total_saved: cumulativeSaved,
      avg_context_reduction: avgContextReduction,
      peak_context_reduction: cumulativeSaved, // max = final cumulative
      total_context_avoided: contextTurnsTotal, // sum of cumulative savings at each turn
      _meta: {
        latency_ms: Math.round((performance.now() - start) * 100) / 100,
      },
    });
  });

  return app;
}
