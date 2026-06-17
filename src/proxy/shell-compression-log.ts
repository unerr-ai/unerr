/**
 * Compression-specific event log — per-command rows written to
 * `.unerr/metrics.db` (`compression_events` and `file_read_events`).
 *
 * Previously this was JSONL (`logs/compression.jsonl`, `logs/file-reads.jsonl`);
 * migrated to SQLite for indexed lookups, monotonic poll-by-id semantics
 * (used by the log-tailer), and cheap aggregations in the dashboard.
 *
 * The wire types (CompressionLogEntry / FileReadLogEntry) are unchanged so
 * callers don't need to know about the storage backend.
 */

import { join } from "node:path";
import { estimateTokenCount } from "../intelligence/token-estimator.js";
import { openMetricsStore } from "../tracking/metrics-store.js";

/**
 * Before/after token accounting for one compression event. The §4 metrics
 * (REVERSIBLE_COMPRESSION_PLAN.md) need a single accounting path so the ratio
 * is apples-to-apples: BOTH numbers come from the same token-estimator code
 * path (o200k_base via estimateTokenCount). Every compressor that wants to
 * record `original_tokens` / `delivered_tokens` / `mechanism` calls this once.
 *
 * @sem domain=metrics role=accounting
 */
export function accountCompression(
  original: string,
  delivered: string,
  mechanism: string
): { original_tokens: number; delivered_tokens: number; mechanism: string } {
  return {
    original_tokens: estimateTokenCount(original),
    delivered_tokens: estimateTokenCount(delivered),
    mechanism,
  };
}

export interface CompressionLogEntry {
  ts: string;
  command: string;
  category: string;
  confidence: number;
  rawBytes: number;
  compressedBytes: number;
  savedPct: number;
  omniFallback: boolean;
  teeFile?: string;
  /**
   * Number of pages in the bulk fetch_url batch this row belongs to. Set by
   * the batch orchestrator (FetchUrlContext.batchSize); omitted for a single
   * fetch and every non-fetch_url compressor. Lets the dashboard group a
   * batch's per-page rows without inventing an aggregate row — savings stay
   * per-page (no double counting).
   */
  batchSize?: number;
  /**
   * §4 reversible-compression fields (REVERSIBLE_COMPRESSION_PLAN.md). All
   * OPTIONAL — a compressor that does not run reversible/importance/query-aware
   * logic omits them and the row keeps its existing shape (the columns default
   * to null / `event_kind:'compress'`). Carried through to `insertCompression`.
   */
  reversible?: ReversibleCompressionFields;
}

/**
 * The subset of `compression_events` §4 columns a compress site can populate.
 * Every field is optional; a missing field is coalesced to its column default
 * by `insertCompression` (null, or `'compress'` for `event_kind`). This is the
 * single accounting path the §4 metrics design references so the dashboard and
 * the `unerr »` line read one consistent source.
 */
export interface ReversibleCompressionFields {
  /** Per-event before/after token count + which compressor (T0.2). */
  original_tokens?: number;
  delivered_tokens?: number;
  mechanism?: string;
  /** Did the must-survive fact survive (S0/S4); null/undefined when unprobed. */
  fidelity_pass?: boolean;
  /** `compress` (default) | `retrieve` | `recompute` (S1) | `context_bundle` (E4). */
  event_kind?: "compress" | "retrieve" | "recompute" | "context_bundle";
  /** Content hash of the cached original when S1 cached one. */
  cache_ref?: string;
  /** Did this truncation order survivors by graph importance (S3). */
  survivors_by_importance?: boolean;
  /** How many low-`fan_in` items the importance ordering dropped (S3). */
  dropped_low_importance?: number;
  /** Which signal ordered survivors (S7): `query` | `importance` | `positional`. */
  ranking_key?: "query" | "importance" | "positional";
  /** How many chunks query relevance pruned beyond the budget floor (S7). */
  query_relevance_pruned?: number;
}

export interface FileReadLogEntry {
  ts: string;
  file: string;
  mode: "outline" | "entity" | "slice" | "full" | "log_tail" | "gated";
  totalLines: number;
  returnedLines: number;
  savedPct: number;
  entity?: string;
  tokenEstimate?: number;
}

function parseTs(ts: string): number {
  const n = Date.parse(ts);
  return Number.isNaN(n) ? Date.now() : n;
}

export function appendCompressionLog(
  cwd: string,
  entry: CompressionLogEntry
): void {
  try {
    const store = openMetricsStore(join(cwd, ".unerr"));
    const rev = entry.reversible;
    // Sprint S8 — running transcript-footprint estimate. Each compress event
    // adds the tokens it actually put on the wire (`delivered_tokens`, or the
    // compressed-byte estimate when the compressor did not supply a token
    // count) to the prior cumulative. A `retrieve`/`recompute` row is the
    // offload PATH, not new transcript bulk, so it does not advance the
    // footprint (cache-retrieve.ts writes those rows and leaves the column
    // null). This is the source-side number S8 reports — unerr cannot rewrite
    // the transcript, but it can measure what it contributes to it.
    const deliveredTokens =
      rev?.delivered_tokens ?? Math.round(entry.compressedBytes / 4);
    const transcriptFootprint =
      store.transcriptFootprintLatest() + Math.max(0, deliveredTokens);
    store.insertCompression({
      ts: parseTs(entry.ts),
      ts_iso: entry.ts,
      command: entry.command,
      category: entry.category,
      confidence: entry.confidence,
      raw_bytes: entry.rawBytes,
      compressed_bytes: entry.compressedBytes,
      saved_pct: entry.savedPct,
      omni_fallback: entry.omniFallback ? 1 : 0,
      tee_file: entry.teeFile ?? null,
      ...(entry.batchSize !== undefined ? { batch_size: entry.batchSize } : {}),
      // §4 fields — only set when the compressor supplied them; omitted ones
      // coalesce to their column defaults in insertCompression (boolean → 0/1,
      // event_kind → 'compress'). Never replaces an existing column.
      ...(rev?.original_tokens !== undefined
        ? { original_tokens: rev.original_tokens }
        : {}),
      ...(rev?.delivered_tokens !== undefined
        ? { delivered_tokens: rev.delivered_tokens }
        : {}),
      ...(rev?.mechanism !== undefined ? { mechanism: rev.mechanism } : {}),
      ...(rev?.fidelity_pass !== undefined
        ? { fidelity_pass: rev.fidelity_pass ? 1 : 0 }
        : {}),
      ...(rev?.event_kind !== undefined ? { event_kind: rev.event_kind } : {}),
      ...(rev?.cache_ref !== undefined ? { cache_ref: rev.cache_ref } : {}),
      ...(rev?.survivors_by_importance !== undefined
        ? { survivors_by_importance: rev.survivors_by_importance ? 1 : 0 }
        : {}),
      ...(rev?.dropped_low_importance !== undefined
        ? { dropped_low_importance: rev.dropped_low_importance }
        : {}),
      ...(rev?.ranking_key !== undefined
        ? { ranking_key: rev.ranking_key }
        : {}),
      ...(rev?.query_relevance_pruned !== undefined
        ? { query_relevance_pruned: rev.query_relevance_pruned }
        : {}),
      // S8 — running cumulative footprint stamped on every compress row.
      transcript_footprint_tokens: transcriptFootprint,
    });
  } catch {
    /* best effort */
  }
}

export function appendFileReadLog(cwd: string, entry: FileReadLogEntry): void {
  try {
    const store = openMetricsStore(join(cwd, ".unerr"));
    store.insertFileRead({
      ts: parseTs(entry.ts),
      ts_iso: entry.ts,
      file: entry.file,
      mode: entry.mode,
      total_lines: entry.totalLines,
      returned_lines: entry.returnedLines,
      saved_pct: entry.savedPct,
      entity: entry.entity ?? null,
      token_estimate: entry.tokenEstimate ?? null,
    });
  } catch {
    /* best effort */
  }
}

export function readRecentFileReadLogs(
  cwd: string,
  limit = 10
): FileReadLogEntry[] {
  try {
    const store = openMetricsStore(join(cwd, ".unerr"));
    return store.recentFileReads(limit).map((r) => ({
      ts: r.ts_iso,
      file: r.file,
      mode: r.mode as FileReadLogEntry["mode"],
      totalLines: r.total_lines,
      returnedLines: r.returned_lines,
      savedPct: r.saved_pct,
      entity: r.entity ?? undefined,
      tokenEstimate: r.token_estimate ?? undefined,
    }));
  } catch {
    return [];
  }
}

export function readRecentCompressionLogs(
  cwd: string,
  limit = 10
): CompressionLogEntry[] {
  try {
    const store = openMetricsStore(join(cwd, ".unerr"));
    return store.recentCompression(limit).map((r) => ({
      ts: r.ts_iso,
      command: r.command,
      category: r.category,
      confidence: r.confidence,
      rawBytes: r.raw_bytes,
      compressedBytes: r.compressed_bytes,
      savedPct: r.saved_pct,
      omniFallback: r.omni_fallback === 1,
      teeFile: r.tee_file ?? undefined,
    }));
  } catch {
    return [];
  }
}
