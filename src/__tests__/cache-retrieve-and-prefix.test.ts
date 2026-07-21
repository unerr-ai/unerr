import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  recordCacheRetrieve,
  resolveCacheRef,
} from "../proxy/cache-retrieve.js";
import { orderConventions, orderTags } from "../proxy/prefix-order.js";
import { buildSignalPrefix } from "../proxy/response-envelope.js";
import {
  getSharedReversibleCache,
  resetSharedReversibleCacheForTest,
} from "../proxy/shared-cache.js";
import { resetSignalDedupSingleton } from "../proxy/signal-dedup.js";

describe("resolveCacheRef — retrieve side (T1.5/T1.6)", () => {
  beforeEach(() => {
    resetSharedReversibleCacheForTest();
  });

  it("a cache_ref hit returns the requested slice", () => {
    const cache = getSharedReversibleCache();
    const original = "0123456789abcdefghij";
    const hash = cache.put(original);

    const hit = resolveCacheRef(hash, 4, 6);
    expect(hit).not.toBeNull();
    expect(hit?.slice).toBe("456789");
    expect(hit?.cache_ref).toBe(hash);
    expect(hit?.offset).toBe(4);
    expect(hit?.limit).toBe(6);
  });

  it("a hit records re-request savings (original − slice tokens, ≥0)", () => {
    const cache = getSharedReversibleCache();
    // Large original so original_tokens > delivered_tokens for the slice.
    const original = "word ".repeat(4000);
    const hash = cache.put(original);

    const hit = resolveCacheRef(hash, 0, 40);
    expect(hit).not.toBeNull();
    expect(hit?.rerequest_saved_tokens).toBeGreaterThan(0);
    expect(hit?.original_tokens).toBeGreaterThan(hit?.delivered_tokens ?? 0);
  });

  it("a cache miss (unknown / evicted hash) returns null — caller recomputes", () => {
    // Empty cache → any hash misses.
    expect(resolveCacheRef("deadbeef", 0, 100)).toBeNull();
  });

  it("defaults offset to 0 and limit to a positive window when args are absent", () => {
    const cache = getSharedReversibleCache();
    const hash = cache.put("abcdef");
    const hit = resolveCacheRef(hash, undefined, undefined);
    expect(hit?.offset).toBe(0);
    expect(hit?.slice).toBe("abcdef");
  });
});

describe("recordCacheRetrieve — metrics on the existing compression_events", () => {
  let cwd: string;
  beforeEach(() => {
    resetSharedReversibleCacheForTest();
    cwd = mkdtempSync(join(tmpdir(), "unerr-cache-retrieve-"));
  });
  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  it("a hit writes an event_kind:'retrieve' row with cache_hit and saved tokens", async () => {
    const cache = getSharedReversibleCache();
    const hash = cache.put("token ".repeat(2000));
    const hit = resolveCacheRef(hash, 0, 50);
    recordCacheRetrieve(cwd, "search_code", hash, hit);

    const { openMetricsStore } = await import("../tracking/metrics-store.js");
    const store = openMetricsStore(join(cwd, ".unerr"));
    const rows = store.recentCompression(10);
    const retrieve = rows.find((r) => r.event_kind === "retrieve");
    expect(retrieve).toBeDefined();
    expect(retrieve?.cache_hit).toBe(1);
    expect(retrieve?.cache_ref).toBe(hash);
    expect((retrieve?.rerequest_saved_tokens ?? 0) > 0).toBe(true);
  });

  it("a miss writes an event_kind:'recompute' row with cache_hit:0", async () => {
    recordCacheRetrieve(cwd, "search_code", "deadbeef", null);

    const { openMetricsStore } = await import("../tracking/metrics-store.js");
    const store = openMetricsStore(join(cwd, ".unerr"));
    const rows = store.recentCompression(10);
    const recompute = rows.find((r) => r.event_kind === "recompute");
    expect(recompute).toBeDefined();
    expect(recompute?.cache_hit).toBe(0);
  });
});

describe("prefix ordering helpers produce stable bytes across two calls", () => {
  it("orderTags: same input → identical serialization", () => {
    const tags = [
      { tag: "fct", body: "z fact" },
      { tag: "act", body: "do x" },
      { tag: "rsk", body: "a risk" },
      { tag: "ctx", body: "state changed" },
    ];
    const a = orderTags(tags)
      .map((t) => `${t.tag} ${t.body}`)
      .join("\n");
    const b = orderTags([...tags].reverse())
      .map((t) => `${t.tag} ${t.body}`)
      .join("\n");
    expect(a).toBe(b);
    // act (bucket 0) must precede fct (bucket 3).
    expect(a.indexOf("act")).toBeLessThan(a.indexOf("fct"));
  });

  it("orderConventions: order is by name, NOT by a drifting float", () => {
    const convs = [
      { name: "beta", path: "" },
      { name: "alpha", path: "" },
      { name: "gamma", path: "" },
    ];
    const a = orderConventions(convs).map((c) => c.name);
    const b = orderConventions([...convs].reverse()).map((c) => c.name);
    expect(a).toEqual(b);
    expect(a).toEqual(["alpha", "beta", "gamma"]);
  });
});

describe("buildSignalPrefix orders by priority before the line cap (T2.3)", () => {
  beforeEach(() => {
    resetSignalDedupSingleton();
  });

  it("the highest-priority line (act) survives the 2-line cap deterministically", () => {
    // Three candidates spanning three buckets: circuit_breaker → act,
    // session_health → ctx, causal_history → rsk. The cap is 2, so the two
    // highest-priority (act, ctx) must survive and rsk must be dropped.
    const meta = {
      circuit_breaker: { entity: "Foo", attempts: 4 },
      session_health: { health: 0.4, recommendation: "start a new session" },
      causal_history: { interactions: 3, failure_modes: ["regression"] },
    };
    const prefix = buildSignalPrefix(meta, {}, "Foo");
    const lines = prefix.trim().split("\n");
    expect(lines.length).toBe(2);
    expect(lines[0]?.startsWith("ur|act")).toBe(true);
    expect(lines[1]?.startsWith("ur|ctx")).toBe(true);
    // The lower-priority risk line was dropped by the cap.
    expect(prefix).not.toContain("regression");
  });

  it("identical input produces byte-identical output across two calls", () => {
    const meta = {
      session_health: { health: 0.4, recommendation: "start a new session" },
      causal_history: { interactions: 3, failure_modes: ["regression"] },
    };
    const first = buildSignalPrefix(meta, {}, "Foo");
    resetSignalDedupSingleton();
    const second = buildSignalPrefix(meta, {}, "Foo");
    expect(first).toBe(second);
  });
});
