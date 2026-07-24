/**
 * Trace recall — TF-IDF symptom retrieval over the timeline journal.
 *
 * Serves `ur|fct past incident` injection: past blocker→resolution
 * trajectories ranked against the prompt's tokens. Traces are journal
 * entries (dated, past-tense); the anchor-existence gate below is the
 * staleness guard — an incident whose anchor no longer resolves in this
 * repo's graph is history about deleted code and is not injected.
 *
 * Moved out of the temporal-fact store during the active-memory strip:
 * recall reads only the timeline store, never facts.db.
 */

import type { CozoTimelineStore, TraceRow } from "./timeline-store.js";

/** Weak matches below this accumulated TF-IDF score are dropped. */
const RELEVANCE_FLOOR = 0.1;
/** Score boost when a prompt anchor hint overlaps a trace's anchor. */
const ANCHOR_BOOST = 0.5;

/**
 * Recall trajectory traces ranked by TF-IDF token overlap against the query
 * tokens, with an optional code-anchor boost when the prompt's target files or
 * entities match a trace's anchor field. Drops weak matches below a relevance
 * floor, then drops traces whose anchor definitively no longer exists (via
 * `anchorExists`) so stale incidents never reach the injection budget.
 * Anchor-less traces and checker errors pass through — recall fails open.
 */
export async function recallTracesBySymptom(
  timelineStore: CozoTimelineStore,
  tokens: string[],
  limit = 3,
  anchorHints?: string[],
  anchorExists?: (anchor: string) => Promise<boolean>
): Promise<TraceRow[]> {
  if (tokens.length === 0) return [];

  // IDF denominator: total trace count
  const N = await timelineStore.countTraces();
  if (N === 0) return [];

  // Per-token: look up matching trace IDs, compute idf, accumulate score.
  // score(d) = Σ_t idf(t)  for each query token t present in trace d.
  // idf(t)   = log((N+1) / (df(t)+1))  — Laplace smoothing avoids log(0).
  const scores = new Map<string, number>(); // trace_id → accumulated score
  for (const token of tokens) {
    const matchingIds = await timelineStore.getTracesForToken(token);
    if (matchingIds.length === 0) continue;
    const df = matchingIds.length;
    const idf = Math.log((N + 1) / (df + 1));
    for (const traceId of matchingIds) {
      scores.set(traceId, (scores.get(traceId) ?? 0) + idf);
    }
  }
  if (scores.size === 0) return [];

  // Fetch trace rows for all candidates in one batch
  const byId = await timelineStore.getTracesByIds([...scores.keys()]);

  const hintSet = new Set(anchorHints ?? []);

  const scored: Array<{ trace: TraceRow; score: number }> = [];
  for (const [traceId, baseScore] of scores) {
    if (baseScore < RELEVANCE_FLOOR) continue;
    const trace = byId.get(traceId);
    if (!trace) continue;
    let score = baseScore;
    // Boost when any prompt anchor hint overlaps the trace's anchor field
    if (hintSet.size > 0 && trace.anchor) {
      for (const hint of hintSet) {
        if (
          trace.anchor === hint ||
          trace.anchor.includes(hint) ||
          hint.includes(trace.anchor)
        ) {
          score += ANCHOR_BOOST;
          break;
        }
      }
    }
    scored.push({ trace, score });
  }

  // Descending by score, top-K
  scored.sort((a, b) => b.score - a.score);
  if (!anchorExists) return scored.slice(0, limit).map((s) => s.trace);

  // Staleness gate: walk the ranked list, keeping traces whose anchor still
  // resolves, until `limit` are kept. Bounded checks so a long candidate list
  // can't fan out point queries; a checker error keeps the trace (fail open —
  // a cold or rebuilding graph must never suppress recall).
  const kept: TraceRow[] = [];
  let checks = 0;
  const maxChecks = limit * 3;
  for (const { trace } of scored) {
    if (kept.length >= limit) break;
    if (trace.anchor) {
      if (checks >= maxChecks) break;
      checks += 1;
      let ok = true;
      try {
        ok = await anchorExists(trace.anchor);
      } catch {
        ok = true;
      }
      if (!ok) continue;
    }
    kept.push(trace);
  }
  return kept;
}
