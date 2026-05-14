/**
 * Sprint 7.1: Git Stash Awareness — save/restore drift overlay on stash/pop.
 *
 * Detects `git stash` and `git stash pop` by watching `.git/refs/stash`.
 * On stash push: serializes drift_overlay + file hashes to `.unerr/drift/stash/{ref}/`.
 * On stash pop: restores overlay from snapshot.
 * Max 10 stash snapshots (LRU eviction).
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
import type { FileHashState } from "./file-hash-state.js";

/** Maximum number of stash snapshots to retain (LRU). */
const MAX_STASH_SNAPSHOTS = 10;

/** Files written per stash snapshot. */
const OVERLAY_FILE = "overlay_snapshot.json";
const HASHES_FILE = "file_hashes.json";

/** stderr logger */
const _log = {
  info: (msg: string) => process.stderr.write(`[unerr:stash] ${msg}\n`),
  warn: (msg: string) => process.stderr.write(`[unerr:stash] WARN: ${msg}\n`),
};

export interface StashSnapshot {
  /** Stash ref SHA at time of save */
  stashRef: string;
  /** Drift overlay entities */
  entities: DriftEntity[];
  /** Drift edges (Task 6.4) */
  edges: DriftEdge[];
  /** File hash state */
  fileHashes: FileHashState;
  /** Timestamp of snapshot */
  savedAt: string;
}

export class StashManager {
  private stashDir: string;
  private gitDir: string;
  private previousStashRef: string | null = null;
  private previousStashCount = 0;

  constructor(
    private unerrDir: string,
    private projectRoot: string,
  ) {
    this.stashDir = join(unerrDir, "drift", "stash");
    this.gitDir = join(projectRoot, ".git");

    // Initialize stash state
    this.previousStashRef = this.readStashRef();
    this.previousStashCount = this.getStashCount();
  }

  /**
   * Check for stash changes. Call this periodically or on file-watcher trigger.
   * Returns "push" if a stash was pushed, "pop" if popped/dropped, null if unchanged.
   */
  detectStashChange(): "push" | "pop" | null {
    const currentRef = this.readStashRef();
    const currentCount = this.getStashCount();

    if (
      currentRef === this.previousStashRef &&
      currentCount === this.previousStashCount
    ) {
      return null;
    }

    let action: "push" | "pop" | null = null;

    if (currentCount > this.previousStashCount) {
      action = "push";
    } else if (currentCount < this.previousStashCount) {
      action = "pop";
    } else if (currentRef !== this.previousStashRef) {
      // Same count but different ref — stash apply or complex operation
      action = null;
    }

    this.previousStashRef = currentRef;
    this.previousStashCount = currentCount;

    return action;
  }

  /**
   * Save the current drift overlay + file hashes as a stash snapshot.
   */
  async saveSnapshot(
    localGraph: CozoGraphStore,
    fileHashState: FileHashState,
  ): Promise<string | null> {
    const stashRef = this.readStashRef();
    if (!stashRef) return null;

    const entities = await localGraph.getAllDriftEntities();
    const edges = await localGraph.getAllDriftEdges();
    if (entities.length === 0 && edges.length === 0) {
      _log.info("No drift entities/edges to snapshot on stash push");
      return null;
    }

    // Use stash ref SHA (truncated) as directory name
    const snapshotId = stashRef.slice(0, 12);
    const snapshotDir = join(this.stashDir, snapshotId);

    if (!existsSync(snapshotDir)) {
      mkdirSync(snapshotDir, { recursive: true });
    }

    const snapshot: StashSnapshot = {
      stashRef,
      entities,
      edges,
      fileHashes: fileHashState,
      savedAt: new Date().toISOString(),
    };

    writeFileSync(
      join(snapshotDir, OVERLAY_FILE),
      JSON.stringify(snapshot, null, 2),
      "utf-8",
    );
    writeFileSync(
      join(snapshotDir, HASHES_FILE),
      JSON.stringify(fileHashState, null, 2),
      "utf-8",
    );

    // Enforce LRU cap
    this.enforceLruCap();

    _log.info(
      `Saved stash snapshot: ${snapshotId} (${entities.length} entities)`,
    );

    return snapshotId;
  }

  /**
   * Restore drift overlay from the most recent stash snapshot.
   * Called on stash pop. Returns the number of entities restored.
   */
  async restoreSnapshot(localGraph: CozoGraphStore): Promise<number> {
    const snapshots = this.listSnapshots();
    if (snapshots.length === 0) {
      _log.info("No stash snapshots to restore");
      return 0;
    }

    // Restore the most recently saved snapshot
    // biome-ignore lint/style/noNonNullAssertion: length > 0 checked above
    const latest = snapshots[0]!;
    const snapshotDir = join(this.stashDir, latest.id);
    const overlayPath = join(snapshotDir, OVERLAY_FILE);

    if (!existsSync(overlayPath)) {
      _log.warn(`Snapshot ${latest.id} missing overlay file`);
      return 0;
    }

    try {
      const raw = readFileSync(overlayPath, "utf-8");
      const snapshot = JSON.parse(raw) as StashSnapshot;

      // Restore entities into drift overlay
      for (const entity of snapshot.entities) {
        await localGraph.upsertDriftEntity(entity);
      }

      // Restore drift edges (Task 6.4)
      if (snapshot.edges) {
        for (const edge of snapshot.edges) {
          await localGraph.upsertDriftEdge(edge);
        }
      }

      // Clean up the snapshot after restore
      rmSync(snapshotDir, { recursive: true, force: true });

      _log.info(
        `Restored stash snapshot: ${latest.id} (${snapshot.entities.length} entities, ${snapshot.edges?.length ?? 0} edges)`,
      );

      return snapshot.entities.length;
    } catch (err) {
      _log.warn(
        `Failed to restore snapshot ${latest.id}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return 0;
    }
  }

  /**
   * Get the file hash state from the most recent stash snapshot.
   * Returns null if no snapshot exists.
   */
  getSnapshotFileHashes(): FileHashState | null {
    const snapshots = this.listSnapshots();
    if (snapshots.length === 0) return null;

    // biome-ignore lint/style/noNonNullAssertion: length > 0 checked above
    const latest = snapshots[0]!;
    const hashesPath = join(this.stashDir, latest.id, HASHES_FILE);

    if (!existsSync(hashesPath)) return null;

    try {
      const raw = readFileSync(hashesPath, "utf-8");
      return JSON.parse(raw) as FileHashState;
    } catch {
      return null;
    }
  }

  /**
   * Remove snapshot for a specific stash ref (on stash drop).
   */
  dropSnapshot(stashRef: string): boolean {
    const snapshotId = stashRef.slice(0, 12);
    const snapshotDir = join(this.stashDir, snapshotId);

    if (!existsSync(snapshotDir)) return false;

    rmSync(snapshotDir, { recursive: true, force: true });
    _log.info(`Dropped stash snapshot: ${snapshotId}`);
    return true;
  }

  /**
   * List all stash snapshots, sorted by most recent first.
   */
  listSnapshots(): Array<{ id: string; savedAt: Date }> {
    if (!existsSync(this.stashDir)) return [];

    try {
      const entries = readdirSync(this.stashDir, { withFileTypes: true });
      const snapshots: Array<{ id: string; savedAt: Date }> = [];

      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const overlayPath = join(this.stashDir, entry.name, OVERLAY_FILE);
        if (!existsSync(overlayPath)) continue;

        try {
          const stat = statSync(overlayPath);
          snapshots.push({ id: entry.name, savedAt: stat.mtime });
        } catch {}
      }

      // Sort by most recent first
      snapshots.sort((a, b) => b.savedAt.getTime() - a.savedAt.getTime());
      return snapshots;
    } catch {
      return [];
    }
  }

  /**
   * Read the current stash ref SHA from `.git/refs/stash`.
   */
  private readStashRef(): string | null {
    const stashPath = join(this.gitDir, "refs", "stash");
    if (!existsSync(stashPath)) return null;

    try {
      return readFileSync(stashPath, "utf-8").trim() || null;
    } catch {
      return null;
    }
  }

  /**
   * Count current stash entries via `.git/logs/refs/stash`.
   */
  private getStashCount(): number {
    const logPath = join(this.gitDir, "logs", "refs", "stash");
    if (!existsSync(logPath)) return 0;

    try {
      const content = readFileSync(logPath, "utf-8");
      return content.split("\n").filter((line) => line.trim().length > 0)
        .length;
    } catch {
      return 0;
    }
  }

  /**
   * Enforce LRU cap — remove oldest snapshots beyond MAX_STASH_SNAPSHOTS.
   */
  private enforceLruCap(): void {
    const snapshots = this.listSnapshots();
    if (snapshots.length <= MAX_STASH_SNAPSHOTS) return;

    const toRemove = snapshots.slice(MAX_STASH_SNAPSHOTS);
    for (const snapshot of toRemove) {
      const dir = join(this.stashDir, snapshot.id);
      rmSync(dir, { recursive: true, force: true });
      _log.info(`LRU evicted stash snapshot: ${snapshot.id}`);
    }
  }
}

/**
 * Start a stash change poller. Calls onPush/onPop when stash state changes.
 * Returns a dispose function to stop polling.
 */
export function startStashPoller(
  stashManager: StashManager,
  onPush: () => void,
  onPop: () => void,
  intervalMs = 3000,
): () => void {
  const timer = setInterval(() => {
    const action = stashManager.detectStashChange();
    if (action === "push") onPush();
    else if (action === "pop") onPop();
  }, intervalMs);

  // Don't prevent process exit
  timer.unref();

  return () => clearInterval(timer);
}
