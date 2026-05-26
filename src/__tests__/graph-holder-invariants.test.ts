/**
 * FIX D Phase 4 — correctness-driven full-reindex trigger.
 *
 * Two layers of coverage against a real in-memory CozoDB (not a mock):
 *   1. The referential-integrity Datalog queries themselves — clean graph
 *      reports 0 orphans; each injected orphan class is detected. These run
 *      against the real schema (including the edges:rev / file_index:by_entity
 *      indexes), so a syntax/semantics regression fails here.
 *   2. GraphHolder's dispatch — at the invariant-check cadence it stays
 *      incremental on a clean graph and full-reindexes on divergence.
 */

import { beforeEach, describe, expect, it } from "vitest";
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

async function seedEntity(db: CozoDb, key: string): Promise<void> {
  await db.run(
    `?[key, kind, name, file_path] <- [[$key, "function", $key, "src/x.ts"]]
     :put entities {key => kind, name, file_path}`,
    { key }
  );
}
async function seedFileIndex(
  db: CozoDb,
  fp: string,
  entityKey: string
): Promise<void> {
  await db.run(
    "?[file_path, entity_key] <- [[$fp, $k]] :put file_index {file_path, entity_key}",
    { fp, k: entityKey }
  );
}
async function seedEdge(db: CozoDb, from: string, to: string): Promise<void> {
  await db.run(
    `?[from_key, to_key, type] <- [[$f, $t, "calls"]] :put edges {from_key, to_key, type}`,
    { f: from, t: to }
  );
}

// The three invariant queries, mirrored from GraphHolder.verifyGraphInvariants.
const Q_ORPHAN_FILE_INDEX =
  "?[count(entity_key)] := *file_index{entity_key}, not *entities{key: entity_key}";
const Q_ORPHAN_EDGE_TO =
  "?[count(to_key)] := *edges:rev{to_key}, not *entities{key: to_key}";
const Q_ORPHAN_EDGE_FROM =
  "?[count(from_key)] := *edges{from_key}, not *entities{key: from_key}";

async function count(store: CozoGraphStore, q: string): Promise<number> {
  const r = await store.query(q);
  return Number((r.rows[0]?.[0] as number | undefined) ?? 0);
}

describe("Phase 4 — referential-integrity queries", () => {
  let store: CozoGraphStore;
  beforeEach(async () => {
    store = await createStore();
  });

  it("reports zero orphans for a consistent graph", async () => {
    const db = store.db;
    await seedEntity(db, "a");
    await seedEntity(db, "b");
    await seedFileIndex(db, "src/x.ts", "a");
    await seedFileIndex(db, "src/x.ts", "b");
    await seedEdge(db, "a", "b");

    expect(await count(store, Q_ORPHAN_FILE_INDEX)).toBe(0);
    expect(await count(store, Q_ORPHAN_EDGE_TO)).toBe(0);
    expect(await count(store, Q_ORPHAN_EDGE_FROM)).toBe(0);
  });

  it("detects a file_index row pointing to a missing entity", async () => {
    await seedEntity(store.db, "a");
    await seedFileIndex(store.db, "src/x.ts", "ghost");
    expect(await count(store, Q_ORPHAN_FILE_INDEX)).toBe(1);
  });

  it("detects an edge whose to_key has no entity (via edges:rev index)", async () => {
    await seedEntity(store.db, "a");
    await seedEdge(store.db, "a", "ghost");
    expect(await count(store, Q_ORPHAN_EDGE_TO)).toBe(1);
  });

  it("detects an edge whose from_key has no entity", async () => {
    await seedEntity(store.db, "b");
    await seedEdge(store.db, "ghost", "b");
    expect(await count(store, Q_ORPHAN_EDGE_FROM)).toBe(1);
  });
});

describe("Phase 4 — GraphHolder dispatch at the check cadence", () => {
  let store: CozoGraphStore;
  let incrementalCalls: number;
  let fullCalls: number;
  let holder: GraphHolder;

  async function runCycle(): Promise<void> {
    holder.notifyFileChange(["/repo/src/x.ts"]);
    holder.forceRebuild();
    // forceRebuild kicks async work; wait for rebuilding to settle.
    for (let i = 0; i < 400 && holder.isRebuilding; i++) {
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(holder.isRebuilding).toBe(false);
  }

  beforeEach(async () => {
    store = await createStore();
    await seedEntity(store.db, "a");
    await seedFileIndex(store.db, "src/x.ts", "a");
    incrementalCalls = 0;
    fullCalls = 0;

    // Check every cycle; never hit the periodic refresh during the test.
    holder = new GraphHolder(store, {
      invariantCheckEveryNCycles: 1,
      fullReindexEveryNCycles: 1000,
      idleThresholdMs: 10_000,
    });
    holder.setIncrementalFactory(async () => {
      incrementalCalls++;
      return {
        filesProcessed: 1,
        filesDeleted: 0,
        entitiesAdded: 0,
        entitiesUpdated: 0,
        entitiesDeleted: 0,
        edgesAdded: 0,
        edgesDeleted: 0,
        elapsedMs: 1,
      };
    });
    holder.setRebuildFactory(async () => {
      fullCalls++;
      const fresh = await createStore();
      await seedEntity(fresh.db, "a");
      await seedFileIndex(fresh.db, "src/x.ts", "a");
      return {
        graph: fresh,
        result: {
          entityCount: 1,
          edgeCount: 0,
          fileCount: 1,
          elapsedMs: 1,
          errors: [],
        } as never,
      };
    });
  });

  it("stays incremental while the graph is clean", async () => {
    await runCycle(); // cycle 0 → incremental (n: 0→1)
    await runCycle(); // cycle 1 → check passes → incremental (n: 1→2)
    await runCycle(); // cycle 2 → check passes → incremental (n: 2→3)
    expect(incrementalCalls).toBe(3);
    expect(fullCalls).toBe(0);
  });

  it("self-heals a sweepable orphan in place and stays incremental", async () => {
    await runCycle(); // n: 0→1, incremental
    // A valid edge that must SURVIVE the sweep, plus an orphan that must go.
    await seedEntity(store.db, "b");
    await seedFileIndex(store.db, "src/x.ts", "b");
    await seedEdge(store.db, "a", "b"); // valid
    await seedEdge(store.db, "a", "ghost"); // orphan: to_key missing
    expect(await count(store, Q_ORPHAN_EDGE_TO)).toBe(1);

    await runCycle(); // n=1 → check fails → sweep → recheck clean → incremental

    // Swept in place, NOT full-reindexed.
    expect(fullCalls).toBe(0);
    expect(incrementalCalls).toBe(2);
    // Orphan gone, all three invariants clean, valid edge preserved.
    expect(await count(store, Q_ORPHAN_EDGE_TO)).toBe(0);
    expect(await count(store, Q_ORPHAN_EDGE_FROM)).toBe(0);
    expect(await count(store, Q_ORPHAN_FILE_INDEX)).toBe(0);
    const validEdge = await store.query(
      `?[from_key, to_key] := *edges{from_key, to_key, type}, from_key = "a", to_key = "b"`
    );
    expect(validEdge.rows.length).toBe(1);
  });

  it("sweeps every orphan class (edge.to, edge.from, file_index) at once", async () => {
    await runCycle(); // n: 0→1
    await seedEdge(store.db, "a", "ghostTo"); // orphan edge.to
    await seedEdge(store.db, "ghostFrom", "a"); // orphan edge.from
    await seedFileIndex(store.db, "src/x.ts", "ghostIdx"); // orphan file_index
    await runCycle(); // n=1 → check fails → sweep clears all three

    expect(fullCalls).toBe(0);
    expect(incrementalCalls).toBe(2);
    expect(await count(store, Q_ORPHAN_EDGE_TO)).toBe(0);
    expect(await count(store, Q_ORPHAN_EDGE_FROM)).toBe(0);
    expect(await count(store, Q_ORPHAN_FILE_INDEX)).toBe(0);
  });

  it("full-reindexes only when the in-place sweep cannot repair", async () => {
    await runCycle(); // n: 0→1, incremental
    await seedEdge(store.db, "a", "ghost"); // orphan the sweep would fix
    // Simulate the sweep failing (e.g. a wedged write): every write rejects, so
    // orphans survive, the re-check still diverges, and the holder escalates.
    const originalWrite = store.write.bind(store);
    store.write = async () => {
      throw new Error("simulated write failure");
    };
    try {
      await runCycle(); // n=1 → check fails → sweep fails → recheck fails → full reindex
    } finally {
      store.write = originalWrite;
    }
    expect(incrementalCalls).toBe(1);
    expect(fullCalls).toBe(1);
  });
});
