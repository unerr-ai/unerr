/**
 * GraphHolder — infrastructure-error retry (no full-reindex cascade).
 *
 * A DB worker timeout / lock-contention failure during incremental indexing
 * must NOT fall back to a full reindex: that's what turns a transient
 * timeout into a permanent WAL death spiral (238 timeouts + full-reindex
 * fallback observed live). Instead the holder retries incrementally after a
 * delay, keeping the failed files tracked so they aren't lost.
 *
 * A genuine data/logic error must still fall back to a full reindex
 * (existing behavior, regression-checked here).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CozoDb } from "../intelligence/cozo-schema.js";
import { initSchema } from "../intelligence/cozo-schema.js";
import { GraphHolder } from "../intelligence/graph-holder.js";
import { CozoGraphStore } from "../intelligence/local-graph.js";

async function createStore(): Promise<CozoGraphStore> {
  const cozoModule = await import("cozo-node");
  const Ctor = (
    cozoModule as { default?: { CozoDb: unknown }; CozoDb?: unknown }
  ).default
    ? (cozoModule as { default: { CozoDb: unknown } }).default.CozoDb
    : (cozoModule as { CozoDb: unknown }).CozoDb;
  const db = new (Ctor as any)("mem", "") as CozoDb;
  await initSchema(db);
  return CozoGraphStore.create(db);
}

const incrementalResult = () => ({
  filesProcessed: 1,
  filesDeleted: 0,
  entitiesAdded: 0,
  entitiesUpdated: 0,
  entitiesDeleted: 0,
  edgesAdded: 0,
  edgesDeleted: 0,
  elapsedMs: 1,
  annotationsChanged: false,
});

describe("GraphHolder — infrastructure-error retry", () => {
  let store: CozoGraphStore;
  let holder: GraphHolder;
  let fullCalls: number;

  beforeEach(async () => {
    store = await createStore();
    fullCalls = 0;
    holder = new GraphHolder(store, {
      invariantCheckEveryNCycles: 1000,
      fullReindexEveryNCycles: 1000,
      idleThresholdMs: 10_000,
    });
    holder.setRebuildFactory(async () => {
      fullCalls++;
      return {
        graph: store,
        result: {
          entityCount: 0,
          edgeCount: 0,
          fileCount: 0,
          elapsedMs: 1,
          errors: [],
        } as never,
      };
    });
  });

  afterEach(() => {
    holder.dispose();
    vi.useRealTimers();
  });

  it("does not full-reindex on an infra error; re-tracks files and retries after the delay", async () => {
    const receivedArgs: string[][] = [];
    let calls = 0;
    holder.setIncrementalFactory(async (files) => {
      calls++;
      receivedArgs.push(files);
      if (calls === 1) {
        throw new Error("cozo worker request timeout after 120000ms");
      }
      return incrementalResult();
    });

    vi.useFakeTimers();
    holder.notifyFileChange(["/repo/src/x.ts"]);
    holder.forceRebuild();

    // Flush the rejected-promise microtask chain (no real timer involved yet).
    await vi.advanceTimersByTimeAsync(0);

    expect(holder.isRebuilding).toBe(false);
    expect(fullCalls).toBe(0); // no full-reindex fallback
    expect(calls).toBe(1);
    // Failed file stays tracked — not lost.
    expect(holder.pendingChanges).toBe(1);

    // Retry hasn't fired yet at just under the delay.
    await vi.advanceTimersByTimeAsync(59_000);
    expect(calls).toBe(1);

    // Retry fires at the delay and succeeds incrementally.
    await vi.advanceTimersByTimeAsync(1_000);
    expect(calls).toBe(2);
    expect(receivedArgs[1]).toEqual(["/repo/src/x.ts"]);
    expect(fullCalls).toBe(0);
    expect(holder.pendingChanges).toBe(0);
  });

  it("still falls back to a full reindex on a non-infra (data) error", async () => {
    let calls = 0;
    holder.setIncrementalFactory(async () => {
      calls++;
      throw new Error("parse error: unexpected token near line 4");
    });

    holder.notifyFileChange(["/repo/src/y.ts"]);
    holder.forceRebuild();
    for (let i = 0; i < 400 && holder.isRebuilding; i++) {
      await new Promise((r) => setTimeout(r, 5));
    }

    expect(holder.isRebuilding).toBe(false);
    expect(calls).toBe(1);
    expect(fullCalls).toBe(1); // existing fallback behavior preserved
  });
});
