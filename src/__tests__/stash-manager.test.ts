/**
 * Sprint 7.1: Git stash awareness tests.
 */

import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type {
  CozoGraphStore,
  DriftEntity,
} from "../intelligence/local-graph.js";
import type { FileHashState } from "../tracking/file-hash-state.js";
import { StashManager } from "../tracking/stash-manager.js";

/** Minimal mock CozoGraphStore backed by a Map for drift overlay. */
function createMockGraph(
  driftEntities: DriftEntity[] = [],
): CozoGraphStore & { entities: Map<string, DriftEntity> } {
  const entities = new Map<string, DriftEntity>();
  for (const e of driftEntities) {
    entities.set(e.key, e);
  }

  return {
    entities,
    getAllDriftEntities: () => [...entities.values()],
    getAllDriftEdges: () => [],
    upsertDriftEntity: (entity: DriftEntity) => {
      entities.set(entity.key, entity);
    },
    upsertDriftEdge: () => {},
    removeDriftEntity: (key: string) => {
      entities.delete(key);
    },
    clearDriftOverlay: () => {
      entities.clear();
    },
  } as unknown as CozoGraphStore & { entities: Map<string, DriftEntity> };
}

function makeDrift(
  overrides: Partial<DriftEntity> & { key: string; name: string },
): DriftEntity {
  return {
    kind: "function",
    signature: "()",
    body: "function test() {}",
    file_path: "src/test.ts",
    line_start: 1,
    line_end: 3,
    content_hash: "abc123",
    drift_status: "modified",
    intent_id: "",
    modified_at: new Date().toISOString(),
    origin: "human",
    previous_body: "",
    previous_signature: "",
    ...overrides,
  };
}

function setupProjectWithGit(): {
  projectRoot: string;
  unerrDir: string;
  gitDir: string;
} {
  const projectRoot = mkdtempSync(join(tmpdir(), "stash-"));
  const unerrDir = join(projectRoot, ".unerr");
  const gitDir = join(projectRoot, ".git");

  mkdirSync(unerrDir, { recursive: true });
  mkdirSync(join(gitDir, "refs"), { recursive: true });
  mkdirSync(join(gitDir, "logs", "refs"), { recursive: true });

  return { projectRoot, unerrDir, gitDir };
}

function writeStashRef(gitDir: string, ref: string): void {
  writeFileSync(join(gitDir, "refs", "stash"), `${ref}\n`, "utf-8");
}

function writeStashLog(gitDir: string, count: number): void {
  const lines = Array.from(
    { length: count },
    (_, i) =>
      `0000000 abcdef${i} Author <a@b.com> ${Date.now()} +0000\tstash@{${i}}: WIP`,
  );
  writeFileSync(
    join(gitDir, "logs", "refs", "stash"),
    `${lines.join("\n")}\n`,
    "utf-8",
  );
}

const MOCK_FILE_HASHES: FileHashState = {
  files: {
    "src/test.ts": {
      contentSha: "sha256abc",
      headSha: "head123",
      processedAt: new Date().toISOString(),
    },
  },
};

describe("StashManager", () => {
  it("detects no change when stash ref unchanged", () => {
    const { projectRoot, unerrDir, gitDir } = setupProjectWithGit();
    writeStashRef(gitDir, "abc123def456");
    writeStashLog(gitDir, 1);

    const manager = new StashManager(unerrDir, projectRoot);
    expect(manager.detectStashChange()).toBeNull();
  });

  it("detects stash push when count increases", () => {
    const { projectRoot, unerrDir, gitDir } = setupProjectWithGit();
    writeStashRef(gitDir, "ref1");
    writeStashLog(gitDir, 1);

    const manager = new StashManager(unerrDir, projectRoot);

    // Simulate stash push
    writeStashRef(gitDir, "ref2");
    writeStashLog(gitDir, 2);

    expect(manager.detectStashChange()).toBe("push");
  });

  it("detects stash pop when count decreases", () => {
    const { projectRoot, unerrDir, gitDir } = setupProjectWithGit();
    writeStashRef(gitDir, "ref1");
    writeStashLog(gitDir, 2);

    const manager = new StashManager(unerrDir, projectRoot);

    // Simulate stash pop
    writeStashRef(gitDir, "ref0");
    writeStashLog(gitDir, 1);

    expect(manager.detectStashChange()).toBe("pop");
  });

  it("saves and restores a stash snapshot", async () => {
    const { projectRoot, unerrDir, gitDir } = setupProjectWithGit();
    writeStashRef(gitDir, "abc123def456abc123def456abc123def456abc1");
    writeStashLog(gitDir, 1);

    const entities = [
      makeDrift({ key: "k1", name: "fn1", drift_status: "modified" }),
      makeDrift({ key: "k2", name: "fn2", drift_status: "added" }),
    ];
    const graph = createMockGraph(entities);
    const manager = new StashManager(unerrDir, projectRoot);

    // Save snapshot
    const snapshotId = await manager.saveSnapshot(graph, MOCK_FILE_HASHES);
    expect(snapshotId).toBe("abc123def456");

    // Clear overlay to simulate stash applying
    graph.entities.clear();
    expect(graph.getAllDriftEntities()).toHaveLength(0);

    // Restore snapshot
    const restored = await manager.restoreSnapshot(graph);
    expect(restored).toBe(2);
    expect(graph.entities.size).toBe(2);
    expect(graph.entities.get("k1")?.name).toBe("fn1");
    expect(graph.entities.get("k2")?.name).toBe("fn2");
  });

  it("returns null when saving with no drift entities", async () => {
    const { projectRoot, unerrDir, gitDir } = setupProjectWithGit();
    writeStashRef(gitDir, "abc123def456");

    const graph = createMockGraph([]);
    const manager = new StashManager(unerrDir, projectRoot);

    const snapshotId = await manager.saveSnapshot(graph, MOCK_FILE_HASHES);
    expect(snapshotId).toBeNull();
  });

  it("returns null when saving with no stash ref", async () => {
    const { projectRoot, unerrDir } = setupProjectWithGit();

    const graph = createMockGraph([makeDrift({ key: "k1", name: "fn1" })]);
    const manager = new StashManager(unerrDir, projectRoot);

    const snapshotId = await manager.saveSnapshot(graph, MOCK_FILE_HASHES);
    expect(snapshotId).toBeNull();
  });

  it("restores 0 when no snapshots exist", async () => {
    const { projectRoot, unerrDir } = setupProjectWithGit();
    const graph = createMockGraph([]);
    const manager = new StashManager(unerrDir, projectRoot);

    expect(await manager.restoreSnapshot(graph)).toBe(0);
  });

  it("drops a specific snapshot", async () => {
    const { projectRoot, unerrDir, gitDir } = setupProjectWithGit();
    const fullRef = "abc123def456abc123def456abc123def456abc1";
    writeStashRef(gitDir, fullRef);

    const graph = createMockGraph([makeDrift({ key: "k1", name: "fn1" })]);
    const manager = new StashManager(unerrDir, projectRoot);
    await manager.saveSnapshot(graph, MOCK_FILE_HASHES);

    expect(manager.listSnapshots()).toHaveLength(1);
    expect(manager.dropSnapshot(fullRef)).toBe(true);
    expect(manager.listSnapshots()).toHaveLength(0);
  });

  it("enforces LRU cap of 10 snapshots", async () => {
    const { projectRoot, unerrDir, gitDir } = setupProjectWithGit();
    const graph = createMockGraph([makeDrift({ key: "k1", name: "fn1" })]);
    const manager = new StashManager(unerrDir, projectRoot);

    // Create 12 snapshots
    for (let i = 0; i < 12; i++) {
      const ref = `ref${String(i).padStart(12, "0")}aaaaaaaaaaaaaaaa`;
      writeStashRef(gitDir, ref);
      await manager.saveSnapshot(graph, MOCK_FILE_HASHES);
    }

    // Should be capped at 10
    expect(manager.listSnapshots().length).toBeLessThanOrEqual(10);
  });

  it("retrieves file hash state from snapshot", async () => {
    const { projectRoot, unerrDir, gitDir } = setupProjectWithGit();
    writeStashRef(gitDir, "abc123def456abc1");

    const graph = createMockGraph([makeDrift({ key: "k1", name: "fn1" })]);
    const manager = new StashManager(unerrDir, projectRoot);
    await manager.saveSnapshot(graph, MOCK_FILE_HASHES);

    const hashes = manager.getSnapshotFileHashes();
    expect(hashes).not.toBeNull();
    expect(hashes?.files["src/test.ts"]?.contentSha).toBe("sha256abc");
  });

  it("cleans up snapshot after restore", async () => {
    const { projectRoot, unerrDir, gitDir } = setupProjectWithGit();
    writeStashRef(gitDir, "abc123def456abc1");

    const graph = createMockGraph([makeDrift({ key: "k1", name: "fn1" })]);
    const manager = new StashManager(unerrDir, projectRoot);
    await manager.saveSnapshot(graph, MOCK_FILE_HASHES);

    expect(manager.listSnapshots()).toHaveLength(1);

    graph.entities.clear();
    await manager.restoreSnapshot(graph);

    // Snapshot should be cleaned up after restore
    expect(manager.listSnapshots()).toHaveLength(0);
  });

  it("handles stash push → pop cycle preserving overlay", async () => {
    const { projectRoot, unerrDir, gitDir } = setupProjectWithGit();

    const originalEntities = [
      makeDrift({
        key: "k1",
        name: "handler",
        drift_status: "modified",
        body: "function handler() { return 42; }",
        previous_body: "function handler() { return 0; }",
      }),
    ];
    const graph = createMockGraph(originalEntities);

    // Initial state: 1 stash
    writeStashRef(gitDir, "stashref1aaa");
    writeStashLog(gitDir, 0);

    const manager = new StashManager(unerrDir, projectRoot);

    // Simulate stash push
    writeStashRef(gitDir, "stashref2bbb");
    writeStashLog(gitDir, 1);
    expect(manager.detectStashChange()).toBe("push");
    await manager.saveSnapshot(graph, MOCK_FILE_HASHES);

    // Clear overlay (simulating git stash restoring working tree)
    graph.entities.clear();
    expect(graph.getAllDriftEntities()).toHaveLength(0);

    // Simulate stash pop
    writeStashRef(gitDir, "stashref1aaa");
    writeStashLog(gitDir, 0);
    expect(manager.detectStashChange()).toBe("pop");
    const restored = await manager.restoreSnapshot(graph);

    expect(restored).toBe(1);
    const entity = graph.entities.get("k1");
    expect(entity).toBeDefined();
    expect(entity?.name).toBe("handler");
    expect(entity?.drift_status).toBe("modified");
    expect(entity?.body).toBe("function handler() { return 42; }");
    expect(entity?.previous_body).toBe("function handler() { return 0; }");
  });
});
