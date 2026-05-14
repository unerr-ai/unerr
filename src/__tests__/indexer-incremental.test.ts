/**
 * Sprint K.8: Incremental indexing accuracy tests.
 *
 * Tests entity diffing, cascade invalidation, graph patching,
 * metadata persistence, and snapshot save/load.
 */

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import { bodyHash, entityKey } from "../intelligence/indexer/entity-key.js";
import {
  cascadeInvalidation,
  diffEntities,
  fileNeedsReindex,
} from "../intelligence/indexer/incremental.js";
import {
  loadMetadata,
  fileNeedsReindex as metaNeedsReindex,
  saveMetadata,
  updateFileMetadata,
} from "../intelligence/indexer/metadata.js";
import {
  type IndexedEdge,
  type IndexedEntity,
  registerPlugin,
} from "../intelligence/indexer/plugin-interface.js";
import { typescriptPlugin } from "../intelligence/indexer/plugins/typescript.js";
import {
  hasSnapshot,
  loadSnapshot,
  saveSnapshot,
} from "../intelligence/indexer/snapshot.js";
import { filterIndexableEvents } from "../intelligence/indexer/watch-integration.js";
import {
  clearParserCache,
  parseSource,
} from "../intelligence/tree-sitter-loader.js";

let tempDir: string;

beforeAll(() => {
  registerPlugin(typescriptPlugin);
});

afterAll(() => {
  clearParserCache();
});

beforeEach(() => {
  tempDir = join(
    tmpdir(),
    `unerr-incr-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(tempDir, { recursive: true });
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

function makeEntity(
  name: string,
  bodyContent: string,
  filePath = "test.ts",
): IndexedEntity {
  return {
    key: entityKey(filePath, "function", name, ""),
    kind: "function",
    name,
    file_path: filePath,
    start_line: 1,
    end_line: 5,
    signature: `${name}()`,
    body_hash: bodyHash(bodyContent),
    exported: true,
    parent_key: null,
    language: "typescript",
    is_async: false,
    parameter_count: 0,
    doc: null,
  };
}

describe("Entity Diff (K.1)", () => {
  it("detects added entities", () => {
    const oldEntities: IndexedEntity[] = [];
    const newEntities = [makeEntity("newFn", "return 1;")];

    const diff = diffEntities(oldEntities, newEntities);
    expect(diff.added).toHaveLength(1);
    expect(diff.added[0]!.name).toBe("newFn");
    expect(diff.updated).toHaveLength(0);
    expect(diff.deleted).toHaveLength(0);
  });

  it("detects deleted entities", () => {
    const oldEntities = [makeEntity("oldFn", "return 2;")];
    const newEntities: IndexedEntity[] = [];

    const diff = diffEntities(oldEntities, newEntities);
    expect(diff.deleted).toHaveLength(1);
    expect(diff.deleted[0]!.name).toBe("oldFn");
    expect(diff.added).toHaveLength(0);
  });

  it("detects updated entities (body_hash changed)", () => {
    const old = makeEntity("fn", "return 1;");
    const updated = { ...old, body_hash: bodyHash("return 2;") };

    const diff = diffEntities([old], [updated]);
    expect(diff.updated).toHaveLength(1);
    expect(diff.unchanged).toHaveLength(0);
  });

  it("detects unchanged entities (same body_hash)", () => {
    const entity = makeEntity("fn", "return 42;");

    const diff = diffEntities([entity], [entity]);
    expect(diff.unchanged).toHaveLength(1);
    expect(diff.added).toHaveLength(0);
    expect(diff.updated).toHaveLength(0);
    expect(diff.deleted).toHaveLength(0);
  });

  it("handles complex diff with mixed changes", () => {
    const e1 = makeEntity("keep", "body1");
    const e2 = makeEntity("change", "old_body");
    const e3 = makeEntity("remove", "body3");

    const e2New = { ...e2, body_hash: bodyHash("new_body") };
    const e4 = makeEntity("add", "body4");

    const diff = diffEntities([e1, e2, e3], [e1, e2New, e4]);
    expect(diff.unchanged).toHaveLength(1);
    expect(diff.updated).toHaveLength(1);
    expect(diff.deleted).toHaveLength(1);
    expect(diff.added).toHaveLength(1);
  });
});

describe("Cascade Invalidation (K.2)", () => {
  it("identifies edges affected by changed entities", () => {
    const updated = makeEntity("target", "new body");
    const diff = { added: [], updated: [updated], deleted: [], unchanged: [] };

    const edges: IndexedEdge[] = [
      {
        from_key: "caller",
        to_key: updated.key,
        type: "calls",
        file_path: "a.ts",
        line: 10,
      },
      {
        from_key: updated.key,
        to_key: "callee",
        type: "calls",
        file_path: "test.ts",
        line: 5,
      },
      {
        from_key: "unrelated1",
        to_key: "unrelated2",
        type: "calls",
        file_path: "b.ts",
        line: 1,
      },
    ];

    const result = cascadeInvalidation(diff, edges);
    expect(result.invalidatedEdges).toHaveLength(2);
    expect(result.affectedFiles.has("a.ts")).toBe(true);
    expect(result.affectedFiles.has("test.ts")).toBe(true);
  });
});

describe("File Watch Integration (K.3)", () => {
  it("filters indexable events", () => {
    const events = [
      { type: "create" as const, path: "/repo/src/auth.ts" },
      { type: "update" as const, path: "/repo/src/data.json" },
      { type: "delete" as const, path: "/repo/src/old.ts" },
      { type: "create" as const, path: "/repo/README.md" },
    ];

    const indexable = filterIndexableEvents(events);
    expect(indexable).toContain("/repo/src/auth.ts");
    expect(indexable).toContain("/repo/src/old.ts");
    expect(indexable).not.toContain("/repo/src/data.json");
    expect(indexable).not.toContain("/repo/README.md");
  });
});

describe("Index Metadata (K.6)", () => {
  it("saves and loads metadata", () => {
    const metadata = loadMetadata(tempDir);
    expect(metadata.version).toBe(1);

    updateFileMetadata(metadata, "src/auth.ts", "abc123", 5);
    saveMetadata(tempDir, metadata);

    const loaded = loadMetadata(tempDir);
    expect(loaded.files["src/auth.ts"]).toBeDefined();
    expect(loaded.files["src/auth.ts"]!.hash).toBe("abc123");
    expect(loaded.files["src/auth.ts"]!.entityCount).toBe(5);
  });

  it("detects files needing reindex by hash", () => {
    const metadata = loadMetadata(tempDir);
    updateFileMetadata(metadata, "src/a.ts", "hash1", 3);

    expect(metaNeedsReindex(metadata, "src/a.ts", "hash1")).toBe(false);
    expect(metaNeedsReindex(metadata, "src/a.ts", "hash2")).toBe(true);
    expect(metaNeedsReindex(metadata, "src/new.ts", "hash3")).toBe(true);
  });
});

describe("Index Snapshot (K.7)", () => {
  it("saves and loads snapshot", () => {
    const entities = [makeEntity("fn1", "body1"), makeEntity("fn2", "body2")];
    const edges: IndexedEdge[] = [
      {
        from_key: entities[0]!.key,
        to_key: entities[1]!.key,
        type: "calls",
        file_path: "test.ts",
        line: 3,
      },
    ];
    const metadata = loadMetadata(tempDir);

    saveSnapshot(tempDir, entities, edges, metadata);
    expect(hasSnapshot(tempDir)).toBe(true);

    const snapshot = loadSnapshot(tempDir);
    expect(snapshot).not.toBeNull();
    expect(snapshot!.entities).toHaveLength(2);
    expect(snapshot!.edges).toHaveLength(1);
  });

  it("returns null for missing snapshot", () => {
    expect(loadSnapshot(tempDir)).toBeNull();
    expect(hasSnapshot(tempDir)).toBe(false);
  });
});

describe("Hash Short-Circuit (K.1 + K.6)", () => {
  it("re-index same content produces no mutations", () => {
    const entity = makeEntity("stable", "return 42;");
    expect(fileNeedsReindex([entity], [entity])).toBe(false);
  });

  it("detects change when content differs", () => {
    const old = makeEntity("fn", "return 1;");
    const updated = { ...old, body_hash: bodyHash("return 2;") };
    expect(fileNeedsReindex([old], [updated])).toBe(true);
  });

  it("detects change when entity count differs", () => {
    const e1 = makeEntity("fn1", "body1");
    const e2 = makeEntity("fn2", "body2");
    expect(fileNeedsReindex([e1], [e1, e2])).toBe(true);
  });
});

describe("Tree-sitter Incremental Re-extraction", () => {
  it("produces same keys for unchanged file", async () => {
    const source = `export function greet(name: string): string { return "Hello " + name; }`;
    const tree1 = await parseSource(source, "tree-sitter-typescript.wasm");
    const tree2 = await parseSource(source, "tree-sitter-typescript.wasm");

    const r1 = typescriptPlugin.extract(tree1, "test.ts", source);
    const r2 = typescriptPlugin.extract(tree2, "test.ts", source);

    expect(r1.entities.map((e) => e.key)).toEqual(
      r2.entities.map((e) => e.key),
    );
    expect(r1.entities.map((e) => e.body_hash)).toEqual(
      r2.entities.map((e) => e.body_hash),
    );

    tree1.delete();
    tree2.delete();
  });

  it("detects change when function body changes", async () => {
    const v1 = "export function calc(x: number): number { return x + 1; }";
    const v2 = "export function calc(x: number): number { return x * 2; }";

    const tree1 = await parseSource(v1, "tree-sitter-typescript.wasm");
    const tree2 = await parseSource(v2, "tree-sitter-typescript.wasm");

    const r1 = typescriptPlugin.extract(tree1, "test.ts", v1);
    const r2 = typescriptPlugin.extract(tree2, "test.ts", v2);

    expect(r1.entities[0]!.key).toBe(r2.entities[0]!.key);
    expect(r1.entities[0]!.body_hash).not.toBe(r2.entities[0]!.body_hash);

    const diff = diffEntities(r1.entities, r2.entities);
    expect(diff.updated).toHaveLength(1);
    expect(diff.unchanged).toHaveLength(0);

    tree1.delete();
    tree2.delete();
  });
});
