/**
 * Persistent fetch cache backed by .unerr/metrics.db `fetch_cache` table.
 *
 * Keyed by URL. Stores the extracted markdown + content hash. On re-fetch:
 *   - same hash → cache hit, return cached markdown (callers skip extraction).
 *   - different hash → return prior markdown so the caller can compute a diff
 *     against the freshly extracted markdown (elided unchanged sections).
 *   - cold miss → returns null, caller proceeds with full extraction + store.
 */

import { createHash } from "node:crypto";
import { join } from "node:path";
import { openMetricsStore } from "../../tracking/metrics-store.js";
import type { FetchCacheRow } from "../../tracking/metrics-store.js";

export interface CacheLookup {
  hit: boolean;
  prior: FetchCacheRow | null;
}

export function hashHtml(html: string): string {
  return createHash("sha256").update(html).digest("hex").slice(0, 32);
}

export function lookupFetchCache(cwd: string, url: string): CacheLookup {
  try {
    const store = openMetricsStore(join(cwd, ".unerr"));
    const row = store.getFetchCacheRow(url);
    if (!row) return { hit: false, prior: null };
    return { hit: true, prior: row };
  } catch {
    return { hit: false, prior: null };
  }
}

export function storeFetchCache(
  cwd: string,
  row: Omit<FetchCacheRow, "hit_count">
): void {
  try {
    const store = openMetricsStore(join(cwd, ".unerr"));
    store.upsertFetchCacheRow({ ...row, hit_count: 0 });
  } catch {
    /* best effort */
  }
}

export function bumpCacheHit(cwd: string, url: string): void {
  try {
    const store = openMetricsStore(join(cwd, ".unerr"));
    store.bumpFetchCacheHitFor(url);
  } catch {
    /* best effort */
  }
}

export interface DiffSummary {
  unchanged: boolean;
  changedRegions: number;
  addedLines: number;
  removedLines: number;
}

export function summarizeMarkdownDiff(
  oldMd: string,
  newMd: string
): DiffSummary {
  if (oldMd === newMd) {
    return { unchanged: true, changedRegions: 0, addedLines: 0, removedLines: 0 };
  }
  const oldLines = new Set(oldMd.split("\n"));
  const newLines = newMd.split("\n");
  let added = 0;
  let regions = 0;
  let inRegion = false;
  for (const line of newLines) {
    if (!oldLines.has(line)) {
      added++;
      if (!inRegion) {
        regions++;
        inRegion = true;
      }
    } else {
      inRegion = false;
    }
  }
  const newLineSet = new Set(newLines);
  let removed = 0;
  for (const line of oldMd.split("\n")) {
    if (!newLineSet.has(line)) removed++;
  }
  return {
    unchanged: false,
    changedRegions: regions,
    addedLines: added,
    removedLines: removed,
  };
}
