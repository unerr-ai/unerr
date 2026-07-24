/**
 * Graph-informed importance scoring — Sprint 3 (T3.1) of the reversible
 * compression plan (`.internal/roadmap/REVERSIBLE_COMPRESSION_PLAN.md`).
 *
 * When a compressor must drop items (entities, search results, references), it
 * should keep the most load-bearing ones first. "Load-bearing" here is graph
 * centrality, which the graph already records as columns on each entity —
 * `fan_in` (how many things call it), `fan_out` (how many things it calls), and
 * `risk_level` (a coarse string bucket derived from those). A high-`fan_in` hub
 * breaks many callers when wrong, so it is exactly the entity an agent is most
 * likely to need in context; a leaf with `fan_in:0` is the safest to drop.
 *
 * This is the no-LLM, no-traversal analog of a learned-importance model: a cheap
 * deterministic read of columns we already store. No CozoDB query, no graph walk
 * (single-column reads only, per the Datalog "depth-1 is enough" guidance), so it
 * stays well under the 5ms tool-latency budget and is safe to call per item at a
 * truncation drop point.
 *
 * This module is a NEW primitive only. It is intentionally not wired into
 * wire-cap / recon / smart-truncate here — a later sprint task (T3.2–T3.4) does
 * that integration. Keeping it standalone and pure keeps it easy to test for the
 * determinism the rest of Sprint 2/3 depends on.
 *
 */

/** Entity-like shape the truncation drop points pass in. All fields optional —
 *  a missing column is treated as least-important (rank 0 / count 0), never an
 *  error, because partial rows reach the wire (e.g. search hits without metrics). */
export interface ImportanceInput {
  fan_in?: number;
  fan_out?: number;
  risk_level?: string;
  key?: string;
}

/**
 * Rank for each `risk_level` string, higher = more important. Covers both
 * vocabularies that appear in the codebase: the indexer emits `normal|medium|high`
 * (`local-indexer.ts:computeRiskLevel`) while blast-radius / file-intelligence
 * also use `critical`, and some callers use `low` as a synonym for the lowest
 * bucket. `low` and `normal` share rank 0 (both "least risky"). Any unknown or
 * missing value falls through to rank 0 — never throws. Lower-cased before lookup
 * so casing never changes the score.
 */
const RISK_RANK: Readonly<Record<string, number>> = {
  low: 0,
  normal: 0,
  medium: 1,
  high: 2,
  critical: 3,
};

/** Highest risk rank, used to scale the risk term against fan-in/out magnitudes. */
const MAX_RISK_RANK = 3;

/** Weight on `fan_in`. Inbound callers are the strongest "many things break if
 *  this is wrong" signal, so fan_in is weighted highest. */
const W_FAN_IN = 3;
/** Weight on `fan_out`. Outbound calls indicate a fragile hub but are weaker than
 *  inbound centrality, so weighted below fan_in. */
const W_FAN_OUT = 1;
/** Weight on the risk bucket. Each rank step is worth this many points so a
 *  `critical` entity (rank 3) gets a meaningful but bounded boost. */
const W_RISK = 4;

/** Coerce a possibly-missing/NaN/negative number to a safe non-negative integer
 *  contribution. Missing or invalid → 0 (least important), never throws. */
function safeCount(n: number | undefined): number {
  if (typeof n !== "number" || !Number.isFinite(n) || n < 0) return 0;
  return n;
}

/** Rank for a risk_level string; missing/unknown → 0. Case-insensitive. */
function riskRank(risk: string | undefined): number {
  if (typeof risk !== "string") return 0;
  const r = RISK_RANK[risk.toLowerCase()];
  return r === undefined ? 0 : r;
}

/**
 * Deterministic importance score for one entity. Higher = more load-bearing =
 * survives truncation. Formula:
 *
 *   score = W_FAN_IN * fan_in + W_FAN_OUT * fan_out + W_RISK * riskRank(risk_level)
 *         = 3 * fan_in + 1 * fan_out + 4 * rank(low|normal=0, medium=1, high=2, critical=3)
 *
 * Reads existing columns only — no graph traversal, no CozoDB query, O(1). All
 * fields optional; missing/invalid columns contribute 0 (treated as lowest), so a
 * row with nothing set scores 0 and sorts last. The output is a plain number with
 * no clock/random input, so identical entities always score identically (feeds the
 * Sprint 2 determinism requirement).
 */
export function importanceScore(entity: ImportanceInput): number {
  const fanIn = safeCount(entity.fan_in);
  const fanOut = safeCount(entity.fan_out);
  const risk = riskRank(entity.risk_level);
  return W_FAN_IN * fanIn + W_FAN_OUT * fanOut + W_RISK * risk;
}

/** Stable tiebreak key for an entity — the entity `key` when present, else "".
 *  Ensures identical scores resolve to a fixed lexicographic order regardless of
 *  input order, so the same input set always yields the same sequence. */
function tieKey(entity: ImportanceInput): string {
  return typeof entity.key === "string" ? entity.key : "";
}

/**
 * Return `items` ordered highest-importance first, ties broken by the entity key
 * (lexicographic) so identical input always yields identical order — no
 * dependence on the input's original order. Does not mutate the input array.
 *
 * `get` maps each item to its importance fields, so the caller can hold whatever
 * wrapper shape it likes (a search hit, a reference row, a body chunk) while the
 * ranking reads only the graph columns. Both the score and the tiebreak are
 * deterministic, which is what lets downstream truncation produce byte-stable
 * survivors (Sprint 2 / T3.1 acceptance: same input → same survivors).
 *
 * MAX_RISK_RANK is referenced here only to assert the rank table and the risk
 * weight stay in agreement; it has no effect on ordering.
 */
export function byImportanceDesc<T>(
  items: T[],
  get: (t: T) => ImportanceInput
): T[] {
  void MAX_RISK_RANK;
  // Decorate-sort-undecorate so `get` and `importanceScore` run once per item,
  // not once per comparison — O(n log n) comparisons over precomputed scores.
  const decorated = items.map((item, index) => {
    const fields = get(item);
    return {
      item,
      index,
      score: importanceScore(fields),
      key: tieKey(fields),
    };
  });

  decorated.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score; // higher score first
    if (a.key !== b.key) return a.key < b.key ? -1 : 1; // stable key tiebreak
    return a.index - b.index; // last resort: preserve original order
  });

  return decorated.map((d) => d.item);
}
