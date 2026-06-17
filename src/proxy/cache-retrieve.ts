import { join } from "node:path";
import { estimateTokenCount } from "../intelligence/token-estimator.js";
import { openMetricsStore } from "../tracking/metrics-store.js";
import { resolveExecSessionContext } from "../tracking/session-records.js";
import { getSharedReversibleCache } from "./shared-cache.js";

/**
 * Retrieve side of reversible compression (Sprint 1, T1.5/T1.6). A pagination-
 * capable tool that receives a `cache_ref` resolves the requested slice from the
 * shared in-process cache instead of recomputing the whole payload. A cache hit
 * returns the slice in O(slice) and records the re-request savings; a miss
 * (evicted entry) returns null so the caller falls back to its normal recompute
 * path — a miss is never an error.
 *
 * @sem domain=compression role=retrieval
 */

/** Default characters returned when a `cache_ref` retrieval supplies no limit. */
const DEFAULT_SLICE_CHARS = 8000;

/** A resolved cache-ref slice plus the accounting needed to record it. */
export interface CacheRetrieveHit {
  /** The withheld slice pulled back from the cached original. */
  slice: string;
  /** The hash that was retrieved (echoed so the wire can pair it to its compress row). */
  cache_ref: string;
  /** 0-based character offset the slice starts at. */
  offset: number;
  /** Maximum characters the slice may carry. */
  limit: number;
  /** Tokens the agent saved vs re-requesting the whole payload (original − slice). */
  rerequest_saved_tokens: number;
  /** Tokens in the original payload, when known (null after an eviction-only stat path). */
  original_tokens: number | null;
  /** Tokens in the delivered slice. */
  delivered_tokens: number;
}

/**
 * Resolve a `cache_ref` retrieval. Returns the slice + accounting on a hit, or
 * null on a miss (evicted / unknown hash) so the caller recomputes. Pure read of
 * the shared cache — no I/O beyond the in-process LRU.
 */
export function resolveCacheRef(
  cacheRef: string,
  rawOffset: unknown,
  rawLimit: unknown
): CacheRetrieveHit | null {
  const cache = getSharedReversibleCache();

  const offset =
    typeof rawOffset === "number" && rawOffset >= 0 ? Math.floor(rawOffset) : 0;
  const limit =
    typeof rawLimit === "number" && rawLimit > 0
      ? Math.floor(rawLimit)
      : DEFAULT_SLICE_CHARS;

  // Pull the FULL original first to size the re-request savings, then the slice.
  // Both reads hit the same live entry; a miss on the first returns null.
  const original = cache.get(cacheRef);
  if (original === null) {
    return null;
  }
  const slice = cache.get(cacheRef, { offset, limit }) ?? "";

  const originalTokens = estimateTokenCount(original);
  const deliveredTokens = estimateTokenCount(slice);
  // rerequest_saved_tokens = tokens the agent would have re-paid for the whole
  // payload − tokens of the slice actually returned. Floored at 0.
  const rerequestSaved = Math.max(0, originalTokens - deliveredTokens);

  return {
    slice,
    cache_ref: cacheRef,
    offset,
    limit,
    rerequest_saved_tokens: rerequestSaved,
    original_tokens: originalTokens,
    delivered_tokens: deliveredTokens,
  };
}

/**
 * Record one reversible-cache outcome on the EXISTING `compression_events`
 * stream (no new event type). A hit writes an `event_kind:'retrieve'`,
 * `cache_hit:1` row carrying `rerequest_saved_tokens`; a miss writes an
 * `event_kind:'recompute'`, `cache_hit:0` row so the cache-effectiveness pane
 * can see the miss. Best-effort — a metrics failure never breaks the tool.
 */
export function recordCacheRetrieve(
  cwd: string,
  tool: string,
  cacheRef: string,
  hit: CacheRetrieveHit | null
): void {
  try {
    const store = openMetricsStore(join(cwd, ".unerr"));
    const sc = resolveExecSessionContext(join(cwd, ".unerr"));
    const ts = Date.now();
    if (hit) {
      store.insertCompression({
        ts,
        ts_iso: new Date(ts).toISOString(),
        session_id: sc.session_id,
        native_session_id: sc.native_session_id,
        turn: sc.turn,
        agent: sc.agent,
        command: tool,
        category: "cache_retrieve",
        confidence: 1,
        raw_bytes: Buffer.byteLength(hit.slice, "utf8"),
        compressed_bytes: Buffer.byteLength(hit.slice, "utf8"),
        saved_pct: 0,
        omni_fallback: 0,
        tee_file: null,
        event_kind: "retrieve",
        cache_ref: cacheRef,
        cache_hit: 1,
        original_tokens: hit.original_tokens,
        delivered_tokens: hit.delivered_tokens,
        rerequest_saved_tokens: hit.rerequest_saved_tokens,
        mechanism: tool,
      });
    } else {
      store.insertCompression({
        ts,
        ts_iso: new Date(ts).toISOString(),
        session_id: sc.session_id,
        native_session_id: sc.native_session_id,
        turn: sc.turn,
        agent: sc.agent,
        command: tool,
        category: "cache_retrieve",
        confidence: 1,
        raw_bytes: 0,
        compressed_bytes: 0,
        saved_pct: 0,
        omni_fallback: 0,
        tee_file: null,
        event_kind: "recompute",
        cache_ref: cacheRef,
        cache_hit: 0,
        rerequest_saved_tokens: 0,
        mechanism: tool,
      });
    }
  } catch {
    /* best effort — metrics must never break a tool call */
  }
}
