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
  /** `ur|dft` signal was consumed (agent re-read after a drift signal). */
  | "drift_consumed"
  /** A behavior halted a tool call before it ran (pre-tool-use hook). */
  | "intervention_halted"
  /** A behavior emitted a warning that did not halt the call. */
  | "intervention_warned"
  /** Defuddle (fetch_url extractor) threw a non-fatal selector-parse
   *  error that was suppressed from logs. First occurrence per signature
   *  prints one summary line; subsequent ones bump this counter only. */
  | "defuddle_selector_skipped";

export interface BehaviorEvent {
  /** Monotonic counter per-process. */
  id: number;
  /** ISO timestamp. */
  ts: string;
  /** Session ID (from ShadowLedger or UNERR_SESSION_ID env). */
  session_id: string;
  /** Process ID that produced this event. */
  pid: number;
  /** Turn number within session (1-indexed; 0 for exec processes). */
  turn: number;
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

export type BehaviorEventInput = Omit<BehaviorEvent, "id" | "ts" | "pid">;

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
    type: r.type as BehaviorEventType,
    tool: r.tool ?? null,
    entity_key: r.entity_key ?? null,
    response_bytes: r.response_bytes ?? null,
    detail,
  };
}

export type BehaviorEventSink = (event: BehaviorEvent) => void;

export class BehaviorEventWriter {
  readonly sessionId: string;
  private readonly unerrDir: string;
  private sessionEvents: BehaviorEvent[] = [];
  private sinks: BehaviorEventSink[] = [];

  constructor(unerrDir: string, sessionId: string) {
    this.sessionId = sessionId;
    this.unerrDir = unerrDir;
    openMetricsStore(unerrDir);
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

    try {
      rowId = openMetricsStore(this.unerrDir).insertBehaviorEvent({
        ts: now.getTime(),
        ts_iso: tsIso,
        session_id: input.session_id,
        pid: process.pid,
        turn: input.turn,
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
      ...input,
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
