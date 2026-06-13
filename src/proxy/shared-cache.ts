import { ReversibleCache } from "./reversible-cache.js";

/**
 * Process-wide singleton of the reversible content cache so the compress side
 * (wire-cap / shell strategies storing a dropped original) and the retrieve
 * side (file_read / search_code / fetch_url pulling a slice back) share one
 * store — without a shared instance every cache_ref retrieval would miss.
 *
 * @sem domain=compression role=cache
 */

let shared: ReversibleCache | null = null;

/**
 * Return the per-process reversible cache, constructing it on first use. Lives
 * on the per-repo proxy lifecycle (one process), so all tool handlers in that
 * process reference the same cached originals.
 */
export function getSharedReversibleCache(): ReversibleCache {
  if (shared === null) {
    shared = new ReversibleCache();
  }
  return shared;
}

/** Reset the singleton — test-only hook so a suite starts from an empty cache. */
export function resetSharedReversibleCacheForTest(): void {
  shared = null;
}
