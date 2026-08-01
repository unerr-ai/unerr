import { appendFileSync, mkdirSync, rmSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  closeMetricsStore,
  openMetricsStore,
} from "../tracking/metrics-store.js";
import {
  computeSessionCacheMetrics,
  weightedInputUnits,
} from "../tracking/session-metrics.js";

/** Minimal row body; each test overrides the token counters it cares about. */
function row(turn: number, tokens: Partial<Record<string, number>> = {}) {
  return {
    session_id: "s1",
    native_session_id: null,
    turn,
    agent: "claude-code",
    role: "assistant",
    text: null,
    tools: null,
    files: null,
    model: "claude-fable-5",
    tokens_input: 0,
    tokens_output: 0,
    tokens_cache_create: 0,
    tokens_cache_read: 0,
    ts: new Date(2026, 0, 1, 0, 0, turn).toISOString(),
    ...tokens,
  };
}

describe("session cache metrics", () => {
  let root: string;
  let dir: string;

  beforeEach(() => {
    // Unique parent per test: the store derives repoRoot = dirname(unerrDir),
    // so a shared parent would collapse every test onto one transcript cache.
    root = join(os.tmpdir(), `unerr-cachemx-${Date.now()}-${Math.random()}`);
    dir = join(root, ".unerr");
    mkdirSync(dir, { recursive: true });
  });

  afterEach(() => {
    closeMetricsStore(dir);
    rmSync(root, { recursive: true, force: true });
  });

  it("reports zeroed metrics for a session with no turns", () => {
    const store = openMetricsStore(dir);
    const m = computeSessionCacheMetrics(store, "unknown-session");
    expect(m.turns).toBe(0);
    expect(m.cache_hit_rate).toBe(0);
    expect(m.reread_amplification).toBe(0);
  });

  it("sums cache counters and derives hit rate + re-read amplification", () => {
    const store = openMetricsStore(dir);
    // Turn 1 writes 1000 tokens into cache with 200 fresh input.
    store.upsertAgentTranscript(
      row(1, {
        tokens_input: 200,
        tokens_cache_create: 1000,
        tokens_output: 50,
      })
    );
    // Turns 2-3 read that prefix back — the shape of a real long session.
    store.upsertAgentTranscript(
      row(2, { tokens_input: 100, tokens_cache_read: 1000, tokens_output: 30 })
    );
    store.upsertAgentTranscript(
      row(3, { tokens_input: 100, tokens_cache_read: 2000, tokens_output: 20 })
    );

    const m = computeSessionCacheMetrics(store, "s1");
    expect(m.turns).toBe(3);
    expect(m.input_tokens).toBe(400);
    expect(m.output_tokens).toBe(100);
    expect(m.cache_create_tokens).toBe(1000);
    expect(m.cache_read_tokens).toBe(3000);
    // 3000 / (3000 + 400)
    expect(m.cache_hit_rate).toBeCloseTo(0.8824, 4);
    // Each cached token was read back three times on average.
    expect(m.reread_amplification).toBeCloseTo(3, 6);
  });

  it("normalizes rows written before cache accounting existed to zero", () => {
    const store = openMetricsStore(dir);
    // Simulate a legacy line: same shape minus the two cache keys. Written
    // straight to the cache file because the typed API now requires them.
    const {
      tokens_cache_create: _create,
      tokens_cache_read: _read,
      ...legacy
    } = row(1, { tokens_input: 500 });
    const cachePath = join(dir, "cache", "transcripts.jsonl");
    mkdirSync(join(dir, "cache"), { recursive: true });
    appendFileSync(cachePath, `${JSON.stringify(legacy)}\n`);

    const m = computeSessionCacheMetrics(store, "s1");
    expect(m.turns).toBe(1);
    expect(m.cache_create_tokens).toBe(0);
    expect(m.cache_read_tokens).toBe(0);
    // No cache activity recorded ⇒ ratios stay 0 rather than dividing by zero.
    expect(m.cache_hit_rate).toBe(0);
    expect(m.reread_amplification).toBe(0);
  });

  it("prices a cache write at 2x on the one-hour TTL and 1.25x on five minutes", () => {
    const store = openMetricsStore(dir);
    store.upsertAgentTranscript(
      row(1, { tokens_input: 100, tokens_cache_create: 1000 })
    );
    store.upsertAgentTranscript(row(2, { tokens_cache_read: 1000 }));

    const m = computeSessionCacheMetrics(store, "s1");
    // 100 input + 1000 read x0.1 + 1000 write x2
    expect(weightedInputUnits(m, "1h")).toBeCloseTo(2200, 6);
    // Sub-agents and API-key sessions get the cheaper five-minute write.
    expect(weightedInputUnits(m, "5m")).toBeCloseTo(1450, 6);
    // Default matches the subscription main conversation.
    expect(weightedInputUnits(m)).toBe(weightedInputUnits(m, "1h"));
  });
});
