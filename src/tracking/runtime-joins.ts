/**
 * Fix L — cross-tier correlation joins.
 *
 * Pure projection that walks the per-turn `behavior_events` stream and
 * counts the join point tools cannot produce — graph↔drift (a graph query
 * and a drift signal landing on the same entity in the same turn).
 * Consumed by `gatherReceiptInputs` (turn-report.ts) for the receipt block.
 *
 * The math is intentionally trivial — the value of this code is NOT the
 * algorithm, it's the *positioning artefact*: every emission of a non-zero
 * join is a user-facing receipt that something other than the model itself
 * correlated live code structure with drift. Point tools (Mem0, RTK,
 * Langfuse, Sourcegraph, claude-mem, CodeGraphContext) cannot output this
 * line because their data planes don't overlap.
 *
 * The join key is `entity_key` — every event type that participates
 * (`graph_query_served`, `drift_consumed`) populates it when the event is
 * anchored to a specific file or entity.
 */

import type { NamedEvent } from "./named-events.js";

export interface RuntimeJoinCounts {
  /** Entities for which we served a graph query AND consumed a drift
   *  signal in the same turn. */
  graph_to_drift: number;
  /** Per-entity participation — exposed for the dashboard drill view so
   *  the user can see which files were the join's subjects. */
  entities: string[];
}

const GRAPH_EVENT_TYPES = new Set<string>([
  "graph_query_served",
  "full_read_avoided",
  // caller_check_enforced is a graph-derived pre-edit signal.
  "caller_check_enforced",
]);

const DRIFT_EVENT_TYPES = new Set<string>([
  "drift_consumed",
  "stale_edit_prevented",
  "cascade_warning_consumed",
]);

/**
 * Compute the cross-tier join counts for one `{session_id, turn}` pair.
 *
 * Pure — no IO, no side effects. Safe to call on every tool response
 * (microseconds for typical turn-sized event lists).
 */
export function computeRuntimeJoins(
  events: readonly NamedEvent[],
  sessionId: string,
  turn: number
): RuntimeJoinCounts {
  const scoped = events.filter(
    (e) => e.session_id === sessionId && e.turn === turn
  );

  const graphEntities = new Set<string>();
  const driftEntities = new Set<string>();

  for (const ev of scoped) {
    const key = ev.entity_key ?? ev.file_path ?? null;
    if (!key) continue;
    if (GRAPH_EVENT_TYPES.has(ev.event_type)) graphEntities.add(key);
    if (DRIFT_EVENT_TYPES.has(ev.event_type)) driftEntities.add(key);
  }

  const allEntities = new Set<string>([...graphEntities, ...driftEntities]);

  let graphToDrift = 0;
  for (const key of allEntities) {
    if (graphEntities.has(key) && driftEntities.has(key)) graphToDrift += 1;
  }

  return {
    graph_to_drift: graphToDrift,
    entities: [...allEntities].sort(),
  };
}

/** Render the user-facing `⚡ unerr runtime: …` segment. Returns the
 *  empty string when the count is zero — callers should treat the empty
 *  return as "elide this segment from the surrounding line." The `⚡`
 *  glyph is the third visual register (distinct from `ur|<tag>`
 *  agent-facing signals and `unerr »` user-prose telemetry). */
export function renderRuntimeJoinSegment(counts: RuntimeJoinCounts): string {
  if (counts.graph_to_drift <= 0) return "";
  const n = counts.graph_to_drift;
  return `⚡ unerr runtime: ${n} drift ${n === 1 ? "conflict" : "conflicts"} resolved against graph`;
}
