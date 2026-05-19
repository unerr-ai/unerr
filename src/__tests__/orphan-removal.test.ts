/**
 * SF-1: Batched orphan-removal correctness + performance test.
 *
 * Hits a real in-memory CozoDB instance (not a mock) so we exercise the actual
 * batched `:rm` Datalog syntax. The pre-batch implementation took ~4 minutes for
 * 4525 orphans because it did 5 sequential full-scan deletes per orphan. After
 * batching we expect 5000 orphans to clear in under 2 seconds.
 */

import { beforeEach, describe, expect, it } from "vitest";
import type { CozoDb } from "../intelligence/cozo-schema.js";
import { initSchema } from "../intelligence/cozo-schema.js";
import { CozoGraphStore } from "../intelligence/local-graph.js";
import { removeOrphanedEntities } from "../intelligence/local-indexer.js";

async function createTestDb(): Promise<CozoDb> {
  const cozoModule = await import("cozo-node");
  const CozoDbConstructor = (
    cozoModule as { default?: { CozoDb: unknown }; CozoDb?: unknown }
  ).default
    ? (cozoModule as { default: { CozoDb: unknown } }).default.CozoDb
    : (cozoModule as { CozoDb: unknown }).CozoDb;
  // biome-ignore lint/suspicious/noExplicitAny: cozo-node has no exported types
  return new (CozoDbConstructor as any)("mem", "") as CozoDb;
}

async function seedEntity(db: CozoDb, key: string): Promise<void> {
  await db.run(
    `?[key, kind, name, file_path] <- [[$key, "function", $key, $fp]]
     :put entities {key => kind, name, file_path}`,
    { key, fp: `src/${key}.ts` }
  );
  await db.run(
    `?[file_path, entity_key] <- [[$fp, $key]] :put file_index {file_path, entity_key}`,
    { key, fp: `src/${key}.ts` }
  );
  await db.run(
    `?[token, entity_key] <- [[$tok, $key]] :put search_tokens {token, entity_key}`,
    { key, tok: `tok-${key}` }
  );
}

async function seedEdge(
  db: CozoDb,
  from: string,
  to: string,
  type = "calls"
): Promise<void> {
  await db.run(
    `?[from_key, to_key, type] <- [[$from, $to, $type]]
     :put edges {from_key, to_key, type}`,
    { from, to, type }
  );
}

async function countRows(db: CozoDb, relation: string): Promise<number> {
  const r = await db.run(`?[count(k)] := *${relation}{key: k}`);
  if (r.rows.length === 0) return 0;
  return Number((r.rows[0] as unknown[])[0] ?? 0);
}

async function countEdges(db: CozoDb): Promise<number> {
  const r = await db.run(`?[count(f)] := *edges{from_key: f}`);
  if (r.rows.length === 0) return 0;
  return Number((r.rows[0] as unknown[])[0] ?? 0);
}

async function countByRelation(
  db: CozoDb,
  relation: "search_tokens" | "file_index"
): Promise<number> {
  const col = relation === "search_tokens" ? "token" : "file_path";
  const r = await db.run(`?[count(c)] := *${relation}{${col}: c}`);
  if (r.rows.length === 0) return 0;
  return Number((r.rows[0] as unknown[])[0] ?? 0);
}

describe("removeOrphanedEntities — batched path", () => {
  let db: CozoDb;
  let store: CozoGraphStore;

  beforeEach(async () => {
    db = await createTestDb();
    await initSchema(db);
    store = await CozoGraphStore.create(db);
  });

  it("clears orphans from entities, edges, tokens, file_index in a single batch", async () => {
    await seedEntity(db, "live-1");
    await seedEntity(db, "live-2");
    await seedEntity(db, "orphan-1");
    await seedEntity(db, "orphan-2");
    await seedEdge(db, "live-1", "orphan-1");
    await seedEdge(db, "orphan-1", "live-2");
    await seedEdge(db, "orphan-1", "orphan-2");
    await seedEdge(db, "live-1", "live-2");

    expect(await countRows(db, "entities")).toBe(4);
    expect(await countEdges(db)).toBe(4);

    await removeOrphanedEntities(store, new Set(["live-1", "live-2"]));

    expect(await countRows(db, "entities")).toBe(2);
    // Only the live-1 → live-2 edge remains; the 3 orphan-touching edges are gone.
    expect(await countEdges(db)).toBe(1);
    expect(await countByRelation(db, "search_tokens")).toBe(2);
    expect(await countByRelation(db, "file_index")).toBe(2);
  });

  it("leaves the graph untouched when no orphans exist", async () => {
    await seedEntity(db, "a");
    await seedEntity(db, "b");
    await seedEdge(db, "a", "b");

    await removeOrphanedEntities(store, new Set(["a", "b"]));

    expect(await countRows(db, "entities")).toBe(2);
    expect(await countEdges(db)).toBe(1);
  });

  it("handles 5000 orphans in under 2 seconds", async () => {
    const liveKeys = new Set<string>();
    // 500 live, 5000 orphans
    for (let i = 0; i < 500; i++) {
      const k = `live-${i}`;
      await seedEntity(db, k);
      liveKeys.add(k);
    }
    for (let i = 0; i < 5000; i++) {
      const k = `orphan-${i}`;
      await seedEntity(db, k);
      // One edge per orphan touching a live entity → exercises both
      // out-edge and in-edge deletion paths
      await seedEdge(db, k, `live-${i % 500}`);
    }

    expect(await countRows(db, "entities")).toBe(5500);
    expect(await countEdges(db)).toBe(5000);

    const start = Date.now();
    await removeOrphanedEntities(store, liveKeys);
    const elapsed = Date.now() - start;

    expect(elapsed).toBeLessThan(2000);
    expect(await countRows(db, "entities")).toBe(500);
    expect(await countEdges(db)).toBe(0);
    expect(await countByRelation(db, "search_tokens")).toBe(500);
    expect(await countByRelation(db, "file_index")).toBe(500);
  }, 10_000);

  it("no-ops on a freshly-initialized schema with no entities", async () => {
    await expect(
      removeOrphanedEntities(store, new Set<string>())
    ).resolves.toBeUndefined();
  });
});
