/**
 * Persistent fetch cache backed by .unerr/metrics.db `fetch_cache` table.
 *
 * Keyed by URL. Stores the extracted markdown + content hash. On re-fetch:
 *   - same hash → cache hit, return cached markdown (callers skip extraction).
 *   - different hash → return prior markdown so the caller can compute a diff
 *     against the freshly extracted markdown (elided unchanged sections).
 *   - cold miss → returns null, caller proceeds with full extraction + store.
 *
 * Two freshness gates layered on top of the content-hash check:
 *   - Stale-while-revalidate: a row younger than FRESH_TTL_MS is reused
 *     without hitting the network at all (the caller skips even the HTTP
 *     request). This is the "I just read this same docs page two minutes ago"
 *     case — repeated re-fetch is pure waste.
 *   - Negative cache: a row whose last attempt landed on an anti-bot
 *     challenge is treated as a synthetic blocked hit while its
 *     NEGATIVE_TTL_MS window is still open. Stops the loop where the
 *     agent re-fires fetch_url against a host it just learnt is gated.
 */

import { createHash } from "node:crypto";
import { join } from "node:path";
import { openMetricsStore } from "../../tracking/metrics-store.js";
import type { FetchCacheRow } from "../../tracking/metrics-store.js";

/** How long a successful cache row is treated as fresh without re-fetching. */
export const FRESH_TTL_MS = 5 * 60_000; // 5 min
/** How long a blocked URL stays in the negative cache before a retry. */
export const NEGATIVE_TTL_MS = 30 * 60_000; // 30 min

export interface CacheLookup {
  hit: boolean;
  prior: FetchCacheRow | null;
  /** Cached row is younger than FRESH_TTL_MS — skip the network. */
  fresh: boolean;
  /** Cached row is a recent block — treat as a synthetic blocked hit. */
  negative: boolean;
}

export function hashHtml(html: string): string {
  return createHash("sha256").update(html).digest("hex").slice(0, 32);
}

export function lookupFetchCache(cwd: string, url: string): CacheLookup {
  try {
    const store = openMetricsStore(join(cwd, ".unerr"));
    const row = store.getFetchCacheRow(url);
    if (!row) return { hit: false, prior: null, fresh: false, negative: false };
    const ageMs = Date.now() - row.fetched_at;
    const negative = row.blocked_reason !== null && ageMs < NEGATIVE_TTL_MS;
    const fresh = !negative && row.blocked_reason === null && ageMs < FRESH_TTL_MS;
    return { hit: true, prior: row, fresh, negative };
  } catch {
    return { hit: false, prior: null, fresh: false, negative: false };
  }
}

export function storeFetchCache(
  cwd: string,
  row: Omit<
    FetchCacheRow,
    | "hit_count"
    | "blocked_reason"
    | "published_at"
    | "author"
    | "og_type"
    | "site_name"
    | "favicon"
  > & {
    blocked_reason?: string | null;
    published_at?: string | null;
    author?: string | null;
    og_type?: string | null;
    site_name?: string | null;
    favicon?: string | null;
  }
): void {
  try {
    const store = openMetricsStore(join(cwd, ".unerr"));
    store.upsertFetchCacheRow({
      ...row,
      blocked_reason: row.blocked_reason ?? null,
      published_at: row.published_at ?? null,
      author: row.author ?? null,
      og_type: row.og_type ?? null,
      site_name: row.site_name ?? null,
      favicon: row.favicon ?? null,
      hit_count: 0,
    });
  } catch {
    /* best effort */
  }
}

/**
 * Record a blocked-result hint in the cache so subsequent fetches against the
 * same URL within NEGATIVE_TTL_MS short-circuit without hitting the network.
 */
export function storeNegativeFetchCache(
  cwd: string,
  url: string,
  blockedReason: string,
  title: string
): void {
  try {
    const store = openMetricsStore(join(cwd, ".unerr"));
    store.upsertFetchCacheRow({
      url,
      content_hash: "",
      markdown: "",
      title,
      extractor: "raw-body",
      raw_bytes: 0,
      compressed_bytes: 0,
      fetched_at: Date.now(),
      hit_count: 0,
      blocked_reason: blockedReason,
      published_at: null,
      author: null,
      og_type: null,
      site_name: null,
      favicon: null,
    });
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
