/**
 * Sprint S1/S3/S7 integration coverage for the drop/compress side
 * (REVERSIBLE_COMPRESSION_PLAN.md). Verifies the NEW branches the integration
 * added on top of the already-built primitives:
 *
 *   - wire-cap too_large path caches the original and emits the cache-ref
 *     marker + carries cache_ref in the body + metrics (T1.3/T1.4).
 *   - wire-cap array slicing orders entity rows by graph importance before the
 *     positional cut and records `ranking_key`/`dropped_low_importance` (T3.2).
 *   - wire-cap array slicing orders by query relevance when a query is present
 *     and records `ranking_key:'query'` (T7.4).
 *   - smartTruncate folds a cacheOriginal hash into its marker + result (T1.4).
 *   - compressLogText orders error lines by query relevance (T7.5).
 *   - shrinkToBudget keeps high-importance entities when it drops a tail (T3.3).
 */

import { describe, expect, it } from "vitest";
import { rankChunksByQuery } from "../intelligence/chunk-ranker.js";
import { shrinkToBudget } from "../intelligence/recon.js";
import { smartTruncate } from "../intelligence/smart-truncate.js";
import { compressLogText } from "../proxy/shell-strategies/log-text.js";
import {
  CACHE_MARKER_PREFIX,
  ReversibleCache,
} from "../proxy/reversible-cache.js";
import {
  getSharedReversibleCache,
  resetSharedReversibleCacheForTest,
} from "../proxy/shared-cache.js";
import { applyWireCap } from "../proxy/wire-cap.js";

// Realistic code-like text so the BPE token cap actually overflows (a repeated
// single char collapses to far fewer tokens than its length).
function bigString(bytes: number): string {
  const line =
    "const result = computeValue(alpha, beta, gamma, delta); // note\n";
  return line.repeat(Math.ceil(bytes / line.length)).slice(0, bytes);
}

describe("wire-cap too_large — reversible cache (T1.3/T1.4)", () => {
  it("caches the original and emits a cache-ref marker in the page hint", () => {
    resetSharedReversibleCacheForTest();
    const oversized = bigString(20_000);
    const { body, pageHint, metrics } = applyWireCap("file_read", oversized, {});
    const obj = body as Record<string, unknown>;

    expect(obj.status).toBe("too_large");
    // The body carries the cache_ref so the retrieve side can resolve a slice.
    expect(typeof obj.cache_ref).toBe("string");
    expect((obj.cache_ref as string).length).toBeGreaterThan(0);

    // The page hint carries the machine-parseable cache-ref marker.
    expect(pageHint).toContain(CACHE_MARKER_PREFIX);
    expect(pageHint).toContain(obj.cache_ref as string);

    // Metrics: a compress event pointing at the cached original.
    expect(metrics?.event_kind).toBe("compress");
    expect(metrics?.mechanism).toBe("wire_cap");
    expect(metrics?.cache_ref).toBe(obj.cache_ref);
    expect(metrics?.original_tokens).toBeGreaterThan(
      metrics?.delivered_tokens ?? Number.POSITIVE_INFINITY
    );

    // The cached original is retrievable from the shared cache by that hash.
    const back = getSharedReversibleCache().get(obj.cache_ref as string);
    expect(back).toBe(oversized);
  });

  it("marker is byte-stable for identical input (determinism, feeds S2)", () => {
    resetSharedReversibleCacheForTest();
    const oversized = bigString(20_000);
    const a = applyWireCap("file_read", oversized, {}).pageHint;
    resetSharedReversibleCacheForTest();
    const b = applyWireCap("file_read", oversized, {}).pageHint;
    expect(a).toBe(b);
  });
});

describe("wire-cap array slicing — graph importance (T3.2)", () => {
  // Build N entity rows; the LAST one is the highest-fan_in hub, so positional
  // slicing would drop it but importance ordering must keep it.
  function entityRows(n: number): Array<Record<string, unknown>> {
    return Array.from({ length: n }, (_, i) => ({
      key: `e${i}`,
      name: `entity_${i}`,
      fan_in: i === n - 1 ? 999 : 0,
      fan_out: 0,
      risk_level: "normal",
    }));
  }

  it("keeps the highest-importance entity and records ranking_key:importance", () => {
    const rows = entityRows(40); // > search_code defaultLimit (10)
    const { body, metrics } = applyWireCap("search_code", rows, {});
    const kept = body as Array<Record<string, unknown>>;
    // The hub (fan_in 999, originally last) survives the cut.
    expect(kept.some((r) => r.fan_in === 999)).toBe(true);
    expect(metrics?.ranking_key).toBe("importance");
    expect(metrics?.survivors_by_importance).toBe(true);
    expect(metrics?.dropped_low_importance).toBeGreaterThan(0);
  });

  it("uses query relevance when a query arg is present (T7.4)", () => {
    const rows = [
      { key: "a", name: "parseConfig", fan_in: 0, summary: "loads yaml config" },
      { key: "b", name: "renderButton", fan_in: 0, summary: "draws a button" },
      { key: "c", name: "saveConfig", fan_in: 0, summary: "writes yaml config" },
    ];
    // Pad past the limit so a cut happens.
    const padded = [
      ...rows,
      ...Array.from({ length: 30 }, (_, i) => ({
        key: `pad${i}`,
        name: `noise_${i}`,
        fan_in: 0,
      })),
    ];
    const { metrics } = applyWireCap("search_code", padded, {
      query: "yaml config",
    });
    expect(metrics?.ranking_key).toBe("query");
  });

  it("leaves non-entity tools positional (fetch_url passages untouched)", () => {
    const passages = Array.from({ length: 50 }, (_, i) => ({
      text: `passage ${i}`,
    }));
    const { metrics } = applyWireCap(
      "fetch_url",
      { passages },
      { limit: 10 }
    );
    expect(metrics?.ranking_key).toBe("positional");
  });
});

describe("smartTruncate — cacheOriginal hook (T1.4)", () => {
  it("folds the cache hash into the marker and result when truncated", () => {
    const cache = new ReversibleCache();
    const big = "x".repeat(50_000);
    const result = smartTruncate({
      metadata: "name: bigFn",
      imports: "",
      signatures: "function bigFn()",
      bodies: big,
      budget: 200,
      cacheOriginal: (full) => cache.put(full),
    });
    expect(result.truncated).toBe(true);
    expect(typeof result.cache_ref).toBe("string");
    expect(result.content).toContain("cache_ref:");
    expect(result.content).toContain(result.cache_ref as string);
  });

  it("omits cache_ref when no callback is supplied (no regression)", () => {
    const result = smartTruncate({
      metadata: "name: bigFn",
      imports: "",
      signatures: "function bigFn()",
      bodies: "y".repeat(50_000),
      budget: 200,
    });
    expect(result.truncated).toBe(true);
    expect(result.cache_ref).toBeUndefined();
  });
});

describe("compressLogText — query-aware error ordering (T7.5)", () => {
  it("surfaces the on-query error first when the set exceeds the cut", () => {
    const lines: string[] = [];
    // 40 distinct noise errors, then one on-query error at the very end.
    for (let i = 0; i < 40; i++) lines.push(`ERROR noise event number ${i}`);
    lines.push("FATAL database connection refused on port 5432");
    // Pad with non-error lines so total > SMALL_THRESHOLD.
    for (let i = 0; i < 100; i++) lines.push(`info tick ${i}`);
    const text = lines.join("\n");

    const out = compressLogText(text, "node server.js", "database connection");
    const noQuery = compressLogText(text, "node server.js");

    // With the query, the on-task FATAL line survives the MAX_ERROR_LINES cut;
    // without it, the positional order buries it past the cut.
    expect(out).toContain("database connection refused");
    expect(noQuery).not.toContain("database connection refused");
  });
});

describe("shrinkToBudget — importance-ordered tail drop (T3.3)", () => {
  it("keeps the highest-fan_in entity when it drops a long array's tail", () => {
    const entities = Array.from({ length: 30 }, (_, i) => ({
      key: `k${i}`,
      name: `e${i}`,
      // The hub is in the middle so neither pure head nor tail keeps it.
      fan_in: i === 15 ? 500 : 1,
    }));
    const data = { entities };
    // A counter that makes the array the obvious shrink target.
    const count = (d: unknown): number => JSON.stringify(d).length;
    const budget = Math.floor(count(data) / 3);
    const { data: shrunk, shrunk: didShrink } = shrinkToBudget(
      data,
      budget,
      count
    );
    expect(didShrink).toBe(true);
    const kept = (shrunk as { entities: Array<{ fan_in: number }> }).entities;
    expect(kept.some((e) => e.fan_in === 500)).toBe(true);
  });
});

describe("rankChunksByQuery sanity (chunk-ranker primitive)", () => {
  it("ranks the lexically-matching chunk first", () => {
    const ranked = rankChunksByQuery(
      [{ text: "unrelated text here" }, { text: "yaml config parser" }],
      "yaml config"
    );
    expect(ranked[0]?.index).toBe(1);
  });
});
