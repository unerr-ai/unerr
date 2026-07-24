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
import { NativeSessionResolver } from "./session-records.js";

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
  /** Cap B: a soft `ur|act` redirect fired before the circuit tripped —
   *  the agent was nudged to a different tool after `redirectThreshold`
   *  consecutive failures on the same entity. Protective but non-halting,
   *  so it is bucketed `prevented` yet excluded from HARD_PREVENTION. One
   *  row per redirect trip — `detail.attempts` carries the failure count,
   *  `detail.target_entity` the looping entity. */
  | "loop_redirect"
  /** Cap A: a resolved blocker was distilled into a reusable trajectory
   *  trace (symptom → dead ends → fix → anchor) at mark_resolution. One
   *  row per trace persisted — `detail.dead_ends` carries the count of
   *  dead-end paths captured, `detail.anchor` the resolved location. */
  | "trace_captured"
  /** Cap A: a past resolved incident matching the current prompt's symptom
   *  was surfaced into context via `unerr_recall_traces`. One row per recall
   *  that returned ≥1 trace — `detail.count` carries the surfaced population. */
  | "trace_recalled"
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
  /** A detected project convention was applied to new code in this turn. */
  | "convention_applied"
  /** A cache hit served the request (file outline cache, search index
   *  cache). */
  | "cache_hit"
  /** Session-resume reused work from a prior session (facts, conventions,
   *  blockers carried over) instead of re-deriving from scratch. */
  | "cross_session_resume"
  /** Cascade-guard warning was consumed by the agent (read + acted on
   *  before edit). Pair to `cascade_guard` which only fires; this one
   *  measures whether the agent actually adjusted. */
  | "cascade_warning_consumed"
  // ── Phase 2 additions
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
  | "user_prompt_received"
  // ── Reviewer (Surface A — in-flight post-edit review) ──────────────
  /** The in-flight review engine surfaced ≥1 finding on a post-edit
   *  `unerr/review_edit` query. One row per emission (not per finding) —
   *  `detail.count` carries the surfaced population, `detail.top_severity`
   *  the lead finding's severity, `detail.checkers` the firing checker ids. */
  | "review_finding_surfaced"
  // ── Pre-edit boundary guard + session-end incomplete-work ──────────
  // Siblings to cascade_guard: the unerr/blast_radius hook computes a
  // caller-cascade signal AND an architecture-boundary signal; both are
  // distinct behaviors (D2 vs D3) and each fires its own row.
  /** The pre-edit architecture-boundary guard flagged ≥1 cross-layer
   *  implementation import on a `unerr/blast_radius` query. One row per
   *  emission — `detail.violations` carries the count, `detail.target_layers`
   *  the forbidden layers reached into. */
  | "boundary_violation_flagged"
  /** Session-end reconciliation flagged broken callers — a signature
   *  changed this session whose callers were never updated. One row per
   *  session-end emission — `detail.items` carries the flagged count,
   *  `detail.entities` the changed-entity names. Persisted alongside
   *  `.unerr/state/incomplete-work.json`, which the next session's resume
   *  strip reads. */
  | "incomplete_work_flagged"
  // ── CROSS_REPO_INTELLIGENCE (Sprint 5.1) — cross-repo (workspace) access ──
  /** A `scope:'workspace'` tool call fanned out to federated peer repos (Pro
   *  tier). One row per workspace tool call that reached the federation path.
   *  `detail.peers` = peers that answered, `detail.partial` = ≥1 peer
   *  unreachable (result incomplete), `detail.refused` = true when the daemon
   *  refused on free tier (home-only). Drains through the existing C1 `events`
   *  behavior projection — no new drainer or event table. */
  | "cross_repo_access"
  // ── CROSS_REPO_INTELLIGENCE (Sprint 6.3) — dangling cross-repo reference ──
  /** A cross-repo drift sweep found ≥1 reference whose owning peer answered but
   *  no longer defines the moniker — the peer moved, renamed, or deleted the
   *  symbol the home repo still imports (Pro tier). One row per sweep that found
   *  drift. `detail.dangling` = count of dangling monikers, `detail.partial` =
   *  ≥1 peer unreachable (a defining peer may have been missed), `detail.findings`
   *  = capped sample of `{moniker, package, name, sites}`. Drains through the
   *  existing C1 `events` behavior projection — no new drainer or event table. */
  | "cross_repo_drift"
  // ── OWN_EDIT_TOOL — deterministic end-of-turn "files changed" receipt ──
  /** A `file_edit` (targeted edit or whole-file write) applied successfully.
   *  One row per successful edit. `detail.file_path` = repo-relative path,
   *  `detail.added` / `detail.removed` = line counts, `detail.ranges` = the
   *  changed line ranges in the resulting file, `detail.mode` =
   *  edit|create|overwrite. The receipt renderer lists every file edited this
   *  turn with its line numbers — host-emitted, so it never depends on the
   *  model echoing the change in its reply. Carries no token-savings claim, so
   *  `eventBucket` returns null (excluded from the Prevented/Remembered/Saved
   *  recap); it renders in its own dedicated receipt section. */
  | "code_edit_applied"
  // ── Lever C (TOKEN_ECONOMICS §11.2) — internal model delegation ──────
  /** A delegable single-entity task was routed to the cheaper model
   *  (tests, docstrings, mechanical refactors, lint/format). One row per
   *  delegation. `detail.class` = the delegable class, `detail.model` = the
   *  junior model, `detail.escalated` = true when the senior had to take the
   *  task back. Carries no token-savings claim — aggregated at write (no
   *  per-developer rows), so `eventBucket` returns null. */
  | "delegated_edit"
  /** A delegable many-site sweep was routed to the cheaper model. Same detail
   *  shape as `delegated_edit`; distinguished so a sweep (which pays the
   *  junior per-site cost) is counted apart from a single-entity edit. */
  | "delegated_sweep"
  /** Consolidated savings-activation event (Issue 8). The specific lever is in
   *  `detail.kind` (e.g. `bulk_edit_oneshot`, `search_code_context_inlined`,
   *  `delegated_to_junior`, `grep_redirected_to_search_code`,
   *  `code_grep_unredirected`) and `detail.category` is one of
   *  savings|prevention|routing|leak. One type so new levers add a `kind`, not a
   *  new behavior_event type / table / drainer. See `tracking/savings-events.ts`. */
  | "savings_event";

export interface BehaviorEvent {
  /** Monotonic counter per-process. */
  id: number;
  /** ISO timestamp. */
  ts: string;
  /** Session ID (from ShadowLedger or UNERR_SESSION_ID env). */
  session_id: string;
  /** The agent's OWN conversation id (Claude `session_id`, Cursor
   *  `conversation_id`), when the agent exposed it; null otherwise. The PRIMARY
   *  grouping key — `coalesce(native_session_id, session_id)` names a
   *  conversation across reconnects and the proxy/hook process split. */
  native_session_id?: string | null;
  /** The agent's tool_use id correlating this event to one assistant tool call.
   *  Only the hook path carries it; null on proxy-dispatched rows. */
  tool_use_id?: string | null;
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
    native_session_id: r.native_session_id ?? null,
    tool_use_id: r.tool_use_id ?? null,
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
  /** mtime-memoized native-id lookup — see TokenFlowWriter. */
  private readonly nativeResolver: NativeSessionResolver;

  constructor(
    unerrDir: string,
    sessionId: string,
    options: BehaviorEventWriterOptions = {}
  ) {
    this.sessionId = sessionId;
    this.unerrDir = unerrDir;
    this.agent = options.agent ?? "unknown";
    this.turnProvider = options.turnProvider ?? (() => 0);
    this.nativeResolver = new NativeSessionResolver(unerrDir);
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
    // Honour an explicit native id (the proxy passes the registry-resolved
    // value); otherwise resolve it by agent so router-internal rows group with
    // the conversation. See TokenFlowWriter.record for the rationale.
    const nativeSessionId =
      input.native_session_id !== undefined
        ? input.native_session_id
        : (this.nativeResolver.resolve(agent)?.nativeSessionId ?? null);

    try {
      rowId = openMetricsStore(this.unerrDir).insertBehaviorEvent({
        ts: now.getTime(),
        ts_iso: tsIso,
        session_id: input.session_id,
        native_session_id: nativeSessionId,
        tool_use_id: input.tool_use_id ?? null,
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
