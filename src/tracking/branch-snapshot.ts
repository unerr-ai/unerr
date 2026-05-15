/**
 * Sprint 6.2: Per-Branch Overlay Snapshots — save/restore drift state on branch switch.
 *
 * On branch switch from A → B:
 *   1. SAVE: Serialize drift_overlay + file hashes → .unerr/drift/branches/{A}/
 *   2. CLEAR CozoDB drift_overlay + file hashes + mtime cache
 *   3. RESTORE: If branches/{B}/ snapshot exists, bulk insert back (<10ms)
 *              Else compute from scratch (first visit)
 *
 * Max 20 branch snapshots stored (LRU eviction).
 * Branches deleted from git are garbage-collected.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type {
  CozoGraphStore,
  DriftEdge,
  DriftEntity,
} from "../intelligence/local-graph.js";
import { listBranches } from "../utils/git.js";
import { createModuleLogger } from "../utils/logger.js";
import type { FileHashState } from "./file-hash-state.js";

/** Maximum number of branch snapshots to retain (LRU). */
const MAX_BRANCH_SNAPSHOTS = 20;

const OVERLAY_FILE = "overlay_snapshot.json";
const HASHES_FILE = "file_hashes.json";

const log = createModuleLogger("branch");

export interface BranchSnapshot {
  /** Branch name at time of save */
  branch: string;
  /** Drift overlay entities */
  entities: DriftEntity[];
  /** Drift edges (Task 6.4) */
  edges: DriftEdge[];
  /** File hash state */
  fileHashes: FileHashState;
  /** Timestamp of snapshot */
  savedAt: string;
}

/**
 * Sanitize branch name for use as a directory name.
 * Replaces `/` with `__` and strips unsafe chars.
 */
function sanitizeBranchName(branch: string): string {
  return branch.replace(/\//g, "__").replace(/[^a-zA-Z0-9_.\-]/g, "_");
}

export class BranchSnapshotManager {
  private branchDir: string;
  private projectRoot: string;

  constructor(unerrDir: string, projectRoot: string) {
    this.branchDir = join(unerrDir, "drift", "branches");
    this.projectRoot = projectRoot;
  }

  /**
   * Save the current drift overlay + file hashes for a branch.
   * Called before clearing overlay on branch switch (save outgoing branch).
   */
  async saveSnapshot(
    branch: string,
    localGraph: CozoGraphStore,
    fileHashState: FileHashState
  ): Promise<boolean> {
    const entities = await localGraph.getAllDriftEntities();
    const edges = await localGraph.getAllDriftEdges();
    if (entities.length === 0 && edges.length === 0) {
      log.info(`No drift entities/edges to snapshot for branch ${branch}`);
      // Still save empty snapshot so we know we visited this branch
      // (avoids recompute on return if there truly was no drift)
    }

    const dirName = sanitizeBranchName(branch);
    const snapshotDir = join(this.branchDir, dirName);

    if (!existsSync(snapshotDir)) {
      mkdirSync(snapshotDir, { recursive: true });
    }

    const snapshot: BranchSnapshot = {
      branch,
      entities,
      edges,
      fileHashes: fileHashState,
      savedAt: new Date().toISOString(),
    };

    writeFileSync(
      join(snapshotDir, OVERLAY_FILE),
      JSON.stringify(snapshot, null, 2),
      "utf-8"
    );
    writeFileSync(
      join(snapshotDir, HASHES_FILE),
      JSON.stringify(fileHashState, null, 2),
      "utf-8"
    );

    // Enforce LRU cap
    this.enforceLruCap();

    log.info(
      `Saved branch snapshot: ${branch} (${entities.length} entities, ${edges.length} edges)`
    );

    return true;
  }

  /**
   * Restore drift overlay from a branch snapshot.
   * Returns the snapshot if found, null if this is a first visit.
   */
  async restoreSnapshot(
    branch: string,
    localGraph: CozoGraphStore
  ): Promise<BranchSnapshot | null> {
    const dirName = sanitizeBranchName(branch);
    const snapshotDir = join(this.branchDir, dirName);
    const overlayPath = join(snapshotDir, OVERLAY_FILE);

    if (!existsSync(overlayPath)) {
      log.info(`No snapshot for branch ${branch} — first visit`);
      return null;
    }

    try {
      const raw = readFileSync(overlayPath, "utf-8");
      const snapshot = JSON.parse(raw) as BranchSnapshot;

      // Bulk insert entities back into drift overlay
      for (const entity of snapshot.entities) {
        await localGraph.upsertDriftEntity(entity);
      }

      // Bulk insert edges back into drift_edges (Task 6.4)
      if (snapshot.edges) {
        for (const edge of snapshot.edges) {
          await localGraph.upsertDriftEdge(edge);
        }
      }

      // Touch the snapshot dir to update LRU ordering
      const now = new Date();
      writeFileSync(
        join(snapshotDir, ".last_access"),
        now.toISOString(),
        "utf-8"
      );

      log.info(
        `Restored branch snapshot: ${branch} (${snapshot.entities.length} entities, ${snapshot.edges?.length ?? 0} edges)`
      );

      return snapshot;
    } catch (err) {
      log.warn(
        `Failed to restore snapshot for ${branch}: ${err instanceof Error ? err.message : String(err)}`
      );
      return null;
    }
  }

  /**
   * Check if a snapshot exists for a given branch.
   */
  hasSnapshot(branch: string): boolean {
    const dirName = sanitizeBranchName(branch);
    return existsSync(join(this.branchDir, dirName, OVERLAY_FILE));
  }

  /**
   * Get the file hash state from a branch snapshot.
   */
  getSnapshotFileHashes(branch: string): FileHashState | null {
    const dirName = sanitizeBranchName(branch);
    const hashesPath = join(this.branchDir, dirName, HASHES_FILE);

    if (!existsSync(hashesPath)) return null;

    try {
      const raw = readFileSync(hashesPath, "utf-8");
      return JSON.parse(raw) as FileHashState;
    } catch {
      return null;
    }
  }

  /**
   * Delete snapshot for a specific branch.
   */
  deleteSnapshot(branch: string): boolean {
    const dirName = sanitizeBranchName(branch);
    const snapshotDir = join(this.branchDir, dirName);

    if (!existsSync(snapshotDir)) return false;

    rmSync(snapshotDir, { recursive: true, force: true });
    log.info(`Deleted branch snapshot: ${branch}`);
    return true;
  }

  /**
   * Garbage-collect snapshots for branches that no longer exist in git.
   */
  async garbageCollect(): Promise<number> {
    if (!existsSync(this.branchDir)) return 0;

    const gitBranches = new Set(await listBranches(this.projectRoot));
    if (gitBranches.size === 0) return 0;

    const snapshots = this.listSnapshots();
    let removed = 0;

    for (const snapshot of snapshots) {
      if (!gitBranches.has(snapshot.branch)) {
        const snapshotDir = join(this.branchDir, snapshot.id);
        rmSync(snapshotDir, { recursive: true, force: true });
        log.info(`GC removed snapshot for deleted branch: ${snapshot.branch}`);
        removed++;
      }
    }

    return removed;
  }

  /**
   * List all branch snapshots, sorted by most recently accessed first.
   */
  listSnapshots(): Array<{
    id: string;
    branch: string;
    accessedAt: Date;
  }> {
    if (!existsSync(this.branchDir)) return [];

    try {
      const entries = readdirSync(this.branchDir, { withFileTypes: true });
      const snapshots: Array<{
        id: string;
        branch: string;
        accessedAt: Date;
      }> = [];

      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const overlayPath = join(this.branchDir, entry.name, OVERLAY_FILE);
        if (!existsSync(overlayPath)) continue;

        try {
          const raw = readFileSync(overlayPath, "utf-8");
          const snapshot = JSON.parse(raw) as BranchSnapshot;

          // Use .last_access if available, else overlay file mtime
          const accessPath = join(this.branchDir, entry.name, ".last_access");
          let accessedAt: Date;
          if (existsSync(accessPath)) {
            accessedAt = statSync(accessPath).mtime;
          } else {
            accessedAt = statSync(overlayPath).mtime;
          }

          snapshots.push({
            id: entry.name,
            branch: snapshot.branch,
            accessedAt,
          });
        } catch {
          // Skip corrupt snapshots
        }
      }

      snapshots.sort((a, b) => b.accessedAt.getTime() - a.accessedAt.getTime());
      return snapshots;
    } catch {
      return [];
    }
  }

  /**
   * Enforce LRU cap — remove oldest snapshots beyond MAX_BRANCH_SNAPSHOTS.
   */
  private enforceLruCap(): void {
    const snapshots = this.listSnapshots();
    if (snapshots.length <= MAX_BRANCH_SNAPSHOTS) return;

    const toRemove = snapshots.slice(MAX_BRANCH_SNAPSHOTS);
    for (const snapshot of toRemove) {
      const dir = join(this.branchDir, snapshot.id);
      rmSync(dir, { recursive: true, force: true });
      log.info(`LRU evicted branch snapshot: ${snapshot.branch}`);
    }
  }
}
