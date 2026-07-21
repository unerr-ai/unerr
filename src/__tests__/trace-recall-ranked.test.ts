/**
 * Cap A-2: recallTracesBySymptom — TF-IDF ranking + anchor boost + relevance
 * floor + the anchor-existence staleness gate.
 *
 * Seeds the timeline store directly (insertTrace + insertTraceTokens) to control
 * token distribution, then calls recallTracesBySymptom and asserts:
 *   1. The trace with the most overlapping query tokens ranks first.
 *   2. Adding an anchorHint for a tied candidate lifts it above the other.
 *   3. A prompt whose tokens match nothing returns an empty array (relevance floor).
 *   4. A trace whose anchor no longer exists is dropped; checker errors fail open.
 */

import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CozoTimelineStore } from "../timeline/timeline-store.js";
import { recallTracesBySymptom } from "../timeline/trace-recall.js";

let tempDir: string;
let timelineStore: CozoTimelineStore;

const NOW = Date.now();

/** Insert a trace plus its situation tokens in one helper call. */
async function seedTrace(
  store: CozoTimelineStore,
  opts: {
    id: string;
    situation: string;
    unlock: string;
    anchor: string;
    tokens: string[];
  }
): Promise<void> {
  await store.insertTrace({
    trace_id: opts.id,
    situation: opts.situation,
    dead_ends: JSON.stringify([]),
    unlock: opts.unlock,
    anchor: opts.anchor,
    session_id: "sess-test",
    resolved_at: NOW,
  });
  await store.insertTraceTokens(opts.id, opts.tokens);
}

beforeEach(async () => {
  tempDir = join(
    tmpdir(),
    `unerr-recall-ranked-${Date.now()}-${Math.random().toString(36).slice(2)}`
  );
  mkdirSync(join(tempDir, ".unerr"), { recursive: true });
  timelineStore = await CozoTimelineStore.create(tempDir);
});

afterEach(() => {
  try {
    timelineStore.close();
  } catch {
    /* ignore */
  }
  try {
    rmSync(tempDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

describe("recallTracesBySymptom — TF-IDF ranking", () => {
  it("ranks the trace with the most token overlap first", async () => {
    // Trace A: 4 tokens match the query
    await seedTrace(timelineStore, {
      id: "trace-a",
      situation: "TypeScript async error in auth module",
      unlock: "Annotate the return type explicitly",
      anchor: "src/auth/token.ts",
      tokens: ["typescript", "async", "error", "auth"],
    });
    // Trace B: 0 tokens match the query
    await seedTrace(timelineStore, {
      id: "trace-b",
      situation: "Database connection pool exhausted",
      unlock: "Increase pool size in config",
      anchor: "src/db/pool.ts",
      tokens: ["database", "connection", "pool"],
    });
    // Trace C: 2 tokens match the query (subset of A)
    await seedTrace(timelineStore, {
      id: "trace-c",
      situation: "Async compile error in build pipeline",
      unlock: "Add missing await in pipeline",
      anchor: "src/build/compiler.ts",
      tokens: ["async", "error", "build", "pipeline"],
    });

    const results = await recallTracesBySymptom(
      timelineStore,
      ["typescript", "async", "error", "auth"],
      3
    );

    // Trace A must rank first: 4 matching tokens vs Trace C's 2
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0]?.trace_id).toBe("trace-a");
    // Trace B has zero overlap — should not appear
    expect(results.map((r) => r.trace_id)).not.toContain("trace-b");
  });

  it("anchor boost raises a tied candidate above the other", async () => {
    // Two traces with identical token sets → equal base TF-IDF score
    await seedTrace(timelineStore, {
      id: "trace-auth",
      situation: "TypeScript async error in module",
      unlock: "Add explicit return type",
      anchor: "src/auth/token.ts",
      tokens: ["typescript", "async", "error"],
    });
    await seedTrace(timelineStore, {
      id: "trace-config",
      situation: "TypeScript async error in module",
      unlock: "Add explicit return type",
      anchor: "src/config/settings.ts",
      tokens: ["typescript", "async", "error"],
    });
    // Third trace ensures N=3 so tokens have non-trivial IDF
    await seedTrace(timelineStore, {
      id: "trace-other",
      situation: "Cache miss in redis layer",
      unlock: "Warm the cache on startup",
      anchor: "src/cache/redis.ts",
      tokens: ["cache", "miss", "redis"],
    });

    // Without anchor hint: both trace-auth and trace-config score equally
    const withoutBoost = await recallTracesBySymptom(
      timelineStore,
      ["typescript", "async", "error"],
      3
    );
    expect(withoutBoost.map((r) => r.trace_id)).toContain("trace-auth");
    expect(withoutBoost.map((r) => r.trace_id)).toContain("trace-config");

    // With anchor hint for src/auth/token.ts: trace-auth gets +0.5 → ranks first
    const withBoost = await recallTracesBySymptom(
      timelineStore,
      ["typescript", "async", "error"],
      3,
      ["src/auth/token.ts"]
    );
    expect(withBoost[0]?.trace_id).toBe("trace-auth");
    expect(withBoost[1]?.trace_id).toBe("trace-config");
  });

  it("returns empty when no query token matches any trace (relevance floor)", async () => {
    await seedTrace(timelineStore, {
      id: "trace-x",
      situation: "Database timeout in pool",
      unlock: "Raise pool timeout",
      anchor: "src/db/pool.ts",
      tokens: ["database", "timeout", "pool"],
    });

    // Tokens that do not appear in any trace
    const results = await recallTracesBySymptom(
      timelineStore,
      ["zzz", "xyz", "qwerty"],
      3
    );
    expect(results).toHaveLength(0);
  });

  it("returns empty for empty token list", async () => {
    const results = await recallTracesBySymptom(timelineStore, [], 3);
    expect(results).toHaveLength(0);
  });

  it("respects the limit parameter", async () => {
    // Seed 3 traces that all share a token so all score above the floor
    for (const id of ["t1", "t2", "t3"]) {
      await seedTrace(timelineStore, {
        id,
        situation: `Error in ${id}`,
        unlock: `Fix ${id}`,
        anchor: `src/${id}.ts`,
        tokens: ["shared", id],
      });
    }

    const results = await recallTracesBySymptom(timelineStore, ["shared"], 2);
    expect(results.length).toBeLessThanOrEqual(2);
  });
});

describe("recallTracesBySymptom — anchor-existence staleness gate", () => {
  beforeEach(async () => {
    // Two relevant traces: one live anchor, one deleted anchor.
    await seedTrace(timelineStore, {
      id: "trace-live",
      situation: "Worker pool leak in indexer",
      unlock: "Bound the pool size",
      anchor: "src/live/indexer.ts",
      tokens: ["worker", "pool", "leak"],
    });
    await seedTrace(timelineStore, {
      id: "trace-stale",
      situation: "Worker pool leak in old runner",
      unlock: "Bound the pool size",
      anchor: "src/deleted/runner.ts",
      tokens: ["worker", "pool", "leak"],
    });
    // Disjoint-token trace keeps df < N — a token present in EVERY trace has
    // idf = log(1) = 0 and would drop all candidates below the relevance floor.
    await seedTrace(timelineStore, {
      id: "trace-unrelated",
      situation: "Snapshot checksum mismatch",
      unlock: "Regenerate the snapshot",
      anchor: "src/snapshots/verify.ts",
      tokens: ["snapshot", "checksum", "mismatch"],
    });
  });

  it("drops a trace whose anchor no longer exists", async () => {
    const results = await recallTracesBySymptom(
      timelineStore,
      ["worker", "pool", "leak"],
      3,
      undefined,
      async (anchor) => anchor !== "src/deleted/runner.ts"
    );
    expect(results.map((r) => r.trace_id)).toContain("trace-live");
    expect(results.map((r) => r.trace_id)).not.toContain("trace-stale");
  });

  it("keeps all traces when no checker is provided", async () => {
    const results = await recallTracesBySymptom(
      timelineStore,
      ["worker", "pool", "leak"],
      3
    );
    expect(results.map((r) => r.trace_id)).toContain("trace-live");
    expect(results.map((r) => r.trace_id)).toContain("trace-stale");
  });

  it("fails open when the checker throws", async () => {
    const results = await recallTracesBySymptom(
      timelineStore,
      ["worker", "pool", "leak"],
      3,
      undefined,
      async () => {
        throw new Error("graph rebuilding");
      }
    );
    expect(results.map((r) => r.trace_id)).toContain("trace-live");
    expect(results.map((r) => r.trace_id)).toContain("trace-stale");
  });

  it("keeps anchor-less traces without consulting the checker", async () => {
    await seedTrace(timelineStore, {
      id: "trace-noanchor",
      situation: "Worker pool leak somewhere",
      unlock: "Bound the pool size",
      anchor: "",
      tokens: ["worker", "pool", "leak"],
    });
    const checkedAnchors: string[] = [];
    const results = await recallTracesBySymptom(
      timelineStore,
      ["worker", "pool", "leak"],
      5,
      undefined,
      async (anchor) => {
        checkedAnchors.push(anchor);
        return true;
      }
    );
    expect(results.map((r) => r.trace_id)).toContain("trace-noanchor");
    expect(checkedAnchors).not.toContain("");
  });
});
