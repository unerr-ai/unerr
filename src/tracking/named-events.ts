/**
 * Named Events — read projection over existing event tables.
 *
 * Phase 1 of the four-surface presence model. This module is purely
 * additive and read-only: it does NOT introduce a new table, does NOT
 * modify any existing column, and does NOT reroute any existing emitter.
 * It reads `behavior_events` and `token_flow_events` rows (which the
 * existing dashboard, Token Trace, and reasoning-quality routes continue
 * to read unchanged) and projects them into a uniform "named event"
 * shape that the four-surface system (preface, footer, attribution,
 * dashboard logbook) drives off.
 *
 * Verb + object + agent + file_path are derived per row from the
 * underlying event type and detail. The projection is deterministic and
 * pure; given an identical set of input rows, two callers get the same
 * NamedEvent list.
 *
 * Agent name is resolved by joining against `session_history.agent_name`
 * (cached for the call's lifetime in a session_id → agent_name map).
 * When a session has no history row yet, `agent` is "unknown".
 *
 * See: .internal/PERCEPTION_TO_PRESENCE.md §9.1 (story paragraph
 * inputs), §12 Sprint 1 (this module's contract).
 */

import {
  type CatalogedEventKey,
  EVENT_CATALOG,
  type EventCatalogEntry,
} from "@unerr-ai/contracts/events";
import {
  type BehaviorEventType,
  readBehaviorEvents,
} from "./behavior-events.js";
import { openMetricsStore } from "./metrics-store.js";
import type { SavingsEventKind } from "./savings-events.js";
import { type TokenFlowMechanism, readTokenFlowEvents } from "./token-flow.js";

// ── Compile-time drift guards ─────────────────────────────────────────────
//
// Each assertion fails with a tsc error if a union member is added to a source
// type without a corresponding entry in EVENT_CATALOG.
//
// Pattern: `Exclude<Union, CatalogedEventKey> extends never ? true : never`
// evaluates to `never` when any member of Union is absent from the catalog,
// making the `= true` assignment a type error.

/** @internal */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const _assertBehaviorCoverage: Exclude<
  BehaviorEventType,
  CatalogedEventKey
> extends never
  ? true
  : never = true;

/** @internal */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const _assertMechanismCoverage: Exclude<
  TokenFlowMechanism,
  CatalogedEventKey
> extends never
  ? true
  : never = true;

/** @internal */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const _assertSavingsCoverage: Exclude<
  SavingsEventKind,
  CatalogedEventKey
> extends never
  ? true
  : never = true;

/** Uniform shape consumed by every Surface 1–4 renderer. */
export interface NamedEvent {
  /** Verb-noun event type (matches `BehaviorEventType` where derived from
   *  a behavior_events row, or a `tokenflow.<mechanism>` synthetic key
   *  when derived from a token_flow_events row). */
  event_type: string;
  /** Past-tense verb describing what happened. */
  verb: string;
  /** Short noun phrase describing the object of the verb. */
  object: string;
  /** Agent that produced the event (e.g., "claude-code", "cursor").
   *  "unknown" when no session_history row resolves the agent. */
  agent: string;
  /** Most relevant file path the event applies to. Null when the event
   *  is not bound to a file (e.g., session-level cache_hit). */
  file_path: string | null;
  /** Underlying entity key if the event was entity-bound. Null otherwise. */
  entity_key: string | null;
  /** Session ID the event was emitted in. */
  session_id: string;
  /** The agent's OWN conversation id (Claude `session_id`, Cursor
   *  `conversation_id`), when the agent exposed it; null otherwise.
   *  Primary cross-process correlation key: `coalesce(native_session_id,
   *  session_id)` groups events across the proxy/hook process split. */
  native_session_id: string | null;
  /** Turn index within the session (1-indexed; 0 for non-turn events). */
  turn: number;
  /** ISO timestamp. */
  ts: string;
  /** Event-specific extras (response bytes, tokens saved, mechanism,
   *  drill-down detail). JSON-serializable. */
  metadata: Record<string, unknown>;
}

/** Narrowing filter for `readNamedEvents`. All fields optional.
 *
 * When `native_session_id` is provided it takes precedence over `session_id`
 * for the row-fetch: all rows whose `native_session_id` matches are returned
 * regardless of their `session_id`. This allows the receipt to correlate
 * proxy events (one session_id space) with hook events (another session_id
 * space) that share the same `native_session_id`. Falls back to `session_id`
 * when `native_session_id` is absent or null. */
export interface NamedEventFilter {
  session_id?: string;
  /** The agent's own conversation id. When set, rows are fetched by this
   *  key instead of `session_id`, enabling cross-process correlation. */
  native_session_id?: string;
  event_type?: string;
  agent?: string;
  file_path?: string;
  /** Inclusive lower bound on `ts` (ISO string). */
  from_ts?: string;
  /** Inclusive upper bound on `ts` (ISO string). */
  to_ts?: string;
}

// ── Derivation table ──────────────────────────────────────────────────
//
// Verb + object for each known event type. Kept as a single source of
// truth so the dashboard story template, footer summary, and surface
// coverage tests all agree on the human-readable phrasing.
//
// Adding a new event type:
//   1) Add the literal to `BehaviorEventType` (behavior-events.ts) if it
//      flows through that writer, or document the synthetic key here.
//   2) Add a row to this table.
//   3) That's it — no schema change, no writer change.

interface PhrasingRow {
  /** Past-tense verb. Single token preferred. */
  verb: string;
  /** Singular noun phrase shown to the user. Plain English, no jargon.
   *  Read literally — this string lands in `unerr » …` lines the user
   *  sees in their chat pane. ≤4 words preferred. */
  object: string;
  /** Plural form. Optional — when omitted, callers append "s" to
   *  `object`, which only works for single-noun phrases. Multi-word
   *  phrases (e.g. "stale code edit") MUST set this explicitly so the
   *  rendered count line reads naturally ("3 stale code edits", not
   *  "3 stale code edits"). */
  plural?: string;
}

// ── Derivation from EVENT_CATALOG ────────────────────────────────────────
//
// Both maps are built once at module load from the catalog. Adding a new
// display entry only requires a catalog row with surface:"display" and
// verb/object/plural set — no change here.
//
// Behaviour family → PHRASING (keyed by BehaviorEventType literal).
// Mechanism family → TOKEN_FLOW_PHRASING (keyed by TokenFlowMechanism literal).

// Cast to the declared interface type so the derived maps can read optional fields
// without fighting the literal-type inference that `satisfies` preserves.
const _catalog = EVENT_CATALOG as Record<string, EventCatalogEntry>;

const PHRASING: Record<string, PhrasingRow> = Object.fromEntries(
  Object.entries(_catalog)
    .filter(
      ([, e]) =>
        e.family === "behavior" && e.surface === "display" && e.verb != null
    )
    .map(([k, e]) => [
      k,
      { verb: e.verb!, object: e.object!, plural: e.plural },
    ])
);

/** Phrasing for `tokenflow.<mechanism>` synthetic event types. Mirrors
 *  `TokenFlowMechanism` literals from `token-flow.ts`. */
const TOKEN_FLOW_PHRASING: Record<string, PhrasingRow> = Object.fromEntries(
  Object.entries(_catalog)
    .filter(
      ([, e]) =>
        e.family === "mechanism" && e.surface === "display" && e.verb != null
    )
    .map(([k, e]) => [
      k,
      { verb: e.verb!, object: e.object!, plural: e.plural },
    ])
);

const DEFAULT_PHRASING: PhrasingRow = {
  verb: "recorded",
  object: "thing",
  plural: "things",
};

function phrasingFor(eventType: string): PhrasingRow {
  if (eventType.startsWith("tokenflow.")) {
    return (
      TOKEN_FLOW_PHRASING[eventType.slice("tokenflow.".length)] ??
      DEFAULT_PHRASING
    );
  }
  return PHRASING[eventType] ?? DEFAULT_PHRASING;
}

// ── Report buckets ────────────────────────────────────────────────────

/** The three user-facing value groups the close-out report sorts events
 *  into. `prevented` = a likely failure stopped or flagged before it landed
 *  (the lead group); `remembered` = knowledge recalled or stored; `saved` =
 *  tokens or context trimmed. */
export type ReportBucket = "prevented" | "remembered" | "saved";

/** event_type → bucket for non-tokenflow events. Events absent here carry no
 *  user-facing value (neutral/skipped markers such as fact_capture_abandoned,
 *  confirmation_expired, presence_ambient_marker, defuddle_selector_skipped)
 *  and are excluded from the report. */
const EVENT_BUCKET: Record<string, ReportBucket> = {
  // Prevented — a guardrail acted on a likely failure.
  cascade_guard: "prevented",
  stale_edit_prevented: "prevented",
  intervention_halted: "prevented",
  intervention_warned: "prevented",
  loop_broken: "prevented",
  loop_redirect: "prevented",
  caller_check_enforced: "prevented",
  review_finding_surfaced: "prevented",
  drift_consumed: "prevented",
  cascade_warning_consumed: "prevented",
  // Remembered — knowledge recalled or stored.
  fact_recalled: "remembered",
  fact_stored_user_fed: "remembered",
  fact_stored_auto: "remembered",
  convention_applied: "remembered",
  cross_session_resume: "remembered",
  resume_blockers_surfaced: "remembered",
  trace_captured: "remembered",
  trace_recalled: "remembered",
  // Saved — tokens/context trimmed or served cheaply.
  graph_query_served: "saved",
  full_read_avoided: "saved",
  cache_hit: "saved",
};

/** `tokenflow.<mechanism>` → bucket. persistent_memory is knowledge; the rest
 *  are token/context savings. */
const TOKEN_FLOW_BUCKET: Record<string, ReportBucket> = {
  graph_query: "saved",
  session_dedup: "saved",
  shell_compression: "saved",
  format_encoding: "saved",
  smart_truncation: "saved",
  file_read: "saved",
  fetch_url: "saved",
  behavior_automation: "saved",
  body_dedup: "saved",
  persistent_memory: "remembered",
};

/** The strict subset of `prevented` events that are hard stops — a change the
 *  agent was about to make that unerr halted/caught. Drives the "Stopped N
 *  changes before they broke" headline; softer protective events (warnings
 *  applied, caller checks, review flags) stay in the bucket count but never
 *  claim a change was stopped. */
const HARD_PREVENTION: ReadonlySet<string> = new Set([
  "cascade_guard",
  "stale_edit_prevented",
  "intervention_halted",
  "loop_broken",
]);

/** Classify an event_type into one of the three report buckets, or null when
 *  it carries no user-facing value. Handles the `tokenflow.<mechanism>`
 *  prefix the savings events use. */
export function eventBucket(eventType: string): ReportBucket | null {
  if (eventType.startsWith("tokenflow.")) {
    return TOKEN_FLOW_BUCKET[eventType.slice("tokenflow.".length)] ?? null;
  }
  return EVENT_BUCKET[eventType] ?? null;
}

/** True when an event_type is a hard stop — a change unerr halted before it
 *  landed (vs a softer warning/check). Used for the prevention headline verb. */
export function isHardPrevention(eventType: string): boolean {
  return HARD_PREVENTION.has(eventType);
}

// ── Agent resolver ────────────────────────────────────────────────────

/** Resolve session_id → agent_name for LEGACY rows that pre-date the
 *  per-event `agent` column. New rows carry `agent` directly and bypass
 *  this resolver. Falls back to the session_history join (set only when
 *  a session ended with tokens_saved > 0) and finally "unknown".
 *  Cached for the duration of a single `readNamedEvents` call. */
function buildAgentResolver(unerrDir: string): (sessionId: string) => string {
  const store = openMetricsStore(unerrDir);
  const cache = new Map<string, string>();
  let loaded = false;

  return (sessionId: string): string => {
    if (cache.has(sessionId)) return cache.get(sessionId) ?? "unknown";
    if (!loaded) {
      for (const row of store.allSessionHistory()) {
        if (row.agent_name) cache.set(row.session_id, row.agent_name);
      }
      loaded = true;
    }
    return cache.get(sessionId) ?? "unknown";
  };
}

// ── Derivation: file_path + entity_key from event payloads ───────────

/** Extract a file path from an event's `entity_key` + `detail` blob.
 *  Conventions:
 *   - `entity_key` shaped like `path/to/file.ts` (contains `/` or `.`)
 *     is treated as a file path.
 *   - `entity_key` shaped like a function/class name is left as entity.
 *   - `detail.file` / `detail.file_path` / `detail.path` override.
 */
function deriveFilePath(
  entityKey: string | null,
  detail: Record<string, unknown> | undefined
): string | null {
  const fromDetail =
    (detail?.file as string | undefined) ??
    (detail?.file_path as string | undefined) ??
    (detail?.path as string | undefined);
  if (typeof fromDetail === "string" && fromDetail.length > 0)
    return fromDetail;

  if (!entityKey) return null;
  // Heuristic: file paths contain a path separator or a known source extension.
  if (entityKey.includes("/")) return entityKey;
  if (
    /\.(ts|tsx|js|jsx|mjs|cjs|py|rs|go|java|rb|md|json|yaml|yml|toml)$/.test(
      entityKey
    )
  ) {
    return entityKey;
  }
  return null;
}

function deriveEntityKey(
  entityKey: string | null,
  filePath: string | null
): string | null {
  if (!entityKey) return null;
  if (entityKey === filePath) return null;
  return entityKey;
}

// ── Projection ────────────────────────────────────────────────────────

/**
 * Read all known events for `unerrDir`, narrowed by `filter`, and
 * project them into the `NamedEvent` shape.
 *
 * This function NEVER writes. It reads existing rows from the existing
 * `behavior_events` and `token_flow_events` tables and projects them.
 * The underlying tables and their writers are unaffected.
 *
 * When `filter.native_session_id` is set it takes precedence over
 * `filter.session_id` for the fetch: ALL rows whose `native_session_id`
 * matches are returned, regardless of which process-local `session_id`
 * wrote them. This is the key that correlates proxy-written edits with
 * hook-written prompt-boundary events that share a `native_session_id`
 * but differ in `session_id`. Falls back to `session_id`-keyed fetch
 * when `native_session_id` is absent (legacy/exec/CLI rows).
 */
export function readNamedEvents(
  unerrDir: string,
  filter: NamedEventFilter = {}
): NamedEvent[] {
  const agentOf = buildAgentResolver(unerrDir);
  const out: NamedEvent[] = [];

  // When filtering by native_session_id we must read all rows (different
  // session_ids can share the same native id) and post-filter. Otherwise
  // the cheaper session-keyed fetch is used.
  const nativeFilter = filter.native_session_id ?? null;

  // Behavior events → 1:1 mapping
  const behaviorRows = readBehaviorEvents(unerrDir, {
    // Omit session_id when filtering by native so we get all sessions.
    session_id: nativeFilter ? undefined : filter.session_id,
    type: filter.event_type as BehaviorEventType | undefined,
    from_ts: filter.from_ts,
    to_ts: filter.to_ts,
  });

  for (const ev of behaviorRows) {
    // Native-id post-filter: skip rows that don't match.
    if (nativeFilter && ev.native_session_id !== nativeFilter) continue;
    const phrasing = phrasingFor(ev.type);
    // Row-level agent is the source of truth (P1 added the column to
    // every event row); the session_history resolver is a legacy fallback
    // for rows persisted before the schema change.
    const agent =
      ev.agent && ev.agent !== "unknown" ? ev.agent : agentOf(ev.session_id);
    if (filter.agent && agent !== filter.agent) continue;

    const filePath = deriveFilePath(ev.entity_key, ev.detail);
    if (filter.file_path && filePath !== filter.file_path) continue;

    const metadata: Record<string, unknown> = { ...(ev.detail ?? {}) };
    if (ev.tool) metadata.tool = ev.tool;
    if (ev.response_bytes !== null) metadata.response_bytes = ev.response_bytes;

    out.push({
      event_type: ev.type,
      verb: phrasing.verb,
      object: phrasing.object,
      agent,
      file_path: filePath,
      entity_key: deriveEntityKey(ev.entity_key, filePath),
      session_id: ev.session_id,
      native_session_id: ev.native_session_id ?? null,
      turn: ev.turn,
      ts: ev.ts,
      metadata,
    });
  }

  // Token flow events → synthetic `tokenflow.<mechanism>` event_type
  const tokenFlowRows = readTokenFlowEvents(unerrDir, {
    // Same: omit session_id when filtering by native.
    session_id: nativeFilter ? undefined : filter.session_id,
    from_ts: filter.from_ts,
    to_ts: filter.to_ts,
  });

  for (const ev of tokenFlowRows) {
    // Native-id post-filter.
    if (nativeFilter && ev.native_session_id !== nativeFilter) continue;
    const eventType = `tokenflow.${ev.mechanism}`;
    if (filter.event_type && filter.event_type !== eventType) continue;
    const phrasing = phrasingFor(eventType);
    // Row-level agent first; resolver fallback for legacy rows.
    const agent =
      ev.agent && ev.agent !== "unknown" ? ev.agent : agentOf(ev.session_id);
    if (filter.agent && agent !== filter.agent) continue;

    const filePath = deriveFilePath(null, ev.detail);
    if (filter.file_path && filePath !== filter.file_path) continue;

    const metadata: Record<string, unknown> = {
      ...(ev.detail ?? {}),
      mechanism: ev.mechanism,
      tokens_without: ev.tokens_without,
      tokens_with: ev.tokens_with,
      tokens_saved: ev.tokens_saved,
    };
    if (ev.tool) metadata.tool = ev.tool;

    out.push({
      event_type: eventType,
      verb: phrasing.verb,
      object: phrasing.object,
      agent,
      file_path: filePath,
      entity_key: null,
      session_id: ev.session_id,
      native_session_id: ev.native_session_id ?? null,
      turn: ev.turn,
      ts: ev.ts,
      metadata,
    });
  }

  // Stable sort: ts asc, then session_id asc. The two source streams are
  // each ordered by id; merging them here yields a deterministic timeline.
  out.sort((a, b) => {
    if (a.ts !== b.ts) return a.ts < b.ts ? -1 : 1;
    return a.session_id < b.session_id ? -1 : 1;
  });

  return out;
}

// ── Conversational-turn windowing ────────────────────────────────────
//
// The `turn` column on each row is the TurnSegmenter index, which advances
// on a 20s idle gap between ledger entries — so one conversational turn
// (prompt → response) fragments into many segmenter-turns and any
// `e.turn === currentTurn` slice catches only the final sliver. The
// `user_prompt_received` boundary event (written by the UserPromptSubmit
// hook, keyed to the same proxy session_id) marks the real start of the
// current turn. Slice by it instead.

/**
 * Epoch-ms of the latest `user_prompt_received` boundary in this event
 * stream, or `null` when none was recorded (pre-hook sessions, or content
 * capture disabled — the boundary row is still written, so null only
 * happens when the hook never fired). The current conversational turn is
 * every event at `ts >= this boundary`.
 */
export function latestPromptBoundaryTs(
  events: readonly NamedEvent[]
): number | null {
  let maxTs: number | null = null;
  for (const e of events) {
    if (e.event_type !== "user_prompt_received") continue;
    const t = Date.parse(e.ts);
    if (Number.isNaN(t)) continue;
    if (maxTs === null || t > maxTs) maxTs = t;
  }
  return maxTs;
}

/**
 * Build the single predicate that decides whether an event — a NamedEvent OR
 * a raw token_flow row, anything carrying an ISO `ts` and a segmenter `turn` —
 * belongs to the CURRENT conversational turn.
 *
 * This is the ONE definition of the turn window. The end-of-turn receipt
 * derives three things that MUST describe the identical window or the receipt
 * contradicts itself: the headline token number (token_flow rows summed in
 * `renderSessionEconomyLineLive`), the concrete bullets (`currentTurnSlice`),
 * and the attribution rows (`extractReceiptAttribution`). All three call this
 * factory so the boundary rule can never drift between them.
 *
 * Prefers the prompt boundary (accurate); falls back to the segmenter
 * `turn === fallbackTurn` match when no boundary was recorded (pre-hook
 * sessions, or the hook never fired) so old data still renders a non-empty
 * slice.
 */
export function makeInCurrentTurn(
  events: readonly NamedEvent[],
  fallbackTurn: number
): (ts: string, turn: number) => boolean {
  const boundary = latestPromptBoundaryTs(events);
  if (boundary === null) {
    return (_ts, turn) => turn === fallbackTurn;
  }
  return (ts, _turn) => Date.parse(ts) >= boundary;
}

/**
 * Slice `events` to the current conversational turn via {@link makeInCurrentTurn}.
 */
export function currentTurnSlice(
  events: readonly NamedEvent[],
  fallbackTurn: number
): NamedEvent[] {
  const inTurn = makeInCurrentTurn(events, fallbackTurn);
  return events.filter((e) => inTurn(e.ts, e.turn));
}

// ── Counts ────────────────────────────────────────────────────────────

/** Count NamedEvents by event_type. Convenience for story-template
 *  rendering (Sprint 9) and footer summary (Sprint 3). */
export function countNamedEventsByType(
  events: NamedEvent[]
): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const e of events) {
    counts[e.event_type] = (counts[e.event_type] ?? 0) + 1;
  }
  return counts;
}

/** Total events in the projection. */
export function totalNamedEvents(events: NamedEvent[]): number {
  return events.length;
}

// ── Verb / object lookup (for renderers that don't have the row) ─────

/** Public accessor for the phrasing table — used by renderers that
 *  receive event_type strings without the full row. The returned
 *  `plural` is always present (falls back to `object + "s"` when the
 *  row did not declare an explicit plural) so callers can render
 *  count-prefixed phrases without a branch. */
export function getPhrasing(eventType: string): {
  verb: string;
  object: string;
  plural: string;
} {
  const row = phrasingFor(eventType);
  return {
    verb: row.verb,
    object: row.object,
    plural: row.plural ?? `${row.object}s`,
  };
}
