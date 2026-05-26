/**
 * FIX D Phase 3 — content-hash early cutoff in indexFilesIncremental.
 *
 * Exercises the real pipeline against an in-memory CozoDB (real schema,
 * including the file_content_hashes relation) and files on disk:
 *   - a successful index stores a per-file content hash;
 *   - re-indexing byte-identical content is a no-op;
 *   - the cutoff actually SKIPS extraction (a stale-but-present graph is
 *     trusted, not re-reconciled) — proven by a partially-deleted entity
 *     that is NOT restored on an unchanged re-index;
 *   - the fileHasEntities guard bypasses the cutoff when the graph lost
 *     all of the file's entities, so the file recovers;
 *   - changed content re-indexes despite a stored hash;
 *   - deleting a file drops its hash row.
 */

import { createHash } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CozoDb } from "../intelligence/cozo-schema.js";
import { initSchema } from "../intelligence/cozo-schema.js";
import { indexFilesIncremental } from "../intelligence/incremental-indexer.js";
import { CozoGraphStore } from "../intelligence/local-graph.js";
import { seedFileContentHashes } from "../intelligence/local-indexer.js";

const REPO_ID = "testrepo";

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

async function countEntities(
  store: CozoGraphStore,
  fp: string
): Promise<number> {
  const r = await store.db.run(
    "?[count(key)] := *file_index{file_path: $fp, entity_key: key}",
    { fp }
  );
  return Number((r.rows[0]?.[0] as number | undefined) ?? 0);
}

async function getStoredHash(
  store: CozoGraphStore,
  fp: string
): Promise<string | null> {
  const r = await store.db.run(
    "?[content_hash] := *file_content_hashes{file_path: $fp, content_hash}",
    { fp }
  );
  return (r.rows[0]?.[0] as string | undefined) ?? null;
}

async function keyByName(
  store: CozoGraphStore,
  fp: string,
  name: string
): Promise<string | null> {
  const r = await store.db.run(
    `?[key] := *file_index{file_path: $fp, entity_key: key},
       *entities{key, name: $name}`,
    { fp, name }
  );
  return (r.rows[0]?.[0] as string | undefined) ?? null;
}

describe("FIX D Phase 3 — content-hash early cutoff", () => {
  let tempDir: string;
  let store: CozoGraphStore;

  beforeEach(async () => {
    tempDir = join(
      tmpdir(),
      `unerr-hash-${Date.now()}-${Math.random().toString(36).slice(2)}`
    );
    mkdirSync(tempDir, { recursive: true });
    store = await createStore();
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("stores a content hash after a successful index", async () => {
    writeFileSync(
      join(tempDir, "foo.ts"),
      "export function foo() { return 1; }\nexport function bar() { return 2; }\n"
    );
    const r = await indexFilesIncremental(tempDir, ["foo.ts"], store, REPO_ID);

    expect(r.filesProcessed).toBe(1);
    expect(r.entitiesAdded).toBeGreaterThan(0);
    expect(await getStoredHash(store, "foo.ts")).not.toBeNull();
  });

  it("re-indexing byte-identical content mutates nothing", async () => {
    const body =
      "export function foo() { return 1; }\nexport function bar() { return 2; }\n";
    writeFileSync(join(tempDir, "foo.ts"), body);
    await indexFilesIncremental(tempDir, ["foo.ts"], store, REPO_ID);

    const r = await indexFilesIncremental(tempDir, ["foo.ts"], store, REPO_ID);
    expect(r.filesProcessed).toBe(1);
    expect(r.entitiesAdded).toBe(0);
    expect(r.entitiesUpdated).toBe(0);
    expect(r.entitiesDeleted).toBe(0);
  });

  it("skips extraction on a hash hit — a stale-but-present graph is trusted", async () => {
    writeFileSync(
      join(tempDir, "foo.ts"),
      "export function foo() { return 1; }\nexport function bar() { return 2; }\n"
    );
    await indexFilesIncremental(tempDir, ["foo.ts"], store, REPO_ID);
    expect(await countEntities(store, "foo.ts")).toBe(2);

    // Delete ONLY bar from the graph, leaving foo (so fileHasEntities holds)
    // and the hash row untouched. The file on disk is unchanged.
    const barKey = await keyByName(store, "foo.ts", "bar");
    expect(barKey).not.toBeNull();
    await store.write("?[key] <- [[$k]] :rm entities { key }", { k: barKey });
    await store.write(
      "?[file_path, entity_key] <- [[$fp, $k]] :rm file_index { file_path, entity_key }",
      { fp: "foo.ts", k: barKey }
    );
    expect(await countEntities(store, "foo.ts")).toBe(1);

    // Re-index unchanged: the cutoff fires, so bar is NOT restored.
    const r = await indexFilesIncremental(tempDir, ["foo.ts"], store, REPO_ID);
    expect(r.entitiesAdded).toBe(0);
    expect(await countEntities(store, "foo.ts")).toBe(1);
    expect(await keyByName(store, "foo.ts", "bar")).toBeNull();
  });

  it("bypasses the cutoff when the graph lost all of the file's entities", async () => {
    writeFileSync(
      join(tempDir, "foo.ts"),
      "export function foo() { return 1; }\nexport function bar() { return 2; }\n"
    );
    await indexFilesIncremental(tempDir, ["foo.ts"], store, REPO_ID);

    // Wipe every entity + file_index row for the file, but keep the hash.
    await store.write(
      "?[key] := *file_index{file_path: $fp, entity_key: key} :rm entities { key }",
      { fp: "foo.ts" }
    );
    await store.write(
      "?[file_path, entity_key] := *file_index{file_path, entity_key}, file_path = $fp :rm file_index { file_path, entity_key }",
      { fp: "foo.ts" }
    );
    expect(await countEntities(store, "foo.ts")).toBe(0);
    expect(await getStoredHash(store, "foo.ts")).not.toBeNull();

    // fileHasEntities is now false → cutoff skipped → file recovers.
    const r = await indexFilesIncremental(tempDir, ["foo.ts"], store, REPO_ID);
    expect(r.entitiesAdded).toBeGreaterThan(0);
    expect(await countEntities(store, "foo.ts")).toBe(2);
  });

  it("re-indexes when content changes despite a stored hash", async () => {
    const fp = join(tempDir, "foo.ts");
    writeFileSync(fp, "export function foo() { return 1; }\n");
    await indexFilesIncremental(tempDir, ["foo.ts"], store, REPO_ID);
    const hash1 = await getStoredHash(store, "foo.ts");

    writeFileSync(
      fp,
      "export function foo() { return 1; }\nexport function baz() { return 3; }\n"
    );
    const r = await indexFilesIncremental(tempDir, ["foo.ts"], store, REPO_ID);

    expect(r.entitiesAdded).toBeGreaterThan(0);
    expect(await countEntities(store, "foo.ts")).toBe(2);
    const hash2 = await getStoredHash(store, "foo.ts");
    expect(hash2).not.toBeNull();
    expect(hash2).not.toBe(hash1);
  });

  it("drops the content hash when the file is deleted", async () => {
    const fp = join(tempDir, "foo.ts");
    writeFileSync(fp, "export function foo() { return 1; }\n");
    await indexFilesIncremental(tempDir, ["foo.ts"], store, REPO_ID);
    expect(await getStoredHash(store, "foo.ts")).not.toBeNull();

    unlinkSync(fp);
    const r = await indexFilesIncremental(tempDir, ["foo.ts"], store, REPO_ID);

    expect(r.filesDeleted).toBe(1);
    expect(await getStoredHash(store, "foo.ts")).toBeNull();
  });

  // Regression: deleting a file must also remove edges incident to its
  // `file:<path>` module entity (file→file `imports`, file→entity
  // `contains`). The code-entity removal alone leaves those dangling, which
  // trips the Phase-4 referential-integrity check into a needless full reindex.
  it("removes edges incident to the file entity on delete", async () => {
    const db = store.db;
    // Seed a graph shape that a full index produces: two file entities, one
    // code entity in a.ts, a file→file import, and a file→entity contains edge.
    await db.run(
      `?[key, kind, name, file_path] <- [
         ["file:a.ts", "module", "a.ts", "a.ts"],
         ["file:b.ts", "module", "b.ts", "b.ts"],
         ["code:fnA", "function", "fnA", "a.ts"]
       ] :put entities {key => kind, name, file_path}`
    );
    await db.run(
      `?[file_path, entity_key] <- [["a.ts", "code:fnA"]] :put file_index {file_path, entity_key}`
    );
    await db.run(
      `?[from_key, to_key, type] <- [
         ["file:a.ts", "file:b.ts", "imports"],
         ["file:a.ts", "code:fnA", "contains"]
       ] :put edges {from_key, to_key, type}`
    );

    // a.ts is absent from disk → delete path. (tempDir has no a.ts.)
    await indexFilesIncremental(tempDir, ["a.ts"], store, REPO_ID);

    const ents = await db.run("?[key] := *entities{key}");
    const keys = ents.rows.map((r) => r[0] as string);
    expect(keys).not.toContain("file:a.ts");
    expect(keys).not.toContain("code:fnA");
    expect(keys).toContain("file:b.ts"); // unrelated file entity survives

    // The file→file import edge must be gone (no dangling reference to file:a.ts).
    const orphanFrom = await db.run(
      "?[count(from_key)] := *edges{from_key}, not *entities{key: from_key}"
    );
    const orphanTo = await db.run(
      "?[count(to_key)] := *edges{to_key}, not *entities{key: to_key}"
    );
    expect(Number(orphanFrom.rows[0]?.[0] ?? -1)).toBe(0);
    expect(Number(orphanTo.rows[0]?.[0] ?? -1)).toBe(0);
  });

  // FIX D Phase 1 — getFileEdgeKeysBatched scoping.
  // Re-indexing a file (triggered by adding a sibling entity) must NOT drop the
  // edge types the incremental path can't re-insert for unchanged entities:
  //   - `contains` (file→entity) is re-inserted by updateFileIndexBatched for
  //     added/updated entities ONLY, never for unchanged ones;
  //   - `tests` / `co_changes` are full-index-only and never re-inserted here.
  // Before the fix, getFileEdgeKeysBatched collected ALL out-edge types and the
  // removal nuked these; they were then permanently lost. The keep[]-set now
  // scopes removal to calls/imports/extends/implements (re-insertable types).
  it("preserves contains/tests/co_changes for unchanged entities on re-index", async () => {
    const db = store.db;
    writeFileSync(
      join(tempDir, "foo.ts"),
      "export function helper() { return 1; }\nexport function alpha() { return 2; }\n"
    );
    await indexFilesIncremental(tempDir, ["foo.ts"], store, REPO_ID);
    expect(await countEntities(store, "foo.ts")).toBe(2);

    // Seed the file: module entity so its contains edges aren't orphaned at
    // baseline (a full index creates this row; the incremental path does not).
    await db.run(
      `?[key, kind, name, file_path] <- [["file:foo.ts", "module", "foo.ts", "foo.ts"]]
       :put entities {key => kind, name, file_path}`
    );

    const helperKey = await keyByName(store, "foo.ts", "helper");
    const alphaKey = await keyByName(store, "foo.ts", "alpha");
    expect(helperKey).not.toBeNull();
    expect(alphaKey).not.toBeNull();

    // Seed full-index-only out-edges on the unchanged entities (valid endpoints).
    await db.run(
      `?[from_key, to_key, type] <- [
         [$h, $a, "tests"],
         [$a, $h, "co_changes"]
       ] :put edges {from_key, to_key, type}`,
      { h: helperKey, a: alphaKey }
    );

    const edgeExists = async (from: string, to: string, type: string) => {
      const r = await db.run(
        "?[from_key] := *edges{from_key, to_key, type}, from_key = $f, to_key = $t, type = $ty",
        { f: from, t: to, ty: type }
      );
      return r.rows.length > 0;
    };

    // Baseline: the seeded + natural edges all present.
    expect(
      await edgeExists(helperKey as string, alphaKey as string, "tests")
    ).toBe(true);
    expect(
      await edgeExists(alphaKey as string, helperKey as string, "co_changes")
    ).toBe(true);
    expect(
      await edgeExists("file:foo.ts", helperKey as string, "contains")
    ).toBe(true);
    expect(
      await edgeExists("file:foo.ts", alphaKey as string, "contains")
    ).toBe(true);

    // Append a NEW entity → forces a diff (added=[gamma]); helper & alpha keep
    // their keys + start_lines, so they are UNCHANGED (not in updated/deleted).
    writeFileSync(
      join(tempDir, "foo.ts"),
      "export function helper() { return 1; }\nexport function alpha() { return 2; }\nexport function gamma() { return 9; }\n"
    );
    const r = await indexFilesIncremental(tempDir, ["foo.ts"], store, REPO_ID);
    expect(r.entitiesAdded).toBe(1); // gamma only

    // Preserved: scoped removal excludes these types for the unchanged entities.
    expect(
      await edgeExists(helperKey as string, alphaKey as string, "tests")
    ).toBe(true);
    expect(
      await edgeExists(alphaKey as string, helperKey as string, "co_changes")
    ).toBe(true);
    expect(
      await edgeExists("file:foo.ts", helperKey as string, "contains")
    ).toBe(true);
    expect(
      await edgeExists("file:foo.ts", alphaKey as string, "contains")
    ).toBe(true);

    // No orphans introduced by the re-index.
    const orphanFrom = await db.run(
      "?[count(from_key)] := *edges{from_key}, not *entities{key: from_key}"
    );
    const orphanTo = await db.run(
      "?[count(to_key)] := *edges{to_key}, not *entities{key: to_key}"
    );
    expect(Number(orphanFrom.rows[0]?.[0] ?? -1)).toBe(0);
    expect(Number(orphanTo.rows[0]?.[0] ?? -1)).toBe(0);
  });

  // FIX D Phase 1 — the flip side: a STALE calls out-edge of an unchanged
  // entity (e.g. a callee that re-keyed away in another file) MUST be removed
  // by getFileEdgeKeysBatched on the next re-index. Before the fix the query
  // threw eval::unbound_symb_in_head, was swallowed, returned empty, and the
  // stale edge leaked forever (the live +N/-0 edge bloat + chronic orphans).
  it("removes a stale calls out-edge of an unchanged entity on re-index", async () => {
    const db = store.db;
    writeFileSync(
      join(tempDir, "foo.ts"),
      "export function alpha() { return 1; }\n"
    );
    await indexFilesIncremental(tempDir, ["foo.ts"], store, REPO_ID);
    await db.run(
      `?[key, kind, name, file_path] <- [["file:foo.ts", "module", "foo.ts", "foo.ts"]]
       :put entities {key => kind, name, file_path}`
    );

    const alphaKey = await keyByName(store, "foo.ts", "alpha");
    expect(alphaKey).not.toBeNull();

    // Seed a stale calls edge to a target that no longer exists (orphan to-side).
    await db.run(
      `?[from_key, to_key, type] <- [[$a, "ghost:gone", "calls"]] :put edges {from_key, to_key, type}`,
      { a: alphaKey }
    );
    const staleBefore = await db.run(
      '?[from_key] := *edges{from_key, to_key: "ghost:gone", type: "calls"}, from_key = $a',
      { a: alphaKey }
    );
    expect(staleBefore.rows.length).toBe(1);

    // Append gamma → forces a diff (added), alpha stays unchanged → the ONLY
    // removal path that can touch alpha's out-edges is getFileEdgeKeysBatched.
    writeFileSync(
      join(tempDir, "foo.ts"),
      "export function alpha() { return 1; }\nexport function gamma() { return 9; }\n"
    );
    await indexFilesIncremental(tempDir, ["foo.ts"], store, REPO_ID);

    // Stale calls edge removed; no orphaned edges remain.
    const staleAfter = await db.run(
      '?[from_key] := *edges{from_key, to_key: "ghost:gone", type: "calls"}, from_key = $a',
      { a: alphaKey }
    );
    expect(staleAfter.rows.length).toBe(0);
    const orphanTo = await db.run(
      "?[count(to_key)] := *edges{to_key}, not *entities{key: to_key}"
    );
    expect(Number(orphanTo.rows[0]?.[0] ?? -1)).toBe(0);
  });

  // Fix 2: a full reindex must seed file_content_hashes (via
  // seedFileContentHashes) so the cutoff fires on the FIRST incremental touch
  // afterward. Without the seed, the hash table is empty post-reindex and every
  // cycle re-extracts. Proven the same way as the cutoff test above: a
  // stale-but-present graph is trusted when a seeded hash matches.
  it("a full-index hash seed lets the next incremental cycle take the cutoff", async () => {
    writeFileSync(
      join(tempDir, "foo.ts"),
      "export function foo() { return 1; }\nexport function bar() { return 2; }\n"
    );
    await indexFilesIncremental(tempDir, ["foo.ts"], store, REPO_ID);
    expect(await countEntities(store, "foo.ts")).toBe(2);

    // Simulate a full reindex: clear the hash, then re-seed via the helper the
    // indexer now calls (Phase 6.4) with the same sha1(content) the cutoff uses.
    await store.write(
      "?[file_path] <- [[$fp]] :rm file_content_hashes { file_path }",
      { fp: "foo.ts" }
    );
    expect(await getStoredHash(store, "foo.ts")).toBeNull();
    const body = readFileSync(join(tempDir, "foo.ts"), "utf-8");
    const expected = createHash("sha1").update(body).digest("hex");
    await seedFileContentHashes(store, new Map([["foo.ts", expected]]));
    expect(await getStoredHash(store, "foo.ts")).toBe(expected);

    // Delete bar from the graph (graph still has foo, so fileHasEntities holds).
    const barKey = await keyByName(store, "foo.ts", "bar");
    expect(barKey).not.toBeNull();
    await store.write("?[key] <- [[$k]] :rm entities { key }", { k: barKey });
    await store.write(
      "?[file_path, entity_key] <- [[$fp, $k]] :rm file_index { file_path, entity_key }",
      { fp: "foo.ts", k: barKey }
    );
    expect(await countEntities(store, "foo.ts")).toBe(1);

    // Unchanged re-index: the SEEDED hash matches → cutoff fires → bar NOT
    // restored (extraction was skipped).
    const r = await indexFilesIncremental(tempDir, ["foo.ts"], store, REPO_ID);
    expect(r.entitiesAdded).toBe(0);
    expect(await countEntities(store, "foo.ts")).toBe(1);
    expect(await keyByName(store, "foo.ts", "bar")).toBeNull();
  });
});
