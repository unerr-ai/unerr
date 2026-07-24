/**
 * Reusable, query-aware chunk ranker (Sprint 7, T7.1 + T7.2).
 *
 * The no-LLM analog of task-conditioned tool-output pruning: given a set of
 * chunks (whole functions / entities / log segments — never token-level) and
 * the current task string, score each chunk by lexical overlap with the query
 * (Okapi BM25) plus an OPTIONAL graph-proximity term, and return the chunk
 * indices ordered most-relevant first.
 *
 * BM25 math is reimplemented here (Okapi BM25, k1/b) rather than imported from
 * `src/tools/web/bm25-rank.ts` — that module is async (lazy-loads
 * `wink-bm25-text-search`) and web-passage specific. This one is synchronous,
 * dependency-free, and deterministic so a compressor can call it on the hot
 * path under the <5ms budget.
 *
 * Determinism contract: identical (chunks, query, proximity outputs) always
 * yield identical ordering. Ties (equal score) break by original chunk index,
 * never by Map/Set iteration order. No clock, no random, no model.
 *
 */

/** A unit of content to rank. Granularity is the caller's (whole function /
 * entity / log block) — this module never splits below chunk level. */
export interface RankableChunk {
  /** The chunk's verbatim text, scored lexically against the query. */
  text: string;
  /** Optional graph key, passed to the proximity fn for the structural term. */
  entityKey?: string;
}

/** One ranked result: the chunk's original index and its combined score. */
export interface RankedChunk {
  /** Index into the input `chunks` array (stable identity for the caller). */
  index: number;
  /** Combined BM25 + graph-proximity score (higher = more relevant). */
  score: number;
}

export interface RankChunksOptions {
  /**
   * Optional structural-relevance term. Given a chunk's `entityKey`, return a
   * proximity score in [0, 1] (1 = closest to the query-named entities). When
   * absent, ranking is BM25-only. A chunk without an `entityKey` contributes 0
   * from this term even when the fn is supplied.
   */
  graphProximity?: (entityKey: string) => number;
}

// Okapi BM25 parameters — field-standard defaults.
const BM25_K1 = 1.5;
const BM25_B = 0.75;

// Weight on the graph-proximity term when combining with BM25. BM25 leads
// (lexical match is the primary signal); proximity is an additive structural
// boost so a structurally-near chunk outranks a structurally-far one of equal
// lexical score, without swamping a strong lexical match.
const PROXIMITY_WEIGHT = 1.0;

/**
 * Above this combined-text length we skip ranking and return original order,
 * so a single huge payload can't blow the <5ms budget. Mirrors the
 * token-estimator's LARGE_INPUT_CHARS cutoff.
 */
const LARGE_INPUT_CHARS = 50_000;

const STOPWORDS = new Set([
  "a",
  "an",
  "the",
  "is",
  "are",
  "was",
  "were",
  "be",
  "been",
  "being",
  "of",
  "and",
  "or",
  "but",
  "in",
  "on",
  "at",
  "to",
  "for",
  "with",
  "by",
  "from",
  "up",
  "down",
  "out",
  "off",
  "over",
  "under",
  "as",
  "this",
  "that",
  "these",
  "those",
  "it",
  "its",
  "into",
  "if",
  "then",
  "do",
  "does",
  "did",
]);

/**
 * Split text into lowercased, stopword-filtered terms. Matches the tokenizer
 * shape in `bm25-rank.ts` so lexical behavior is consistent across the two
 * BM25 paths. Single-char tokens and stopwords are dropped.
 */
function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]+/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 1 && !STOPWORDS.has(t));
}

/**
 * Rank chunks by relevance to the current task string. Combines Okapi BM25
 * lexical overlap (chunk text vs query) with an OPTIONAL graph-proximity term.
 * Returns every chunk's index + score sorted by score descending, ties broken
 * by ascending original index (stable, deterministic). No LLM, no async.
 */
export function rankChunksByQuery(
  chunks: RankableChunk[],
  query: string,
  opts?: RankChunksOptions
): RankedChunk[] {
  const n = chunks.length;
  if (n === 0) return [];

  const proximityFn = opts?.graphProximity;

  // Identity ordering: indices 0..n-1, used as the deterministic fallback when
  // there is nothing to rank by (empty query, oversized payload).
  const identity = (): RankedChunk[] =>
    chunks.map((_, index) => ({ index, score: 0 }));

  const queryTerms = tokenize(query ?? "");
  if (queryTerms.length === 0) return identity();

  // Size cutoff — keep the hot path under the latency budget.
  let totalChars = 0;
  for (const c of chunks) totalChars += c.text.length;
  if (totalChars > LARGE_INPUT_CHARS) return identity();

  // --- BM25 index build (single pass) ---
  const docTerms: string[][] = new Array(n);
  const docLengths: number[] = new Array(n);
  let totalLength = 0;
  // Document frequency per term: how many chunks contain it.
  const docFreq = new Map<string, number>();

  for (let i = 0; i < n; i++) {
    const terms = tokenize(chunks[i]!.text);
    docTerms[i] = terms;
    docLengths[i] = terms.length;
    totalLength += terms.length;
    const seen = new Set<string>();
    for (const t of terms) {
      if (!seen.has(t)) {
        seen.add(t);
        docFreq.set(t, (docFreq.get(t) ?? 0) + 1);
      }
    }
  }

  const avgDocLength = n > 0 ? totalLength / n : 0;
  const uniqueQueryTerms = Array.from(new Set(queryTerms));

  // Precompute IDF per query term (Okapi BM25 idf with the +1 inside the log
  // so it is always non-negative and deterministic).
  const idf = new Map<string, number>();
  for (const term of uniqueQueryTerms) {
    const df = docFreq.get(term) ?? 0;
    idf.set(term, Math.log(1 + (n - df + 0.5) / (df + 0.5)));
  }

  // --- Score every chunk ---
  const results: RankedChunk[] = new Array(n);
  for (let i = 0; i < n; i++) {
    const terms = docTerms[i]!;
    const dl = docLengths[i]!;

    // Term frequency for the query terms present in this chunk.
    const tf = new Map<string, number>();
    for (const t of terms) {
      if (idf.has(t)) tf.set(t, (tf.get(t) ?? 0) + 1);
    }

    let bm25 = 0;
    for (const term of uniqueQueryTerms) {
      const f = tf.get(term);
      if (!f) continue;
      const termIdf = idf.get(term) ?? 0;
      const numerator = f * (BM25_K1 + 1);
      const denominator =
        f +
        BM25_K1 *
          (1 - BM25_B + BM25_B * (avgDocLength === 0 ? 0 : dl / avgDocLength));
      bm25 += termIdf * (denominator === 0 ? 0 : numerator / denominator);
    }

    // Optional graph-proximity term — additive structural boost.
    let proximity = 0;
    const key = chunks[i]!.entityKey;
    if (proximityFn && key !== undefined) {
      const p = proximityFn(key);
      if (Number.isFinite(p)) proximity = PROXIMITY_WEIGHT * p;
    }

    results[i] = { index: i, score: bm25 + proximity };
  }

  // Sort by score desc, ties broken by ascending original index (stable).
  results.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.index - b.index;
  });

  return results;
}

/** Inputs the current task string can be resolved from, most-trusted first. */
export interface QueryResolutionContext {
  /** The `prompt` arg passed to unerr_context this turn (the explicit task). */
  unerrContextPrompt?: string;
  /** The latest user prompt the hooks captured, used when no context arg. */
  latestUserPrompt?: string;
}

/**
 * Resolve the single "current task" string used to drive query-aware pruning:
 * the unerr_context prompt arg when present and non-blank, else the latest
 * captured user prompt, else null. Deterministic; no clock, no I/O.
 */
export function resolveCurrentQuery(
  ctx: QueryResolutionContext
): string | null {
  const fromContext = ctx.unerrContextPrompt?.trim();
  if (fromContext) return fromContext;
  const fromPrompt = ctx.latestUserPrompt?.trim();
  if (fromPrompt) return fromPrompt;
  return null;
}
