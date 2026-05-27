/**
 * Bug A — startup staleness planner unit tests.
 *
 * `computeIndexPlan` decides, for a populated persistent graph, whether the
 * boot path should skip the reindex, run an incremental pass on the changed
 * files, or fall back to a full rebuild. These tests drive it against a real
 * in-memory CozoDB seeded with `file_content_hashes` rows and a real temp
 * project tree on disk, exercising every branch:
 *   - no baseline hashes → full
 *   - every file matches (hash path + mtime fast-path) → skip
 *   - a content change → incremental, naming the changed file
 *   - a new file → incremental
 *   - a deleted file → incremental, naming the deletion
 *   - a change set over the cap → full
 */
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CozoDb } from "../intelligence/cozo-schema.js";
import { initSchema } from "../intelligence/cozo-schema.js";
import { CozoGraphStore } from "../intelligence/local-graph.js";
import { computeIndexPlan } from "../intelligence/staleness.js";

async function createTestDb(): Promise<CozoDb> {
  const cozoModule = await import("cozo-node");
  const CozoDbConstructor = (
    cozoModule as { default?: { CozoDb: unknown }; CozoDb?: unknown }
  ).default
    ? (cozoModule as { default: { CozoDb: unknown } }).default.CozoDb
    : (cozoModule as { CozoDb: unknown }).CozoDb;
  return new (
    CozoDbConstructor as new (
      engine: string,
      path: string
    ) => CozoDb
  )("mem", "");
}

function sha1(content: string): string {
  return createHash("sha1").update(content).digest("hex");
}

describe("computeIndexPlan (Bug A)", () => {
  let db: CozoDb;
  let store: CozoGraphStore;
  let root: string;

  /** Write a source file and return its relative path + content hash. */
  function writeFile(relPath: string, content: string): string {
    const abs = join(root, relPath);
    mkdirSync(join(abs, ".."), { recursive: true });
    writeFileSync(abs, content, "utf-8");
    return relPath;
  }

  /** Seed a content-hash row. indexedAt defaults to the past (forces hashing). */
  async function seedHash(
    relPath: string,
    hash: string,
    indexedAt = 0
  ): Promise<void> {
    await db.run(
      `?[file_path, content_hash, indexed_at] <- [[$fp, $h, $t]]
       :put file_content_hashes { file_path, content_hash, indexed_at }`,
      { fp: relPath, h: hash, t: indexedAt }
    );
  }

  beforeEach(async () => {
    db = await createTestDb();
    await initSchema(db);
    store = await CozoGraphStore.create(db);
    root = mkdtempSync(join(tmpdir(), "ur-stale-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("returns full when there is no baseline hash table", async () => {
    writeFile("a.ts", "export const a = 1;");
    const plan = await computeIndexPlan(root, store);
    expect(plan.mode).toBe("full");
    expect(plan.storedHashCount).toBe(0);
    expect(plan.reason).toContain("no baseline");
  });

  it("skips when every file matches its stored hash (hash path)", async () => {
    const c1 = "export const a = 1;";
    const c2 = "export function b() {}";
    writeFile("a.ts", c1);
    writeFile("sub/b.ts", c2);
    // indexed_at = 0 (past) forces a real read+hash comparison.
    await seedHash("a.ts", sha1(c1), 0);
    await seedHash("sub/b.ts", sha1(c2), 0);

    const plan = await computeIndexPlan(root, store);
    expect(plan.mode).toBe("skip");
    expect(plan.changedFiles).toEqual([]);
    expect(plan.totalFiles).toBe(2);
    expect(plan.storedHashCount).toBe(2);
  });

  it("skips via the mtime fast-path without re-hashing recent files", async () => {
    // Stored hash is deliberately WRONG, but indexed_at is in the future, so
    // the mtime fast-path must declare the file unchanged without hashing it.
    const c1 = "export const a = 1;";
    writeFile("a.ts", c1);
    await seedHash("a.ts", "deadbeef-not-the-real-hash", Date.now() + 60_000);

    const plan = await computeIndexPlan(root, store);
    expect(plan.mode).toBe("skip");
  });

  it("returns incremental naming a file whose content changed", async () => {
    const stable = "export const stable = 1;";
    writeFile("stable.ts", stable);
    writeFile("drifted.ts", "export const v = 2;"); // on disk: v=2
    await seedHash("stable.ts", sha1(stable), 0);
    await seedHash("drifted.ts", sha1("export const v = 1;"), 0); // recorded: v=1

    const plan = await computeIndexPlan(root, store);
    expect(plan.mode).toBe("incremental");
    expect(plan.changed).toContain("drifted.ts");
    expect(plan.changed).not.toContain("stable.ts");
    expect(plan.changedFiles).toContain("drifted.ts");
  });

  it("treats a new on-disk file (no stored hash) as changed → incremental", async () => {
    const existing = "export const a = 1;";
    writeFile("a.ts", existing);
    writeFile("fresh.ts", "export const fresh = true;"); // never indexed
    await seedHash("a.ts", sha1(existing), 0);

    const plan = await computeIndexPlan(root, store);
    expect(plan.mode).toBe("incremental");
    expect(plan.changed).toContain("fresh.ts");
  });

  it("treats a stored file missing from disk as a deletion → incremental", async () => {
    const existing = "export const a = 1;";
    writeFile("a.ts", existing);
    await seedHash("a.ts", sha1(existing), 0);
    // Recorded last pass but never written to disk this time.
    await seedHash("gone.ts", sha1("export const gone = 1;"), 0);

    const plan = await computeIndexPlan(root, store);
    expect(plan.mode).toBe("incremental");
    expect(plan.deleted).toContain("gone.ts");
    expect(plan.changedFiles).toContain("gone.ts");
  });

  it("falls back to full when the change set exceeds the incremental cap", async () => {
    // 60 files on disk, all drifted vs their stored hash → 60 > cap(50).
    for (let i = 0; i < 60; i++) {
      writeFile(`f${i}.ts`, `export const v${i} = ${i};`);
      await seedHash(`f${i}.ts`, sha1(`OLD-${i}`), 0);
    }
    const plan = await computeIndexPlan(root, store);
    expect(plan.mode).toBe("full");
    expect(plan.changed.length).toBe(60);
  });
});
