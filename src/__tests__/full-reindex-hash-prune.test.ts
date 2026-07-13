/**
 * Full-reindex hash-row pruning — boot-loop regression.
 *
 * Real production bug: a benchmark harness created `arena-django-*` dirs with
 * Python venvs (~25k indexable files) inside a repo. A full index ran while
 * they existed and seeded `file_content_hashes` rows for all of them. The
 * dirs were later deleted, but `indexLocalProject` never removed the stale
 * rows — only the incremental indexer's per-file `removeFileHash` did. The
 * startup planner (`computeIndexPlan`) then counted ~25k stored-but-missing
 * files as "deleted" on every boot, exceeding the incremental cap and forcing
 * a full reindex forever.
 *
 * These tests exercise the real pipeline against an in-memory CozoDB:
 *   - a full reindex prunes hash rows for files no longer walked, while
 *     keeping correct rows for files that were actually indexed;
 *   - immediately after that reindex, `computeIndexPlan` returns "skip" (the
 *     regression proof — a ghost row no longer inflates the deleted count);
 *   - `pruneStaleFileContentHashes` never removes a row for a path still in
 *     the walked set, even if that file's content couldn't be read this pass
 *     (an unreadable-but-present file must keep its old hash, not be treated
 *     as deleted);
 *   - Python virtualenv trees (`venv/`, `site-packages/`) are excluded from
 *     discovery so they can never seed the bogus rows in the first place.
 */

import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CozoDb } from "../intelligence/cozo-schema.js";
import { initSchema } from "../intelligence/cozo-schema.js";
import { CozoGraphStore } from "../intelligence/local-graph.js";
import {
  discoverSourceFiles,
  indexLocalProject,
  pruneStaleFileContentHashes,
} from "../intelligence/local-indexer.js";
import { computeIndexPlan } from "../intelligence/staleness.js";

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

function sha1(content: string): string {
  return createHash("sha1").update(content).digest("hex");
}

describe("full reindex prunes stale file_content_hashes rows", () => {
  let tempDir: string;
  let store: CozoGraphStore;
  const aContent = "export function a() { return 1; }\n";
  const bContent = "export function b() { return 2; }\n";

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), "unerr-full-prune-"));
    mkdirSync(join(tempDir, "src"), { recursive: true });
    writeFileSync(join(tempDir, "src", "a.ts"), aContent);
    writeFileSync(join(tempDir, "src", "b.ts"), bContent);

    store = await createStore();
    // Ghost row: simulates a stored hash for a file whose containing dir
    // (e.g. a since-deleted `arena-django-*` venv tree) no longer exists.
    await store.write(
      `?[file_path, content_hash, indexed_at] <- [[$fp, $h, $t]]
       :put file_content_hashes { file_path, content_hash, indexed_at }`,
      {
        fp: "gone/ghost.py",
        h: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
        t: 0,
      }
    );

    await indexLocalProject(tempDir, store, "test-repo");
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("removes the ghost row and keeps correct hashes for real files", async () => {
    expect(await getStoredHash(store, "gone/ghost.py")).toBeNull();
    expect(await getStoredHash(store, "src/a.ts")).toBe(sha1(aContent));
    expect(await getStoredHash(store, "src/b.ts")).toBe(sha1(bContent));
  });

  it("computeIndexPlan returns skip right after the reindex (boot-loop regression)", async () => {
    const plan = await computeIndexPlan(tempDir, store);
    expect(plan.mode).toBe("skip");
    expect(plan.deleted).toEqual([]);
  });
});

describe("pruneStaleFileContentHashes", () => {
  it("keeps a row whose path is in keepRelPaths even when the file wasn't re-hashed this pass", async () => {
    const store = await createStore();
    await store.write(
      `?[file_path, content_hash, indexed_at] <- [[$fp, $h, $t]]
       :put file_content_hashes { file_path, content_hash, indexed_at }`,
      {
        fp: "unreadable.ts",
        h: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        t: 0,
      }
    );

    // The file was walked (it's on disk) but its content read failed this
    // pass, so it is absent from the hash map — it must NOT be pruned.
    await pruneStaleFileContentHashes(store, new Set(["unreadable.ts"]));

    expect(await getStoredHash(store, "unreadable.ts")).toBe(
      "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    );
  });

  it("removes a row whose path is absent from keepRelPaths", async () => {
    const store = await createStore();
    await store.write(
      `?[file_path, content_hash, indexed_at] <- [[$fp, $h, $t]]
       :put file_content_hashes { file_path, content_hash, indexed_at }`,
      {
        fp: "gone/ghost.py",
        h: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        t: 0,
      }
    );

    await pruneStaleFileContentHashes(store, new Set(["src/a.ts"]));

    expect(await getStoredHash(store, "gone/ghost.py")).toBeNull();
  });
});

describe("EXCLUDED_DIRS skips Python virtualenv trees", () => {
  let tempDir: string;

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("discoverSourceFiles excludes venv/site-packages but keeps real source", () => {
    tempDir = mkdtempSync(join(tmpdir(), "unerr-venv-exclude-"));
    mkdirSync(
      join(tempDir, "venv", "lib", "python3.11", "site-packages", "pkg"),
      { recursive: true }
    );
    writeFileSync(
      join(
        tempDir,
        "venv",
        "lib",
        "python3.11",
        "site-packages",
        "pkg",
        "mod.py"
      ),
      "x = 1\n"
    );
    mkdirSync(join(tempDir, "src"), { recursive: true });
    writeFileSync(join(tempDir, "src", "app.py"), "print('hi')\n");

    const files = discoverSourceFiles(tempDir).map((f) => relative(tempDir, f));
    expect(files).toEqual(["src/app.py"]);
  });
});
