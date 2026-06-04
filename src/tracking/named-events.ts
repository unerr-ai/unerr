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
  type BehaviorEventType,
  readBehaviorEvents,
} from "./behavior-events.js";
import { openMetricsStore } from "./metrics-store.js";
import { readTokenFlowEvents } from "./token-flow.js";

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
  /** Turn index within the session (1-indexed; 0 for non-turn events). */
  turn: number;
  /** ISO timestamp. */
  ts: string;
  /** Event-specific extras (response bytes, tokens saved, mechanism,
   *  drill-down detail). JSON-serializable. */
  metadata: Record<string, unknown>;
}

/** Narrowing filter for `readNamedEvents`. All fields optional. */
export interface NamedEventFilter {
  session_id?: string;
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

const PHRASING: Record<string, PhrasingRow> = {
  // Existing BehaviorEventType entries — plain-English, low-token nouns.
  // The renderer composes them as "N <object>" / "N <plural>", so every
  // phrase here must read naturally in that frame.
  graph_query_served: {
    verb: "served",
    object: "code lookup",
    plural: "code lookups",
  },
  full_read_avoided: {
    verb: "kept compact",
    object: "compact file read",
    plural: "compact file reads",
  },
  loop_broken: {
    verb: "broke",
    object: "repeated mistake",
    plural: "repeated mistakes",
  },
  cascade_guard: {
    verb: "guarded",
    object: "risky cascading edit",
    plural: "risky cascading edits",
  },
  drift_consumed: {
    verb: "applied",
    object: "stale-code warning",
    plural: "stale-code warnings",
  },
  intervention_halted: {
    verb: "blocked",
    object: "blocked tool call",
    plural: "blocked tool calls",
  },
  intervention_warned: {
    verb: "warned about",
    object: "warned tool call",
    plural: "warned tool calls",
  },
  defuddle_selector_skipped: {
    verb: "fell back to",
    object: "web-parser fallback",
    plural: "web-parser fallbacks",
  },

  // Phase 1 additions
  caller_check_enforced: {
    verb: "checked",
    object: "pre-edit caller check",
    plural: "pre-edit caller checks",
  },
  stale_edit_prevented: {
    verb: "caught",
    object: "stale code edit",
    plural: "stale code edits",
  },
  fact_recalled: {
    verb: "loaded",
    object: "remembered note",
    plural: "remembered notes",
  },
  convention_applied: {
    verb: "applied",
    object: "project convention",
    plural: "project conventions",
  },
  cache_hit: {
    verb: "served",
    object: "cached answer",
    plural: "cached answers",
  },
  cross_session_resume: {
    verb: "resumed",
    object: "earlier session",
    plural: "earlier sessions",
  },
  fact_stored_user_fed: {
    verb: "saved",
    object: "note from you",
    plural: "notes from you",
  },
  fact_stored_auto: {
    verb: "saved",
    object: "noticed pattern",
    plural: "noticed patterns",
  },
  cascade_warning_consumed: {
    verb: "applied",
    object: "cascading-edit warning",
    plural: "cascading-edit warnings",
  },

  // Phase 2 additions
  fact_capture_abandoned: {
    verb: "skipped",
    object: "unclear note",
    plural: "unclear notes",
  },
  confirmation_expired: {
    verb: "let expire",
    object: "unanswered question",
    plural: "unanswered questions",
  },

  // Phase 3 additions
  presence_ambient_marker: {
    verb: "showed",
    object: "quiet-mode notice",
    plural: "quiet-mode notices",
  },

  // Fix K — resume strip carried over open blockers.
  resume_blockers_surfaced: {
    verb: "resumed",
    object: "open blocker",
    plural: "open blockers",
  },

  // Reviewer — in-flight post-edit review findings.
  review_finding_surfaced: {
    verb: "flagged",
    object: "review finding",
    plural: "review findings",
  },
};

/** Phrasing for `tokenflow.<mechanism>` synthetic event types. Mirrors
 *  `TokenFlowMechanism` literals from `token-flow.ts`. */
const TOKEN_FLOW_PHRASING: Record<string, PhrasingRow> = {
  graph_query: {
    verb: "served",
    object: "code lookup",
    plural: "code lookups",
  },
  session_dedup: {
    verb: "skipped",
    object: "duplicate context",
    plural: "duplicate contexts",
  },
  shell_compression: {
    verb: "trimmed",
    object: "trimmed shell output",
    plural: "trimmed shell outputs",
  },
  format_encoding: {
    verb: "compacted",
    object: "compact reply",
    plural: "compact replies",
  },
  smart_truncation: {
    verb: "trimmed",
    object: "trimmed boilerplate",
    plural: "trimmed boilerplate",
  },
  file_read: {
    verb: "trimmed",
    object: "trimmed file read",
    plural: "trimmed file reads",
  },
  fetch_url: {
    verb: "cached",
    object: "cached web page",
    plural: "cached web pages",
  },
  behavior_automation: {
    verb: "automated",
    object: "automated step",
    plural: "automated steps",
  },
  persistent_memory: {
    verb: "recalled",
    object: "recalled note",
    plural: "recalled notes",
  },
};

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
 */
export function readNamedEvents(
  unerrDir: string,
  filter: NamedEventFilter = {}
): NamedEvent[] {
  const agentOf = buildAgentResolver(unerrDir);
  const out: NamedEvent[] = [];

  // Behavior events → 1:1 mapping
  const behaviorRows = readBehaviorEvents(unerrDir, {
    session_id: filter.session_id,
    type: filter.event_type as BehaviorEventType | undefined,
    from_ts: filter.from_ts,
    to_ts: filter.to_ts,
  });

  for (const ev of behaviorRows) {
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
      turn: ev.turn,
      ts: ev.ts,
      metadata,
    });
  }

  // Token flow events → synthetic `tokenflow.<mechanism>` event_type
  const tokenFlowRows = readTokenFlowEvents(unerrDir, {
    session_id: filter.session_id,
    from_ts: filter.from_ts,
    to_ts: filter.to_ts,
  });

  for (const ev of tokenFlowRows) {
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
