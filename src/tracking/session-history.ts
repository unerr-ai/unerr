/**
 * Session History Persistence — one row per session in
 * `.unerr/metrics.db` (`session_history`).
 *
 * T.8: Was append-only JSONL at `.unerr/state/session-history.jsonl`;
 * migrated to SQLite for cross-session aggregations used by `unerr stats`.
 * Same wire types — the table is a 1:1 mirror of the old record shape.
 */

import { type SessionHistoryRow, openMetricsStore } from "./metrics-store.js";

/** Layer 10: Per-mechanism savings breakdown attached to session history. */
export interface TokenFlowSessionSummary {
  by_mechanism: Record<string, { tokens_saved: number; event_count: number }>;
  top_mechanism: string;
  efficiency_pct: number;
  total_tokens_saved: number;
  total_tokens_delivered: number;
}

export interface SessionHistoryEntry {
  sessionId: string;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  toolCalls: number;
  tokensSaved: number;
  tokensProcessed: number;
  efficiency: number;
  modelId: string;
  entityCount: number;
  /** MCP client name from initialize handshake (e.g. "claude-code", "cursor") */
  agentName?: string;
  /** Layer 10: Token flow mechanism breakdown for cross-session analysis. */
  tokenFlowSummary?: TokenFlowSessionSummary;
}

export interface AggregatedStats {
  sessions: number;
  tokensSaved: number;
  avgEfficiency: number;
  totalToolCalls: number;
  periodLabel: string;
}

function rowToEntry(r: SessionHistoryRow): SessionHistoryEntry {
  const entry: SessionHistoryEntry = {
    sessionId: r.session_id,
    startedAt: r.started_at,
    endedAt: r.ended_at,
    durationMs: r.duration_ms,
    toolCalls: r.tool_calls,
    tokensSaved: r.tokens_saved,
    tokensProcessed: r.tokens_processed,
    efficiency: r.efficiency,
    modelId: r.model_id,
    entityCount: r.entity_count,
  };
  if (r.agent_name) entry.agentName = r.agent_name;
  if (r.token_flow_summary) {
    try {
      entry.tokenFlowSummary = JSON.parse(
        r.token_flow_summary
      ) as TokenFlowSessionSummary;
    } catch {
      /* malformed JSON — drop the summary field */
    }
  }
  return entry;
}

/**
 * Append (or upsert) a session entry to the history store.
 * The store uses `session_id` as a unique key — re-recording the same
 * session updates the existing row.
 */
export function appendSessionHistory(
  unerrDir: string,
  entry: SessionHistoryEntry
): void {
  try {
    const store = openMetricsStore(unerrDir);
    store.upsertSessionHistory({
      session_id: entry.sessionId,
      started_at: entry.startedAt,
      ended_at: entry.endedAt,
      duration_ms: entry.durationMs,
      tool_calls: entry.toolCalls,
      tokens_saved: entry.tokensSaved,
      tokens_processed: entry.tokensProcessed,
      efficiency: entry.efficiency,
      model_id: entry.modelId,
      entity_count: entry.entityCount,
      agent_name: entry.agentName ?? null,
      token_flow_summary: entry.tokenFlowSummary
        ? JSON.stringify(entry.tokenFlowSummary)
        : null,
    });
  } catch {
    /* best effort — session history is observability, never block exit */
  }
}

/**
 * Read all session history entries.
 */
export function readSessionHistory(unerrDir: string): SessionHistoryEntry[] {
  try {
    return openMetricsStore(unerrDir).allSessionHistory().map(rowToEntry);
  } catch {
    return [];
  }
}

/**
 * Aggregate stats for a time period.
 */
export function aggregateStats(
  entries: SessionHistoryEntry[],
  periodLabel: string
): AggregatedStats {
  if (entries.length === 0) {
    return {
      sessions: 0,
      tokensSaved: 0,
      avgEfficiency: 0,
      totalToolCalls: 0,
      periodLabel,
    };
  }

  const tokensSaved = entries.reduce((s, e) => s + e.tokensSaved, 0);
  const totalToolCalls = entries.reduce((s, e) => s + e.toolCalls, 0);
  const avgEfficiency =
    entries.reduce((s, e) => s + e.efficiency, 0) / entries.length;

  return {
    sessions: entries.length,
    tokensSaved,
    avgEfficiency: Math.round(avgEfficiency),
    totalToolCalls,
    periodLabel,
  };
}

/**
 * Get stats for this week (last 7 days).
 */
export function getWeeklyStats(unerrDir: string): AggregatedStats {
  const all = readSessionHistory(unerrDir);
  const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const thisWeek = all.filter((e) => e.startedAt >= cutoff);
  return aggregateStats(thisWeek, "This week");
}

/**
 * Get stats for this month (last 30 days).
 */
export function getMonthlyStats(unerrDir: string): AggregatedStats {
  const all = readSessionHistory(unerrDir);
  const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const thisMonth = all.filter((e) => e.startedAt >= cutoff);
  return aggregateStats(thisMonth, "This month");
}

/**
 * Get all-time stats.
 */
export function getAllTimeStats(unerrDir: string): AggregatedStats {
  const all = readSessionHistory(unerrDir);
  return aggregateStats(all, "All time");
}
