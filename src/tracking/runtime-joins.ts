/**
 * Fix L — cross-tier correlation joins.
 *
 * Pure projection that walks the per-turn `behavior_events` stream and
 * counts the joins point tools cannot produce — memory↔graph, graph↔drift,
 * and three-way (memory+graph+drift on the same entity). Consumed by both
 * `renderTurnFooter` (server-side, every tool response) and
 * `handleTurnSummaryProxy` (agent-pasted Surface 3 line at end of turn).
 *
 * The math is intentionally trivial — the value of this code is NOT the
 * algorithm, it's the *positioning artefact*: every emission of a non-zero
 * join is a user-facing receipt that something other than the model itself
 * joined session memory to live code structure. Point tools (Mem0, RTK,
 * Langfuse, Sourcegraph, claude-mem, CodeGraphContext) cannot output this
 * line because their data planes don't overlap.
 *
 * The join key is `entity_key` — every event type that participates
 * (`fact_recalled`, `graph_query_served`, drift_consumed`) populates it
 * when the event is anchored to a specific file or entity.
 */

import type { NamedEvent } from "./named-events.js";

export interface RuntimeJoinCounts {
  /** Entities for which we recalled a memory fact AND served a graph
   *  query in the same turn. */
  memory_to_graph: number;
  /** Entities for which we served a graph query AND consumed a drift
   *  signal in the same turn. */
  graph_to_drift: number;
  /** Entities for which all three (memory recall + graph query + drift
   *  consumption) co-occurred in the same turn. */
  three_way: number;
  /** Per-entity participation — exposed for the dashboard drill view so
   *  the user can see which files were the join's subjects. */
  entities: string[];
}

const MEMORY_EVENT_TYPES = new Set<string>([
  "fact_recalled",
  // fact_stored_user_fed implies the user just taught a fact that will
  // be recalled by a future turn — counts as memory participation.
  "fact_stored_user_fed",
]);

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

  const memoryEntities = new Set<string>();
  const graphEntities = new Set<string>();
  const driftEntities = new Set<string>();

  for (const ev of scoped) {
    const key = ev.entity_key ?? ev.file_path ?? null;
    if (!key) continue;
    if (MEMORY_EVENT_TYPES.has(ev.event_type)) memoryEntities.add(key);
    if (GRAPH_EVENT_TYPES.has(ev.event_type)) graphEntities.add(key);
    if (DRIFT_EVENT_TYPES.has(ev.event_type)) driftEntities.add(key);
  }

  const allEntities = new Set<string>([
    ...memoryEntities,
    ...graphEntities,
    ...driftEntities,
  ]);

  let memoryToGraph = 0;
  let graphToDrift = 0;
  let threeWay = 0;
  for (const key of allEntities) {
    const inMem = memoryEntities.has(key);
    const inGraph = graphEntities.has(key);
    const inDrift = driftEntities.has(key);
    if (inMem && inGraph) memoryToGraph += 1;
    if (inGraph && inDrift) graphToDrift += 1;
    if (inMem && inGraph && inDrift) threeWay += 1;
  }

  return {
    memory_to_graph: memoryToGraph,
    graph_to_drift: graphToDrift,
    three_way: threeWay,
    entities: [...allEntities].sort(),
  };
}

/** Render the user-facing `⚡ unerr runtime: …` segment. Returns the
 *  empty string when every count is zero — callers should treat the
 *  empty return as "elide this segment from the surrounding line."
 *
 *  Each segment is optional and elided when its count is zero, so a
 *  partial-join turn still produces a coherent line. The `⚡` glyph is
 *  the third visual register (distinct from `ur|<tag>` agent-facing
 *  signals and `unerr »` user-prose telemetry). */
export function renderRuntimeJoinSegment(counts: RuntimeJoinCounts): string {
  const parts: string[] = [];
  if (counts.memory_to_graph > 0) {
    const n = counts.memory_to_graph;
    parts.push(
      `${n} memory ${n === 1 ? "fact" : "facts"} joined to ${n} live graph ${n === 1 ? "node" : "nodes"}`
    );
  }
  if (counts.graph_to_drift > 0) {
    const n = counts.graph_to_drift;
    parts.push(
      `${n} drift ${n === 1 ? "conflict" : "conflicts"} resolved against graph`
    );
  }
  if (counts.three_way > 0) {
    const n = counts.three_way;
    parts.push(
      `${n} three-way ${n === 1 ? "correlation" : "correlations"} confirmed`
    );
  }
  if (parts.length === 0) return "";
  return `⚡ unerr runtime: ${parts.join(" | ")}`;
}
