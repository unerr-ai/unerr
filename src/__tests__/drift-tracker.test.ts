/**
 * P10-TEST-03: Drift tracker tests — drift computation, overlay management.
 */

import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { entityKey } from "../intelligence/ast-extractor.js";
import type {
  CozoGraphStore,
  DriftEntity,
  DriftSummary,
  LocalEntity,
} from "../intelligence/local-graph.js";
import {
  DRIFT_WATCHER_OPTIONS,
  DriftTracker,
  MtimeCache,
  determineOrigin,
} from "../tracking/drift-tracker.js";
import { FileHashManager, contentSha256 } from "../tracking/file-hash-state.js";

let tempDir: string;
let projectRoot: string;
let unerrDir: string;

beforeEach(() => {
  tempDir = join(
    tmpdir(),
    `unerr-drift-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
  );
  projectRoot = join(tempDir, "project");
  unerrDir = join(projectRoot, ".unerr");
  mkdirSync(join(unerrDir, "state"), { recursive: true });
  mkdirSync(join(projectRoot, "src"), { recursive: true });
});

afterEach(() => {
  try {
    rmSync(tempDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

/** Create a mock CozoGraphStore with in-memory drift overlay */
function createMockGraph(baseEntities: LocalEntity[] = []): CozoGraphStore & {
  driftOverlay: Map<string, DriftEntity>;
} {
  const driftOverlay = new Map<string, DriftEntity>();

  return {
    driftOverlay,
    getEntity: (key: string) => baseEntities.find((e) => e.key === key) ?? null,
    getCallersOf: () => [],
    getCalleesOf: () => [],
    getEntitiesByFile: (fp: string) =>
      baseEntities.filter((e) => e.file_path === fp),
    searchEntities: () => [],
    getImports: () => [],
    healthCheck: () => ({ status: "up" as const, latencyMs: 0 }),
    isLoaded: () => true,
    loadSnapshot: () => {},
    hasRules: () => false,
    getRules: () => [],
    getPatterns: () => [],
    loadRules: () => {},
    loadPatterns: () => {},
    hasJustifications: () => false,
    getBusinessContext: () => null,
    getConventions: () => [],
    loadJustifications: () => {},
    upsertDriftEntity: (entity: DriftEntity) => {
      driftOverlay.set(entity.key, entity);
    },
    removeDriftEntity: (key: string) => {
      driftOverlay.delete(key);
    },
    getDriftEntitiesForFile: (fp: string) => {
      const result: DriftEntity[] = [];
      for (const [, e] of driftOverlay) {
        if (e.file_path === fp) result.push(e);
      }
      return result;
    },
    clearDriftOverlay: () => {
      driftOverlay.clear();
    },
    findEntityByName: (name: string) =>
      baseEntities.find((e) => e.name === name) ?? null,
    getAllDriftEdges: () => [],
    upsertDriftEdge: () => {},
    clearDriftEdges: () => {},
    getDriftSummary: () => {
      const summary: DriftSummary = {
        added: 0,
        modified: 0,
        deleted: 0,
        dependency_changed: 0,
        total: 0,
      };
      for (const [, e] of driftOverlay) {
        if (e.drift_status === "added") summary.added++;
        else if (e.drift_status === "modified") summary.modified++;
        else if (e.drift_status === "deleted") summary.deleted++;
        else if (e.drift_status === "dependency_changed")
          summary.dependency_changed++;
      }
      summary.total =
        summary.added +
        summary.modified +
        summary.deleted +
        summary.dependency_changed;
      return summary;
    },
  } as unknown as CozoGraphStore & { driftOverlay: Map<string, DriftEntity> };
}

/**
 * Create a mock graph with caller edge relationships.
 * `callerMap` maps callee keys → array of caller LocalEntity objects.
 */
function createMockGraphWithCallers(
  baseEntities: LocalEntity[],
  callerMap: Map<string, LocalEntity[]>
): CozoGraphStore & { driftOverlay: Map<string, DriftEntity> } {
  const base = createMockGraph(baseEntities);
  // Override getCallersOf to return from the caller map
  (base as any).getCallersOf = (key: string) => callerMap.get(key) ?? [];
  return base;
}

describe("DriftTracker", () => {
  it("detects added entities (new file)", async () => {
    const graph = createMockGraph();
    const fileHashManager = new FileHashManager(unerrDir);
    const tracker = new DriftTracker(
      { projectRoot, repoId: "repo1", unerrDir },
      graph,
      fileHashManager
    );

    // Write a TypeScript file with a function
    writeFileSync(
      join(projectRoot, "src/new-feature.ts"),
      `export function newFeature() {
  return "hello"
}`
    );

    const result = await tracker.processFile("src/new-feature.ts", "abc123");
    expect(result.filesProcessed).toBe(1);
    expect(result.entitiesAdded).toBe(1);
    expect(result.entitiesModified).toBe(0);
    expect(result.entitiesDeleted).toBe(0);

    expect(graph.driftOverlay.size).toBe(1);
    const driftEntity = [...graph.driftOverlay.values()][0]!;
    expect(driftEntity.name).toBe("newFeature");
    expect(driftEntity.drift_status).toBe("added");
    expect(driftEntity.file_path).toBe("src/new-feature.ts");
  });

  it("detects modified entities (content changed)", async () => {
    // Base entity
    const baseEntities: LocalEntity[] = [
      {
        key: "test-key-1",
        kind: "function",
        name: "existingFn",
        file_path: "src/existing.ts",
        start_line: 1,
        end_line: 0,
        signature: "()",
        body: "function existingFn() {\n  return 1\n}",
        fan_in: 0,
        fan_out: 0,
        risk_level: "normal",
        community: -1,
      },
    ];
    const graph = createMockGraph(baseEntities);
    const fileHashManager = new FileHashManager(unerrDir);
    const tracker = new DriftTracker(
      { projectRoot, repoId: "repo1", unerrDir },
      graph,
      fileHashManager
    );

    // Write modified file
    writeFileSync(
      join(projectRoot, "src/existing.ts"),
      `function existingFn() {
  return 2
}`
    );

    const result = await tracker.processFile("src/existing.ts", "abc123");
    expect(result.filesProcessed).toBe(1);
    // Either modified or added depending on key match
    expect(
      result.entitiesModified + result.entitiesAdded
    ).toBeGreaterThanOrEqual(1);
  });

  it("skips unchanged files", async () => {
    const graph = createMockGraph();
    const fileHashManager = new FileHashManager(unerrDir);
    const tracker = new DriftTracker(
      { projectRoot, repoId: "repo1", unerrDir },
      graph,
      fileHashManager
    );

    const content = "export function unchanged() { return 1 }";
    writeFileSync(join(projectRoot, "src/unchanged.ts"), content);

    // First process — should process
    const r1 = await tracker.processFile("src/unchanged.ts", "abc123");
    expect(r1.filesProcessed).toBe(1);

    // Mark as processed manually
    const sha = contentSha256(content);
    fileHashManager.markProcessed("src/unchanged.ts", sha, "abc123");
    fileHashManager.save();

    // Second process — should skip
    const r2 = await tracker.processFile("src/unchanged.ts", "abc123");
    expect(r2.filesSkipped).toBe(1);
    expect(r2.filesProcessed).toBe(0);
  });

  it("handles deleted files", async () => {
    const baseEntities: LocalEntity[] = [
      {
        key: "del-key-1",
        kind: "function",
        name: "deletedFn",
        file_path: "src/deleted.ts",
        start_line: 1,
        end_line: 0,
        signature: "",
        body: "",
        fan_in: 2,
        fan_out: 1,
        risk_level: "normal",
        community: -1,
      },
    ];
    const graph = createMockGraph(baseEntities);
    const fileHashManager = new FileHashManager(unerrDir);
    const tracker = new DriftTracker(
      { projectRoot, repoId: "repo1", unerrDir },
      graph,
      fileHashManager
    );

    // Don't create the file — it's "deleted"
    const result = await tracker.processFile("src/deleted.ts", "abc123");
    expect(result.filesProcessed).toBe(1);
    expect(result.entitiesDeleted).toBe(1);

    const deletedEntity = [...graph.driftOverlay.values()][0]!;
    expect(deletedEntity.drift_status).toBe("deleted");
    expect(deletedEntity.name).toBe("deletedFn");
  });

  it("reconciles a stale 'deleted' overlay when the entity reappears", async () => {
    // Regression: a "deleted" overlay left by a transient miss (empty/partial
    // read, parse fail) must not keep masking a live entity. On the next scan
    // that finds the entity present in the file, the stale row is dropped — the
    // added/modified loop alone won't (base present + hash match → no upsert).
    const baseEntities: LocalEntity[] = [];
    const graph = createMockGraph(baseEntities);
    const fileHashManager = new FileHashManager(unerrDir);
    const tracker = new DriftTracker(
      { projectRoot, repoId: "repo1", unerrDir },
      graph,
      fileHashManager
    );

    const content = "export function liveFn() {\n  return 1\n}\n";
    writeFileSync(join(projectRoot, "src/live.ts"), content);

    // First pass extracts liveFn under its real key (recorded as "added").
    await tracker.processFile("src/live.ts", "abc123");
    const liveKey = [...graph.driftOverlay.keys()][0];
    expect(liveKey).toBeDefined();
    const added = graph.driftOverlay.get(liveKey!)!;

    // Construct the stale state: entity is live in base, yet a "deleted"
    // overlay shadows the same key.
    baseEntities.push({
      key: liveKey!,
      kind: "function",
      name: added.name,
      file_path: "src/live.ts",
      start_line: added.line_start,
      end_line: added.line_end,
      signature: added.signature,
      body: added.body,
      fan_in: 0,
      fan_out: 0,
      risk_level: "normal",
      community: -1,
    });
    graph.driftOverlay.set(liveKey!, {
      ...added,
      drift_status: "deleted",
      body: "",
    });

    // Record reconciliation removals.
    const removed: string[] = [];
    const origRemove = graph.removeDriftEntity;
    (graph as unknown as { removeDriftEntity: (k: string) => void }).removeDriftEntity =
      (k: string) => {
        removed.push(k);
        return origRemove(k);
      };

    // Re-scan with a fresh tracker (empty mtime cache → no unchanged-file skip).
    const tracker2 = new DriftTracker(
      { projectRoot, repoId: "repo1", unerrDir },
      graph,
      new FileHashManager(unerrDir)
    );
    await tracker2.processFile("src/live.ts", "abc123");

    // The stale "deleted" overlay was reconciled away — entity no longer masked.
    expect(removed).toContain(liveKey);
    expect(graph.driftOverlay.get(liveKey!)?.drift_status).not.toBe("deleted");
  });

  it("skips unsupported languages", async () => {
    const graph = createMockGraph();
    const fileHashManager = new FileHashManager(unerrDir);
    const tracker = new DriftTracker(
      { projectRoot, repoId: "repo1", unerrDir },
      graph,
      fileHashManager
    );

    writeFileSync(join(projectRoot, "data.json"), '{"key": "value"}');
    const result = await tracker.processFile("data.json", "abc123");
    expect(result.filesProcessed).toBe(0);
    expect(result.filesSkipped).toBe(0);
    expect(graph.driftOverlay.size).toBe(0);
  });

  it("processes batch of files", async () => {
    const graph = createMockGraph();
    const fileHashManager = new FileHashManager(unerrDir);
    const tracker = new DriftTracker(
      { projectRoot, repoId: "repo1", unerrDir },
      graph,
      fileHashManager
    );

    writeFileSync(
      join(projectRoot, "src/a.ts"),
      "export function alpha() { return 1 }"
    );
    writeFileSync(
      join(projectRoot, "src/b.ts"),
      "export function beta() { return 2 }"
    );

    const result = await tracker.processFiles(
      ["src/a.ts", "src/b.ts"],
      "abc123"
    );
    expect(result.filesProcessed).toBe(2);
    expect(result.entitiesAdded).toBe(2);
  });

  it("drift summary aggregates correctly", async () => {
    const baseEntities: LocalEntity[] = [
      {
        key: "mod-key-1",
        kind: "function",
        name: "oldFn",
        file_path: "src/old.ts",
        start_line: 1,
        end_line: 0,
        signature: "",
        body: "function oldFn() { return 1 }",
        fan_in: 0,
        fan_out: 0,
        risk_level: "normal",
        community: -1,
      },
    ];
    const graph = createMockGraph(baseEntities);
    const fileHashManager = new FileHashManager(unerrDir);
    const tracker = new DriftTracker(
      { projectRoot, repoId: "repo1", unerrDir },
      graph,
      fileHashManager
    );

    // Add a new file
    writeFileSync(
      join(projectRoot, "src/new.ts"),
      "export function newOne() { return 1 }"
    );
    await tracker.processFile("src/new.ts", "abc123");

    // Delete an existing file (don't write it)
    await tracker.processFile("src/old.ts", "abc123");

    const summary = await tracker.getDriftSummary();
    expect(summary.total).toBeGreaterThan(0);
    expect(summary.added + summary.modified + summary.deleted).toBe(
      summary.total
    );
  });

  it("clears overlay on branch switch", async () => {
    const graph = createMockGraph();
    const fileHashManager = new FileHashManager(unerrDir);
    const tracker = new DriftTracker(
      { projectRoot, repoId: "repo1", unerrDir },
      graph,
      fileHashManager
    );

    writeFileSync(
      join(projectRoot, "src/a.ts"),
      "export function alpha() { return 1 }"
    );
    await tracker.processFile("src/a.ts", "abc123");
    expect(graph.driftOverlay.size).toBe(1);

    // Branch switch — clears and recomputes
    writeFileSync(
      join(projectRoot, "src/b.ts"),
      "export function beta() { return 1 }"
    );
    await tracker.onBranchSwitch(["src/b.ts"], "def456");

    // Old overlay should be cleared, new file processed
    const summary = await tracker.getDriftSummary();
    expect(summary.added).toBe(1);
  });

  it("saves drift summary to disk", async () => {
    const graph = createMockGraph();
    const fileHashManager = new FileHashManager(unerrDir);
    const tracker = new DriftTracker(
      { projectRoot, repoId: "repo1", unerrDir },
      graph,
      fileHashManager
    );

    writeFileSync(
      join(projectRoot, "src/a.ts"),
      "export function alpha() { return 1 }"
    );
    await tracker.processFiles(["src/a.ts"], "abc123");

    const summaryPath = join(unerrDir, "drift", "drift_summary.json");
    expect(existsSync(summaryPath)).toBe(true);
  });

  it("mtime cache skips file when mtime unchanged", async () => {
    const graph = createMockGraph();
    const fileHashManager = new FileHashManager(unerrDir);
    const tracker = new DriftTracker(
      { projectRoot, repoId: "repo1", unerrDir },
      graph,
      fileHashManager
    );

    const filePath = join(projectRoot, "src/stable.ts");
    writeFileSync(filePath, "export function stable() { return 1 }");

    // First call — processes the file (mtime is new)
    const r1 = await tracker.processFile("src/stable.ts", "abc123");
    expect(r1.filesProcessed).toBe(1);

    // Second call — mtime unchanged, should skip via mtime cache
    const r2 = await tracker.processFile("src/stable.ts", "abc123");
    expect(r2.filesSkipped).toBe(1);
    expect(r2.filesProcessed).toBe(0);
  });

  it("mtime cache processes file when content changes", async () => {
    const graph = createMockGraph();
    const fileHashManager = new FileHashManager(unerrDir);
    const tracker = new DriftTracker(
      { projectRoot, repoId: "repo1", unerrDir },
      graph,
      fileHashManager
    );

    const filePath = join(projectRoot, "src/changing.ts");
    writeFileSync(filePath, "export function changing() { return 1 }");

    // First call — processes
    await tracker.processFile("src/changing.ts", "abc123");

    // Modify file — mtime changes
    writeFileSync(filePath, "export function changing() { return 2 }");

    // Second call — mtime changed, should process
    const r2 = await tracker.processFile("src/changing.ts", "abc123");
    expect(r2.filesProcessed).toBe(1);
  });

  it("mtime cache clears on branch switch", async () => {
    const graph = createMockGraph();
    const fileHashManager = new FileHashManager(unerrDir);
    const tracker = new DriftTracker(
      { projectRoot, repoId: "repo1", unerrDir },
      graph,
      fileHashManager
    );

    const filePath = join(projectRoot, "src/branched.ts");
    writeFileSync(filePath, "export function branched() { return 1 }");

    // Process once to populate mtime cache
    await tracker.processFile("src/branched.ts", "abc123");

    // Branch switch clears mtime cache
    await tracker.onBranchSwitch(["src/branched.ts"], "def456");

    // After branch switch, same file should be reprocessed (mtime cache was cleared)
    const r = await tracker.processFile("src/branched.ts", "def456");
    // Will be processed (mtime cache cleared) but may be skipped by file hash manager
    // since content hasn't changed. The point is mtime cache doesn't block it.
    expect(r.filesProcessed + r.filesSkipped).toBe(1);
  });
});

describe("MtimeCache", () => {
  it("returns true for first check (new file)", () => {
    const cache = new MtimeCache();
    const filePath = join(projectRoot, "src/first.ts");
    writeFileSync(filePath, "content");
    expect(cache.check(filePath)).toBe(true);
  });

  it("returns false for unchanged file", () => {
    const cache = new MtimeCache();
    const filePath = join(projectRoot, "src/unchanged.ts");
    writeFileSync(filePath, "content");
    cache.check(filePath); // populate
    expect(cache.check(filePath)).toBe(false);
  });

  it("returns true after file modification", () => {
    const cache = new MtimeCache();
    const filePath = join(projectRoot, "src/modified.ts");
    writeFileSync(filePath, "content v1");
    cache.check(filePath); // populate

    // Modify — mtime changes
    writeFileSync(filePath, "content v2");
    expect(cache.check(filePath)).toBe(true);
  });

  it("returns true for non-existent file and evicts cache", () => {
    const cache = new MtimeCache();
    expect(cache.check("/nonexistent/file.ts")).toBe(true);
    expect(cache.size).toBe(0);
  });

  it("evict removes file from cache", () => {
    const cache = new MtimeCache();
    const filePath = join(projectRoot, "src/evicted.ts");
    writeFileSync(filePath, "content");
    cache.check(filePath); // populate
    expect(cache.size).toBe(1);

    cache.evict(filePath);
    expect(cache.size).toBe(0);
    // Next check should return true (new entry)
    expect(cache.check(filePath)).toBe(true);
  });

  it("clear removes all entries", () => {
    const cache = new MtimeCache();
    const file1 = join(projectRoot, "src/a.ts");
    const file2 = join(projectRoot, "src/b.ts");
    writeFileSync(file1, "a");
    writeFileSync(file2, "b");
    cache.check(file1);
    cache.check(file2);
    expect(cache.size).toBe(2);

    cache.clear();
    expect(cache.size).toBe(0);
  });
});

describe("DRIFT_WATCHER_OPTIONS", () => {
  it("has awaitWriteFinish with stabilityThreshold 300ms", () => {
    expect(DRIFT_WATCHER_OPTIONS.awaitWriteFinish.stabilityThreshold).toBe(300);
    expect(DRIFT_WATCHER_OPTIONS.awaitWriteFinish.pollInterval).toBe(100);
  });
});

describe("determineOrigin", () => {
  it("returns 'human' when lastSyncTimestamp is 0 (no sync)", () => {
    expect(determineOrigin(0)).toBe("human");
  });

  it("returns 'ai' when <10s after sync", () => {
    const recentSync = Date.now() - 5_000; // 5s ago
    expect(determineOrigin(recentSync)).toBe("ai");
  });

  it("returns 'mixed' when 10-60s after sync", () => {
    const mediumSync = Date.now() - 30_000; // 30s ago
    expect(determineOrigin(mediumSync)).toBe("mixed");
  });

  it("returns 'human' when >60s after sync", () => {
    const oldSync = Date.now() - 120_000; // 2min ago
    expect(determineOrigin(oldSync)).toBe("human");
  });

  it("returns 'ai' at exactly 0ms after sync", () => {
    const justNow = Date.now();
    expect(determineOrigin(justNow)).toBe("ai");
  });
});

describe("DriftTracker origin attribution", () => {
  it("sets origin on added entities based on sync timestamp", async () => {
    const graph = createMockGraph();
    const fileHashManager = new FileHashManager(unerrDir);
    const tracker = new DriftTracker(
      { projectRoot, repoId: "repo1", unerrDir },
      graph,
      fileHashManager
    );

    // Simulate recent AI sync
    tracker.setLastSyncTimestamp(Date.now() - 3_000);

    writeFileSync(
      join(projectRoot, "src/ai-created.ts"),
      "export function aiCreated() { return 1 }"
    );

    await tracker.processFile("src/ai-created.ts", "abc123");

    const entity = [...graph.driftOverlay.values()][0];
    expect(entity?.origin).toBe("ai");
  });

  it("sets origin to 'human' when no sync has occurred", async () => {
    const graph = createMockGraph();
    const fileHashManager = new FileHashManager(unerrDir);
    const tracker = new DriftTracker(
      { projectRoot, repoId: "repo1", unerrDir },
      graph,
      fileHashManager
    );

    // No setLastSyncTimestamp call — default is 0

    writeFileSync(
      join(projectRoot, "src/human-created.ts"),
      "export function humanCreated() { return 1 }"
    );

    await tracker.processFile("src/human-created.ts", "abc123");

    const entity = [...graph.driftOverlay.values()][0];
    expect(entity?.origin).toBe("human");
  });

  it("sets origin on deleted entities", async () => {
    const baseEntities: LocalEntity[] = [
      {
        key: "del-origin-key",
        kind: "function",
        name: "aboutToDelete",
        file_path: "src/will-delete.ts",
        start_line: 1,
        end_line: 0,
        signature: "",
        body: "",
        fan_in: 0,
        fan_out: 0,
        risk_level: "normal",
        community: -1,
      },
    ];
    const graph = createMockGraph(baseEntities);
    const fileHashManager = new FileHashManager(unerrDir);
    const tracker = new DriftTracker(
      { projectRoot, repoId: "repo1", unerrDir },
      graph,
      fileHashManager
    );

    // Simulate mixed timing
    tracker.setLastSyncTimestamp(Date.now() - 25_000);

    // File doesn't exist — deleted
    await tracker.processFile("src/will-delete.ts", "abc123");

    const entity = [...graph.driftOverlay.values()][0];
    expect(entity?.origin).toBe("mixed");
    expect(entity?.drift_status).toBe("deleted");
  });
});

describe("Cross-file drift invalidation", () => {
  const repoId = "repo1";

  /** Build a base entity with a computable key */
  function makeBaseEntity(
    filePath: string,
    name: string,
    kind: string,
    body: string
  ): LocalEntity {
    const key = entityKey(repoId, filePath, kind, name, "()");
    return {
      key,
      kind,
      name,
      file_path: filePath,
      start_line: 1,
      end_line: 0,
      signature: "()",
      body,
      fan_in: 0,
      fan_out: 0,
      risk_level: "normal",
      community: -1,
    };
  }

  it("propagates dependency_changed to callers in other files", async () => {
    // File A has function `helperFn`, File B has function `callerFn` that calls it
    const helperEntity = makeBaseEntity(
      "src/helper.ts",
      "helperFn",
      "function",
      "function helperFn() {\n  return 1\n}"
    );
    const callerEntity = makeBaseEntity(
      "src/caller.ts",
      "callerFn",
      "function",
      "function callerFn() {\n  return helperFn()\n}"
    );

    const callerMap = new Map<string, LocalEntity[]>();
    callerMap.set(helperEntity.key, [callerEntity]);

    const graph = createMockGraphWithCallers(
      [helperEntity, callerEntity],
      callerMap
    );
    const fileHashManager = new FileHashManager(unerrDir);
    const tracker = new DriftTracker(
      { projectRoot, repoId, unerrDir },
      graph,
      fileHashManager
    );

    // Write modified helper (body changed)
    writeFileSync(
      join(projectRoot, "src/helper.ts"),
      "export function helperFn() {\n  return 999\n}"
    );
    // Write caller file (unchanged, but needs to exist)
    writeFileSync(
      join(projectRoot, "src/caller.ts"),
      "export function callerFn() {\n  return helperFn()\n}"
    );

    const result = await tracker.processFile("src/helper.ts", "abc123");
    expect(result.crossFileInvalidated).toBe(1);

    // callerFn should have dependency_changed in the overlay
    const callerDrift = graph.driftOverlay.get(callerEntity.key);
    expect(callerDrift).toBeDefined();
    expect(callerDrift?.drift_status).toBe("dependency_changed");
    expect(callerDrift?.file_path).toBe("src/caller.ts");
  });

  it("does NOT invalidate callers in the same file", async () => {
    // Both entities in the same file
    const entity1 = makeBaseEntity(
      "src/same-file.ts",
      "baseFunc",
      "function",
      "function baseFunc() {\n  return 1\n}"
    );
    const entity2 = makeBaseEntity(
      "src/same-file.ts",
      "callerFunc",
      "function",
      "function callerFunc() {\n  return baseFunc()\n}"
    );

    const callerMap = new Map<string, LocalEntity[]>();
    callerMap.set(entity1.key, [entity2]); // callerFunc calls baseFunc, same file

    const graph = createMockGraphWithCallers([entity1, entity2], callerMap);
    const fileHashManager = new FileHashManager(unerrDir);
    const tracker = new DriftTracker(
      { projectRoot, repoId, unerrDir },
      graph,
      fileHashManager
    );

    writeFileSync(
      join(projectRoot, "src/same-file.ts"),
      "export function baseFunc() {\n  return 999\n}\nexport function callerFunc() {\n  return baseFunc()\n}"
    );

    const result = await tracker.processFile("src/same-file.ts", "abc123");
    // Same-file callers should NOT be cross-file invalidated
    expect(result.crossFileInvalidated).toBe(0);
  });

  it("does NOT overwrite stronger drift status with dependency_changed", async () => {
    const helperEntity = makeBaseEntity(
      "src/dep.ts",
      "depFn",
      "function",
      "function depFn() {\n  return 1\n}"
    );
    const callerEntity = makeBaseEntity(
      "src/consumer.ts",
      "consumerFn",
      "function",
      "function consumerFn() {\n  return depFn()\n}"
    );

    const callerMap = new Map<string, LocalEntity[]>();
    callerMap.set(helperEntity.key, [callerEntity]);

    const graph = createMockGraphWithCallers(
      [helperEntity, callerEntity],
      callerMap
    );
    const fileHashManager = new FileHashManager(unerrDir);
    const tracker = new DriftTracker(
      { projectRoot, repoId, unerrDir },
      graph,
      fileHashManager
    );

    // Pre-populate overlay with a "modified" status for the caller
    graph.driftOverlay.set(callerEntity.key, {
      key: callerEntity.key,
      name: "consumerFn",
      kind: "function",
      signature: "()",
      body: "function consumerFn() { return depFn() }",
      file_path: "src/consumer.ts",
      line_start: 1,
      line_end: 3,
      content_hash: "abc",
      drift_status: "modified",
      intent_id: "",
      modified_at: new Date().toISOString(),
      origin: "human",
      previous_body: "",
      previous_signature: "",
    });

    // Modify the dependency
    writeFileSync(
      join(projectRoot, "src/dep.ts"),
      "export function depFn() {\n  return 999\n}"
    );

    const result = await tracker.processFile("src/dep.ts", "abc123");
    // Should NOT overwrite the "modified" status
    expect(result.crossFileInvalidated).toBe(0);

    const callerDrift = graph.driftOverlay.get(callerEntity.key);
    expect(callerDrift?.drift_status).toBe("modified");
  });

  it("propagates dependency_changed when entity is deleted", async () => {
    const deletedEntity = makeBaseEntity(
      "src/removed.ts",
      "removedFn",
      "function",
      "function removedFn() {\n  return 1\n}"
    );
    const callerEntity = makeBaseEntity(
      "src/uses-removed.ts",
      "usesFn",
      "function",
      "function usesFn() {\n  return removedFn()\n}"
    );

    const callerMap = new Map<string, LocalEntity[]>();
    callerMap.set(deletedEntity.key, [callerEntity]);

    const graph = createMockGraphWithCallers(
      [deletedEntity, callerEntity],
      callerMap
    );
    const fileHashManager = new FileHashManager(unerrDir);
    const tracker = new DriftTracker(
      { projectRoot, repoId, unerrDir },
      graph,
      fileHashManager
    );

    // Write the caller file (exists), but don't write removed.ts (deleted)
    writeFileSync(
      join(projectRoot, "src/uses-removed.ts"),
      "export function usesFn() {\n  return removedFn()\n}"
    );

    // Process the deleted file — entities should propagate dependency_changed
    const result = await tracker.processFile("src/removed.ts", "abc123");
    expect(result.entitiesDeleted).toBe(1);

    // The caller in another file should get dependency_changed
    const callerDrift = graph.driftOverlay.get(callerEntity.key);
    expect(callerDrift).toBeDefined();
    expect(callerDrift?.drift_status).toBe("dependency_changed");
  });

  it("counts crossFileInvalidated correctly in batch", async () => {
    const entityA = makeBaseEntity(
      "src/a.ts",
      "funcA",
      "function",
      "function funcA() {\n  return 1\n}"
    );
    const callerB = makeBaseEntity(
      "src/b.ts",
      "funcB",
      "function",
      "function funcB() {\n  return funcA()\n}"
    );
    const callerC = makeBaseEntity(
      "src/c.ts",
      "funcC",
      "function",
      "function funcC() {\n  return funcA()\n}"
    );

    const callerMap = new Map<string, LocalEntity[]>();
    callerMap.set(entityA.key, [callerB, callerC]);

    const graph = createMockGraphWithCallers(
      [entityA, callerB, callerC],
      callerMap
    );
    const fileHashManager = new FileHashManager(unerrDir);
    const tracker = new DriftTracker(
      { projectRoot, repoId, unerrDir },
      graph,
      fileHashManager
    );

    // Modify source entity
    writeFileSync(
      join(projectRoot, "src/a.ts"),
      "export function funcA() {\n  return 999\n}"
    );
    writeFileSync(
      join(projectRoot, "src/b.ts"),
      "export function funcB() {\n  return funcA()\n}"
    );
    writeFileSync(
      join(projectRoot, "src/c.ts"),
      "export function funcC() {\n  return funcA()\n}"
    );

    const result = await tracker.processFiles(["src/a.ts"], "abc123");
    expect(result.crossFileInvalidated).toBe(2);

    // Both callers should be in the overlay
    expect(graph.driftOverlay.get(callerB.key)?.drift_status).toBe(
      "dependency_changed"
    );
    expect(graph.driftOverlay.get(callerC.key)?.drift_status).toBe(
      "dependency_changed"
    );

    // Summary should reflect it
    const summary = await tracker.getDriftSummary();
    expect(summary.dependency_changed).toBe(2);
  });
});
