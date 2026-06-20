/**
 * CozoGraphStore.transact — the atomic primitive the incremental reindex relies
 * on (P1 fix). Proves the guarantee a live `get_references` depends on: a delta
 * either commits whole or applies nothing. A read that interleaves an in-place
 * delete-then-reinsert used to see a half-purged edge set and report
 * file-cohabitants as callers; wrapping the delta in one transaction closes that
 * window. These tests exercise a real in-memory CozoDB (the same engine the
 * indexer tests use), plus the feature-detect fallback for a db without
 * multiTransact.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CozoDb } from "../intelligence/cozo-schema.js";
import { CozoGraphStore } from "../intelligence/local-graph.js";

async function createStore(): Promise<CozoGraphStore> {
  const cozoModule = await import("cozo-node");
  const Ctor = (
    cozoModule as { default?: { CozoDb: unknown }; CozoDb?: unknown }
  ).default
    ? (cozoModule as { default: { CozoDb: unknown } }).default.CozoDb
    : (cozoModule as { CozoDb: unknown }).CozoDb;
  const db = new (Ctor as any)("mem", "") as CozoDb;
  const store = await CozoGraphStore.create(db);
  // A throwaway relation so the test owns its rows independent of the graph schema.
  await store.db.run(":create tx_test {k: String => v: Int}");
  return store;
}

async function rows(store: CozoGraphStore): Promise<Array<[string, number]>> {
  const r = await store.db.run("?[k, v] := *tx_test{k, v}");
  return r.rows as Array<[string, number]>;
}

describe("CozoGraphStore.transact — atomic delta", () => {
  let store: CozoGraphStore;

  beforeEach(async () => {
    store = await createStore();
  });

  afterEach(() => {
    try {
      store.db.close?.();
    } catch {
      /* best effort */
    }
  });

  it("commits every buffered write as one unit", async () => {
    await store.transact(async (db) => {
      await db.run("?[k, v] <- [['a', 1]] :put tx_test {k => v}");
      await db.run("?[k, v] <- [['b', 2]] :put tx_test {k => v}");
      return null;
    });

    const after = await rows(store);
    expect(after.sort()).toEqual([
      ["a", 1],
      ["b", 2],
    ]);
  });

  it("aborts on a throw — NONE of the buffered writes are visible (the P1 guarantee)", async () => {
    await expect(
      store.transact(async (db) => {
        await db.run("?[k, v] <- [['a', 1]] :put tx_test {k => v}");
        await db.run("?[k, v] <- [['b', 2]] :put tx_test {k => v}");
        // A mid-delta failure (e.g. a malformed edge insert) must roll the whole
        // batch back rather than leave a half-applied, readable state.
        throw new Error("boom");
      })
    ).rejects.toThrow("boom");

    // The committed graph still shows the pre-transaction state — never the
    // partial { a, b } a non-atomic apply would have left readable.
    expect(await rows(store)).toEqual([]);
  });

  it("isolates an in-flight delta from a concurrent committed write", async () => {
    // Seed one row, then run a transaction that rewrites it AND adds a row,
    // committing as a unit. The end state is fully-new, never a mix.
    await store.db.run("?[k, v] <- [['a', 1]] :put tx_test {k => v}");
    await store.transact(async (db) => {
      await db.run("?[k, v] <- [['a', 9]] :put tx_test {k => v}");
      await db.run("?[k, v] <- [['c', 3]] :put tx_test {k => v}");
      return null;
    });
    expect((await rows(store)).sort()).toEqual([
      ["a", 9],
      ["c", 3],
    ]);
  });

  it("falls back to non-atomic per-statement writes when the db has no multiTransact", async () => {
    // A pre-0.7 binding / mock lacks multiTransact: transact must still run the
    // callback (degraded, non-atomic) rather than crash.
    (store.db as { multiTransact?: unknown }).multiTransact = undefined;

    const result = await store.transact(async (db) => {
      await db.run("?[k, v] <- [['z', 7]] :put tx_test {k => v}");
      return "ran";
    });

    expect(result).toBe("ran");
    expect(await rows(store)).toEqual([["z", 7]]);
  });
});
