/**
 * Behavior Events — named verb-noun counters for PREVENT-class mechanisms.
 *
 * Replaces the counterfactual "tokens saved" estimate for events where no
 * real measurement of the avoided cost is possible (graph queries the agent
 * would have grep'd for, tool calls a behavior intercepted, retry loops the
 * circuit breaker halted). Instead of fabricating a tokens_without number,
 * we record discrete named events the user can count and drill into.
 *
 * The companion record (token_flow.ts) covers COMPRESS-class mechanisms
 * where pre/post byte counts are physically observable.
 */

import { type BehaviorEventRow, openMetricsStore } from "./metrics-store.js";

// ── Data Model ──────────────────────────────────────────────────────

export type BehaviorEventType =
  /** Agent's graph-tool call (search_code, get_references, get_entity, etc.)
   *  was served from the graph instead of grep + file reads. */
  | "graph_query_served"
  /** A `file_outline` / `get_file` call delivered a structural summary
   *  instead of a full file read. */
  | "full_read_avoided"
  /** Circuit breaker halted a retry loop on the same entity. */
  | "loop_broken"
  /** Cascade-guard fired before a high-fan-in edit (caller-aware edit). */
  | "cascade_guard"
  /** `ur|ctx` (drift) signal was consumed (agent re-read after a drift signal). */
  | "drift_consumed"
  /** A behavior halted a tool call before it ran (pre-tool-use hook). */
  | "intervention_halted"
  /** A behavior emitted a warning that did not halt the call. */
  | "intervention_warned"
  /** Defuddle (fetch_url extractor) threw a non-fatal selector-parse
   *  error that was suppressed from logs. First occurrence per signature
   *  prints one summary line; subsequent ones bump this counter only. */
  | "defuddle_selector_skipped"
  // ── Phase 1 additions — feeds the named-events projection layer.
  // Pure additions: existing emit sites are unchanged. The four-surface
  // model (preface, footer, attribution, capture) consumes these via
  // `src/tracking/named-events.ts` without modifying the underlying
  // behavior_events table or any existing reader.
  /** A pre-edit caller check (`get_references({direction:'callers'})`)
   *  was enforced before an edit on a high-fan-in entity. */
  | "caller_check_enforced"
  /** A stale-edit attempt was caught — agent re-read after `ur|ctx` (drift) and
   *  avoided overwriting changed content. */
  | "stale_edit_prevented"
  /** A stored fact surfaced into context this turn via auto-injection
   *  or explicit `recall_facts`. */
  | "fact_recalled"
  /** A detected project convention was applied to new code in this turn. */
  | "convention_applied"
  /** A cache hit served the request (web fetch diff-cache, file outline
   *  cache, search index cache). */
  | "cache_hit"
  /** Session-resume reused work from a prior session (facts, conventions,
   *  blockers carried over) instead of re-deriving from scratch. */
  | "cross_session_resume"
  /** User-asserted fact captured via the `unerr_remember` tool. */
  | "fact_stored_user_fed"
  /** Auto-detected fact captured via `record_fact` or behavior auto-doc. */
  | "fact_stored_auto"
  /** Cascade-guard warning was consumed by the agent (read + acted on
   *  before edit). Pair to `cascade_guard` which only fires; this one
   *  measures whether the agent actually adjusted. */
  | "cascade_warning_consumed"
  // ── Phase 2 additions
  /** `unerr_remember` was called but confidence fell below the floor
   *  (0.5). Tool returned `{ stored: false }` instead of writing. */
  | "fact_capture_abandoned"
  /** A pending capture / retrieval confirmation expired without a
   *  resolution turn (Sprint 6 ambiguity-gated path). */
  | "confirmation_expired"
  // ── Phase 3 additions (Sprint 12 telemetry)
  /** Surface 2/3 preface/footer collapsed to the `unerr » ⋯` ambient
   *  marker because there was nothing to report this turn. */
  | "presence_ambient_marker"
  // ── Fix K (Surface-Reliability) addition
  /** Session-resume surfaced ≥1 open blocker carried over from a prior
   *  session into the resume strip. Counts per emission, not per blocker —
   *  one row per resume block render with `detail.count` for the population. */
  | "resume_blockers_surfaced"
  // ── Fix B/D (Surface-Reliability) additions
  /** Agent called `unerr_surface2_line` this turn — Surface 2 directive
   *  was honoured. One row per dispatch. */
  | "surface2_emitted"
  /** Coding-task prompt arrived but the prior turn's `unerr_surface2_line`
   *  call never fired — Surface 2 directive was missed. One row per
   *  detection (i.e. each fired buildSurface2Line that follows a miss). */
  | "surface2_missed"
  // §10.7 — Surface 4 trace events deleted. Surface 4a (inline attribution)
  // was merged into the Surface 3 receipt rendered by `unerr_turn_summary`.
  // Surface 4c (pending-confirmation prompt) and Surface 4d (fact-steering
  // preface) remain as runtime behaviors but no longer emit trace events
  // — the compliance ribbon row that consumed them was removed in the
  // same change. Reintroduce a `fact_steering_emitted` event here if a
  // future telemetry need emerges.
  // ── Fix J (Surface-Reliability) verbatim-prompt capture ────────────
  /** A user prompt arrived via the UserPromptSubmit hook. `detail.prompt`
   *  carries the verbatim string ONLY when `capture_prompts: true` in
   *  `.unerr/config.json`; otherwise `prompt` is null and only `length +
   *  classified_as` are populated. Anchored on `{session_id, turn}` —
   *  joined into Token Flow / Reasoning Quality / Logbook trace pages
   *  as the per-turn execution anchor. */
  | "user_prompt_received";

export interface BehaviorEvent {
  /** Monotonic counter per-process. */
  id: number;
  /** ISO timestamp. */
  ts: string;
  /** Session ID (from ShadowLedger or UNERR_SESSION_ID env). */
  session_id: string;
  /** Process ID that produced this event. */
  pid: number;
  /** Turn number within session (1-indexed; 0 means "no turn open yet"). */
  turn: number;
  /** Canonical coding-agent id (claude-code, cursor, codex, …). Resolved
   *  by the writer from its `agent` field, with an optional per-call
   *  override on the input. */
  agent: string;
  /** Verb-noun event type. */
  type: BehaviorEventType;
  /** MCP tool name when tool-bound; null for behaviors that fired
   *  outside a tool call. */
  tool: string | null;
  /** Entity / file / URL the event was attached to. Null when N/A. */
  entity_key: string | null;
  /** Response bytes delivered when the event came from a tool response;
   *  null for pure intercepts. */
  response_bytes: number | null;
  /** Event-specific drill-down context. */
  detail?: Record<string, unknown>;
}

/** Input the caller passes to `BehaviorEventWriter.record`. `turn` and
 *  `agent` are optional — the writer fills them from its turnProvider /
 *  stored agent unless the caller explicitly overrides (used by
 *  persistence-effectiveness, which carries the historical turn at
 *  signal-fire time, and by the proxy initialize handler for per-client
 *  agent attribution on a shared daemon). */
export type BehaviorEventInput = Omit<
  BehaviorEvent,
  "id" | "ts" | "pid" | "turn" | "agent"
> & {
  turn?: number;
  agent?: string;
};

// ── Writer ──────────────────────────────────────────────────────────

const MAX_SESSION_EVENTS = 5000;

function rowToEvent(r: BehaviorEventRow): BehaviorEvent {
  let detail: Record<string, unknown> | undefined;
  if (r.detail) {
    try {
      detail = JSON.parse(r.detail) as Record<string, unknown>;
    } catch {
      // corrupt payload — drop detail, keep the row
    }
  }
  return {
    id: r.id,
    ts: r.ts_iso,
    session_id: r.session_id,
    pid: r.pid,
    turn: r.turn,
    agent: r.agent ?? "unknown",
    type: r.type as BehaviorEventType,
    tool: r.tool ?? null,
    entity_key: r.entity_key ?? null,
    response_bytes: r.response_bytes ?? null,
    detail,
  };
}

export type BehaviorEventSink = (event: BehaviorEvent) => void;

export interface BehaviorEventWriterOptions {
  /** Coding-agent id stamped on every row. Defaults to "unknown" and can
   *  be rotated later via `setAgent()` when the MCP initialize frame
   *  arrives. */
  agent?: string;
  /** Returns the current 1-indexed turn number for this session. Wired
   *  to `TurnSegmenter.getCurrentTurnNumber(sessionId)` in production;
   *  defaults to `() => 0` so tests / standalone usage still work. */
  turnProvider?: () => number;
}

export class BehaviorEventWriter {
  readonly sessionId: string;
  private readonly unerrDir: string;
  private sessionEvents: BehaviorEvent[] = [];
  private sinks: BehaviorEventSink[] = [];
  private agent: string;
  private turnProvider: () => number;

  constructor(
    unerrDir: string,
    sessionId: string,
    options: BehaviorEventWriterOptions = {}
  ) {
    this.sessionId = sessionId;
    this.unerrDir = unerrDir;
    this.agent = options.agent ?? "unknown";
    this.turnProvider = options.turnProvider ?? (() => 0);
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

  /** Register a callback invoked after every `record()`. Used to bridge
   *  recorded events onto the dashboard SSE bus. Never throws — sink
   *  failures are swallowed to protect the hot path. */
  onRecord(sink: BehaviorEventSink): () => void {
    this.sinks.push(sink);
    return () => {
      this.sinks = this.sinks.filter((s) => s !== sink);
    };
  }

  record(input: BehaviorEventInput): void {
    const now = new Date();
    const tsIso = now.toISOString();
    let rowId = 0;
    const turn = input.turn ?? this.turnProvider();
    const agent = input.agent ?? this.agent;

    try {
      rowId = openMetricsStore(this.unerrDir).insertBehaviorEvent({
        ts: now.getTime(),
        ts_iso: tsIso,
        session_id: input.session_id,
        pid: process.pid,
        turn,
        agent,
        type: input.type,
        tool: input.tool,
        entity_key: input.entity_key,
        response_bytes: input.response_bytes,
        detail: input.detail ? JSON.stringify(input.detail) : null,
      });
    } catch {
      /* best effort — never block the hot path */
    }

    const event: BehaviorEvent = {
      id: rowId,
      ts: tsIso,
      pid: process.pid,
      session_id: input.session_id,
      turn,
      agent,
      type: input.type,
      tool: input.tool,
      entity_key: input.entity_key,
      response_bytes: input.response_bytes,
      detail: input.detail,
    };

    this.sessionEvents.push(event);

    if (this.sessionEvents.length > MAX_SESSION_EVENTS) {
      this.sessionEvents = this.sessionEvents.slice(
        -Math.floor(MAX_SESSION_EVENTS * 0.75)
      );
    }

    for (const sink of this.sinks) {
      try {
        sink(event);
      } catch {
        /* never let a sink break the writer */
      }
    }
  }

  getSessionEvents(): BehaviorEvent[] {
    return this.sessionEvents;
  }

  /** Counts per event type for this session — feeds the dashboard counter pane. */
  getSessionCounts(): Record<string, number> {
    const counts: Record<string, number> = {};
    for (const e of this.sessionEvents) {
      counts[e.type] = (counts[e.type] ?? 0) + 1;
    }
    return counts;
  }

  ingestExternal(event: BehaviorEvent): void {
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

export interface BehaviorEventFilter {
  session_id?: string;
  type?: BehaviorEventType;
  tool?: string;
  from_ts?: string;
  to_ts?: string;
}

export function readBehaviorEvents(
  unerrDir: string,
  filter?: BehaviorEventFilter
): BehaviorEvent[] {
  let rows: BehaviorEventRow[];
  try {
    const store = openMetricsStore(unerrDir);
    rows = filter?.session_id
      ? store.behaviorEventsBySession(filter.session_id)
      : store.allBehaviorEvents();
  } catch {
    return [];
  }

  const events: BehaviorEvent[] = [];
  for (const r of rows) {
    if (filter?.type && r.type !== filter.type) continue;
    if (filter?.tool && r.tool !== filter.tool) continue;
    if (filter?.from_ts && r.ts_iso < filter.from_ts) continue;
    if (filter?.to_ts && r.ts_iso > filter.to_ts) continue;
    events.push(rowToEvent(r));
  }
  return events;
}

// ── Aggregation ─────────────────────────────────────────────────────

export interface BehaviorEventCounts {
  /** Count keyed by event type. */
  by_type: Record<string, number>;
  /** Count keyed by tool name (null bucket for tool-less events). */
  by_tool: Record<string, number>;
  /** Total events across all types. */
  total: number;
}

export function aggregateBehaviorCounts(
  events: BehaviorEvent[]
): BehaviorEventCounts {
  const byType: Record<string, number> = {};
  const byTool: Record<string, number> = {};
  for (const e of events) {
    byType[e.type] = (byType[e.type] ?? 0) + 1;
    const toolKey = e.tool ?? "(none)";
    byTool[toolKey] = (byTool[toolKey] ?? 0) + 1;
  }
  return { by_type: byType, by_tool: byTool, total: events.length };
}
