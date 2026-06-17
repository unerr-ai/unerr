/**
 * Token Flow — unified observability + attribution for token savings.
 *
 * Layer 10: Every token that flows through unerr gets attributed to the mechanism
 * that handled it, aggregated across hierarchical scopes (operation → turn →
 * session → lifetime), and persisted to `.unerr/metrics.db` (token_flow_events
 * table).
 *
 * This replaces the fragmented tracking across EfficiencyTracker, ExplorationCost,
 * IntentTokenTracker, SessionStats, CompressionLog, and WeeklyAccumulator with a
 * single event-sourced model.
 *
 * Performance contract:
 *   - Token estimation: <0.01ms (delegated to token-estimator.ts)
 *   - SQLite insert: <0.05ms (better-sqlite3, prepared statement, WAL)
 *   - Total hot-path overhead: <0.2ms per tool call
 */

import { type TokenFlowEventRow, openMetricsStore } from "./metrics-store.js";
import { NativeSessionResolver } from "./session-records.js";

// ── Data Model ──────────────────────────────────────────────────────

export type TokenFlowMechanism =
  | "graph_query"
  | "session_dedup"
  | "shell_compression"
  | "format_encoding"
  | "smart_truncation"
  | "file_read"
  | "fetch_url"
  | "behavior_automation"
  | "persistent_memory"
  // E4: the understanding-tier origin — one unerr_context bundle collapsing the
  // discovery fan-out into a single call, saving the re-paid context prefix of
  // every round-trip it replaces. Distinct from output-compression.
  | "context_bundle";

export interface TokenFlowEvent {
  /** Monotonic counter per-process (not UUID — fast, no allocation) */
  id: number;
  /** ISO timestamp */
  ts: string;
  /** Session ID (from ShadowLedger or UNERR_SESSION_ID env) */
  session_id: string;
  /** The agent's OWN conversation id (Claude `session_id`, Cursor
   *  `conversation_id`), when the agent exposed it; null otherwise. The PRIMARY
   *  grouping key — `coalesce(native_session_id, session_id)` names a
   *  conversation across reconnects and across the proxy/hook process split. */
  native_session_id?: string | null;
  /** The agent's tool_use id correlating this event to one assistant tool call.
   *  Only the hook path carries it; null on proxy-dispatched rows. */
  tool_use_id?: string | null;
  /** Process ID that produced this event */
  pid: number;
  /** Turn number within session (1-indexed; 0 means "no turn open yet"). */
  turn: number;
  /** Canonical coding-agent id (claude-code, cursor, codex, …). Resolved
   *  by the writer from its `agent` field, with an optional per-call
   *  override on the input. */
  agent: string;
  /** Savings mechanism tag */
  mechanism: TokenFlowMechanism;
  /** MCP tool name (null for shell compression — not a tool call) */
  tool: string | null;
  /** Tokens the agent would have consumed without this mechanism */
  tokens_without: number;
  /** Tokens actually delivered/consumed after optimization */
  tokens_with: number;
  /** Precomputed: tokens_without - tokens_with (saves many subtractions at read time) */
  tokens_saved: number;
  /** Mechanism-specific drill-down context */
  detail?: Record<string, unknown>;
}

export interface MechanismSummary {
  tokens_saved: number;
  tokens_delivered: number;
  event_count: number;
  pct_of_total: number;
}

export interface TurnSummary {
  turn: number;
  tool: string;
  tokens_without: number;
  tokens_delivered: number;
  tokens_saved: number;
  primary_mechanism: string;
}

export interface SessionTokenSummary {
  session_id: string;
  total_turns: number;
  total_tokens_without: number;
  total_tokens_with: number;
  total_tokens_saved: number;
  efficiency_pct: number;
  by_mechanism: Record<string, MechanismSummary>;
  top_turns: TurnSummary[];
}

// ── Input type for record() — fields auto-populated by writer ───────

/** Input the caller passes to `TokenFlowWriter.record`. `turn` and
 *  `agent` are optional — the writer fills them from its turnProvider /
 *  stored agent unless the caller explicitly overrides (used by
 *  persistence-effectiveness, which carries the historical turn at
 *  signal-fire time, and by the proxy initialize handler for per-client
 *  agent attribution on a shared daemon). */
export type TokenFlowInput = Omit<
  TokenFlowEvent,
  "id" | "ts" | "pid" | "turn" | "agent"
> & {
  turn?: number;
  agent?: string;
};

// ── Writer ──────────────────────────────────────────────────────────

/** RC-5: Maximum in-memory session events before eviction. */
const MAX_SESSION_EVENTS = 5000;

function rowToEvent(r: TokenFlowEventRow): TokenFlowEvent {
  let detail: Record<string, unknown> | undefined;
  if (r.detail) {
    try {
      detail = JSON.parse(r.detail) as Record<string, unknown>;
    } catch {
      // corrupt payload — return the row without detail rather than throwing
    }
  }
  return {
    id: r.id,
    ts: r.ts_iso,
    session_id: r.session_id,
    native_session_id: r.native_session_id ?? null,
    tool_use_id: r.tool_use_id ?? null,
    pid: r.pid,
    turn: r.turn,
    agent: r.agent ?? "unknown",
    mechanism: r.mechanism as TokenFlowMechanism,
    tool: r.tool ?? null,
    tokens_without: r.tokens_without,
    tokens_with: r.tokens_with,
    tokens_saved: r.tokens_saved,
    detail,
  };
}

export interface TokenFlowWriterOptions {
  /** Coding-agent id stamped on every row. Defaults to "unknown" and can
   *  be rotated later via `setAgent()` when the MCP initialize frame
   *  arrives. */
  agent?: string;
  /** Returns the current 1-indexed turn number for this session. Wired
   *  to `TurnSegmenter.getCurrentTurnNumber(sessionId)` in production;
   *  defaults to `() => 0` so tests / standalone usage still work. */
  turnProvider?: () => number;
}

export class TokenFlowWriter {
  readonly sessionId: string;
  private readonly unerrDir: string;
  /** In-memory buffer of this process's events for fast aggregation + SSE relay. */
  private sessionEvents: TokenFlowEvent[] = [];
  private agent: string;
  private turnProvider: () => number;
  /** mtime-memoized native-id lookup so every row carries the agent's own
   *  conversation id even when the caller (e.g. router-internal telemetry)
   *  doesn't pass one. */
  private readonly nativeResolver: NativeSessionResolver;

  constructor(
    unerrDir: string,
    sessionId: string,
    options: TokenFlowWriterOptions = {}
  ) {
    this.sessionId = sessionId;
    this.unerrDir = unerrDir;
    this.agent = options.agent ?? "unknown";
    this.turnProvider = options.turnProvider ?? (() => 0);
    this.nativeResolver = new NativeSessionResolver(unerrDir);
    // Eager-open the store so first record() doesn't pay the bootstrap cost.
    openMetricsStore(unerrDir);
  }

  /** Update the agent id (called by the proxy after MCP initialize
   *  arrives and `clientInfo.name` is known). Idempotent. */
  setAgent(agent: string): void {
    if (agent?.trim()) this.agent = agent;
  }

  /** Swap the turn provider — used when the writer is constructed before
   *  ShadowLedger is ready and re-wired afterward. */
  setTurnProvider(provider: () => number): void {
    this.turnProvider = provider;
  }

  /** Current agent id stamped on every row (for diagnostics / tests). */
  getAgent(): string {
    return this.agent;
  }

  /**
   * Record a token flow event. Synchronous, <0.1ms.
   * Inserts into `.unerr/metrics.db` (token_flow_events) and keeps an
   * in-memory copy for session aggregation + SSE relay.
   */
  record(input: TokenFlowInput): void {
    const now = new Date();
    const tsIso = now.toISOString();
    let rowId = 0;
    const turn = input.turn ?? this.turnProvider();
    const agent = input.agent ?? this.agent;
    // Stamp the agent's own conversation id. Honour an explicit value (the
    // proxy passes the registry-resolved id, possibly null); otherwise resolve
    // it by agent from the shared sessions file so router-internal / exec rows
    // group with the rest of the conversation.
    const nativeSessionId =
      input.native_session_id !== undefined
        ? input.native_session_id
        : (this.nativeResolver.resolve(agent)?.nativeSessionId ?? null);

    try {
      rowId = openMetricsStore(this.unerrDir).insertTokenFlow({
        ts: now.getTime(),
        ts_iso: tsIso,
        session_id: input.session_id,
        native_session_id: nativeSessionId,
        tool_use_id: input.tool_use_id ?? null,
        pid: process.pid,
        turn,
        agent,
        mechanism: input.mechanism,
        tool: input.tool,
        tokens_without: input.tokens_without,
        tokens_with: input.tokens_with,
        tokens_saved: input.tokens_saved,
        detail: input.detail ? JSON.stringify(input.detail) : null,
      });
    } catch {
      /* best effort — never block the hot path */
    }

    const event: TokenFlowEvent = {
      id: rowId,
      ts: tsIso,
      pid: process.pid,
      session_id: input.session_id,
      turn,
      agent,
      mechanism: input.mechanism,
      tool: input.tool,
      tokens_without: input.tokens_without,
      tokens_with: input.tokens_with,
      tokens_saved: input.tokens_saved,
      detail: input.detail,
    };

    this.sessionEvents.push(event);

    // RC-5: Evict oldest events if buffer exceeds limit
    if (this.sessionEvents.length > MAX_SESSION_EVENTS) {
      this.sessionEvents = this.sessionEvents.slice(
        -Math.floor(MAX_SESSION_EVENTS * 0.75)
      );
    }
  }

  /** Get all events this process has recorded for the current session. */
  getSessionEvents(): TokenFlowEvent[] {
    return this.sessionEvents;
  }

  /** Running total of tokens saved this session (in-memory, O(1) amortized). */
  getSessionTokensSaved(): number {
    let total = 0;
    for (const e of this.sessionEvents) total += e.tokens_saved;
    return total;
  }

  /** Running session efficiency percentage. */
  getSessionEfficiency(): number {
    let totalWithout = 0;
    let totalSaved = 0;
    for (const e of this.sessionEvents) {
      totalWithout += e.tokens_without;
      totalSaved += e.tokens_saved;
    }
    if (totalWithout === 0) return 0;
    return Math.round((totalSaved / totalWithout) * 100);
  }

  /**
   * Ingest an event produced by another process (relayed via the log-tailer's
   * SQLite poll). Pushes to in-memory buffer for SSE streaming; does NOT
   * re-insert into the DB (the originating process already did).
   */
  ingestExternal(event: TokenFlowEvent): void {
    if (event.pid === process.pid) return;
    this.sessionEvents.push(event);
    if (this.sessionEvents.length > MAX_SESSION_EVENTS) {
      this.sessionEvents = this.sessionEvents.slice(
        -Math.floor(MAX_SESSION_EVENTS * 0.75)
      );
    }
  }
}

// ── Reader ──────────────────────────────────────────────────────────

export interface TokenFlowFilter {
  session_id?: string;
  mechanism?: TokenFlowMechanism;
  /** ISO timestamp — only include events at or after this time */
  from_ts?: string;
  /** ISO timestamp — only include events at or before this time */
  to_ts?: string;
}

/**
 * Read token flow events from the SQLite store with optional filtering.
 * Used for CLI status, dashboard, and session summaries.
 * Performance: <1ms for 1000 events (indexed lookup + row mapping).
 */
export function readTokenFlowEvents(
  unerrDir: string,
  filter?: TokenFlowFilter
): TokenFlowEvent[] {
  let rows: TokenFlowEventRow[];
  try {
    const store = openMetricsStore(unerrDir);
    rows = filter?.session_id
      ? store.tokenFlowBySession(filter.session_id)
      : store.allTokenFlow();
  } catch {
    return [];
  }

  const events: TokenFlowEvent[] = [];
  for (const r of rows) {
    if (filter?.mechanism && r.mechanism !== filter.mechanism) continue;
    if (filter?.from_ts && r.ts_iso < filter.from_ts) continue;
    if (filter?.to_ts && r.ts_iso > filter.to_ts) continue;
    events.push(rowToEvent(r));
  }
  return events;
}

// ── Aggregation ─────────────────────────────────────────────────────

/**
 * Aggregate events into a session-level summary.
 * Computed on-read from the event stream (event sourcing principle).
 */
export function aggregateSession(
  events: TokenFlowEvent[],
  sessionId: string
): SessionTokenSummary {
  const sessionEvents = events.filter((e) => e.session_id === sessionId);

  const mechanismMap = new Map<
    string,
    { saved: number; delivered: number; count: number }
  >();
  const turnMap = new Map<
    number,
    {
      tool: string;
      tokens_without: number;
      tokens_delivered: number;
      tokens_saved: number;
      mechanisms: Map<string, number>;
    }
  >();

  let totalWithout = 0;
  let totalWith = 0;
  let totalSaved = 0;
  const turnNumbers = new Set<number>();

  for (const e of sessionEvents) {
    totalWithout += e.tokens_without;
    totalWith += e.tokens_with;
    totalSaved += e.tokens_saved;
    turnNumbers.add(e.turn);

    // Per-mechanism accumulation
    const mech = mechanismMap.get(e.mechanism) ?? {
      saved: 0,
      delivered: 0,
      count: 0,
    };
    mech.saved += e.tokens_saved;
    mech.delivered += e.tokens_with;
    mech.count++;
    mechanismMap.set(e.mechanism, mech);

    // Per-turn accumulation
    const turn = turnMap.get(e.turn) ?? {
      tool: e.tool ?? "unknown",
      tokens_without: 0,
      tokens_delivered: 0,
      tokens_saved: 0,
      mechanisms: new Map<string, number>(),
    };
    turn.tokens_without += e.tokens_without;
    turn.tokens_delivered += e.tokens_with;
    turn.tokens_saved += e.tokens_saved;
    turn.mechanisms.set(
      e.mechanism,
      (turn.mechanisms.get(e.mechanism) ?? 0) + e.tokens_saved
    );
    if (e.tool) turn.tool = e.tool;
    turnMap.set(e.turn, turn);
  }

  // Build mechanism summary with percentage of total
  const byMechanism: Record<string, MechanismSummary> = {};
  for (const [mechanism, data] of mechanismMap) {
    byMechanism[mechanism] = {
      tokens_saved: data.saved,
      tokens_delivered: data.delivered,
      event_count: data.count,
      pct_of_total:
        totalSaved > 0 ? Math.round((data.saved / totalSaved) * 1000) / 10 : 0,
    };
  }

  // Build top turns sorted by tokens_saved descending, take top 5
  const topTurns: TurnSummary[] = [...turnMap.entries()]
    .map(([turn, data]) => {
      let primaryMechanism = "unknown";
      let maxSaved = 0;
      for (const [mech, saved] of data.mechanisms) {
        if (saved > maxSaved) {
          maxSaved = saved;
          primaryMechanism = mech;
        }
      }
      return {
        turn,
        tool: data.tool,
        tokens_without: data.tokens_without,
        tokens_delivered: data.tokens_delivered,
        tokens_saved: data.tokens_saved,
        primary_mechanism: primaryMechanism,
      };
    })
    .sort((a, b) => b.tokens_saved - a.tokens_saved)
    .slice(0, 5);

  return {
    session_id: sessionId,
    total_turns: turnNumbers.size,
    total_tokens_without: totalWithout,
    total_tokens_with: totalWith,
    total_tokens_saved: totalSaved,
    efficiency_pct:
      totalWithout > 0 ? Math.round((totalSaved / totalWithout) * 100) : 0,
    by_mechanism: byMechanism,
    top_turns: topTurns,
  };
}

/**
 * Aggregate events by mechanism across all sessions (for cross-session trends).
 */
export function aggregateByMechanism(
  events: TokenFlowEvent[]
): Record<string, MechanismSummary> {
  let totalSaved = 0;
  const mechanismMap = new Map<
    string,
    { saved: number; delivered: number; count: number }
  >();

  for (const e of events) {
    totalSaved += e.tokens_saved;
    const mech = mechanismMap.get(e.mechanism) ?? {
      saved: 0,
      delivered: 0,
      count: 0,
    };
    mech.saved += e.tokens_saved;
    mech.delivered += e.tokens_with;
    mech.count++;
    mechanismMap.set(e.mechanism, mech);
  }

  const result: Record<string, MechanismSummary> = {};
  for (const [mechanism, data] of mechanismMap) {
    result[mechanism] = {
      tokens_saved: data.saved,
      tokens_delivered: data.delivered,
      event_count: data.count,
      pct_of_total:
        totalSaved > 0 ? Math.round((data.saved / totalSaved) * 1000) / 10 : 0,
    };
  }

  return result;
}
