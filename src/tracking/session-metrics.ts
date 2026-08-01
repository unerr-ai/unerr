/**
 * Per-session cache economics, derived from the local transcript cache.
 *
 * Billing shape this exists to expose (Anthropic prompt caching): a cache READ
 * costs 0.1× base input, a cache WRITE costs 2× base input on the one-hour TTL a
 * subscription main conversation uses (1.25× on the five-minute TTL sub-agents
 * get). Two consequences drive every cost decision unerr makes:
 *
 *  - Keeping a token out of context avoids one write (2×) plus a read (0.1×) on
 *    every later turn — prevention is the only lever with no quality cost.
 *  - Editing or dropping already-cached history re-writes the whole suffix at
 *    2×, which is why unerr never mutates conversation history.
 *
 * Reads the local-only transcript cache (`.unerr/cache/transcripts.jsonl`).
 * Nothing here touches `.unerr/events/`, so no derived metric is ever drained.
 */

import type { MetricsStore } from "./metrics-store.js";

/** Cache economics for one session. Zeroed counters when the session has no
 *  materialized turns yet, so callers never branch on undefined. */
export interface SessionCacheMetrics {
  /** Turns (transcript rows) the numbers were summed over. */
  turns: number;
  /** Uncached input tokens billed at base rate. */
  input_tokens: number;
  /** Output tokens (the most expensive rate; includes billed thinking). */
  output_tokens: number;
  /** Tokens written into the cache — the admission price of context. */
  cache_create_tokens: number;
  /** Tokens served from the cache at 0.1× base. */
  cache_read_tokens: number;
  /**
   * Share of input tokens served from cache: `cache_read / (cache_read + input)`.
   * 0 when the session billed no input at all. High is good — it means the
   * conversation prefix is stable and being reused.
   */
  cache_hit_rate: number;
  /**
   * How many times the average cached token was re-read:
   * `cache_read / cache_create`. 0 when nothing was written to cache. This is
   * the multiplier that makes admitting a token to context expensive — a 500-token
   * payload read back 35× costs 35 reads, not one.
   */
  reread_amplification: number;
}

/** Cost weights relative to base input price, per Anthropic prompt-caching
 *  pricing. Exported so a caller can price a session without restating them. */
export const CACHE_RATE_MULTIPLIERS = {
  /** Uncached input. */
  input: 1,
  /** Cache read. */
  cache_read: 0.1,
  /** Cache write, one-hour TTL (subscription main conversation). */
  cache_create_1h: 2,
  /** Cache write, five-minute TTL (API key default, and sub-agents). */
  cache_create_5m: 1.25,
} as const;

function ratio(numerator: number, denominator: number): number {
  if (denominator <= 0) return 0;
  return numerator / denominator;
}

/**
 * Sum the cache counters across one session's materialized turns.
 *
 * Rows written before cache accounting existed carry zeroed counters (the store
 * normalizes them on read), so an old session reports 0 rather than a wrong
 * ratio. Assistant and user rows are both summed: usage is recorded on the
 * assistant turn, and summing everything avoids double-counting logic that would
 * break if a reader starts attributing usage differently.
 */
export function computeSessionCacheMetrics(
  store: MetricsStore,
  sessionId: string
): SessionCacheMetrics {
  const rows = store.getAgentTranscriptsForSession(sessionId);
  let input = 0;
  let output = 0;
  let cacheCreate = 0;
  let cacheRead = 0;
  for (const r of rows) {
    input += r.tokens_input;
    output += r.tokens_output;
    cacheCreate += r.tokens_cache_create;
    cacheRead += r.tokens_cache_read;
  }
  return {
    turns: rows.length,
    input_tokens: input,
    output_tokens: output,
    cache_create_tokens: cacheCreate,
    cache_read_tokens: cacheRead,
    cache_hit_rate: ratio(cacheRead, cacheRead + input),
    reread_amplification: ratio(cacheRead, cacheCreate),
  };
}

/**
 * Weighted input-token units for a session — the billed-cost proxy that makes
 * cache reads and writes comparable. Uses the one-hour write multiplier by
 * default (what a subscription main conversation pays); pass `ttl:"5m"` for an
 * API-key session or a sub-agent. Output tokens are NOT included: they bill on a
 * different scale (5× input on current models), so mixing them would hide which
 * lever moved.
 */
export function weightedInputUnits(
  m: SessionCacheMetrics,
  ttl: "1h" | "5m" = "1h"
): number {
  const writeRate =
    ttl === "1h"
      ? CACHE_RATE_MULTIPLIERS.cache_create_1h
      : CACHE_RATE_MULTIPLIERS.cache_create_5m;
  return (
    m.input_tokens * CACHE_RATE_MULTIPLIERS.input +
    m.cache_read_tokens * CACHE_RATE_MULTIPLIERS.cache_read +
    m.cache_create_tokens * writeRate
  );
}
