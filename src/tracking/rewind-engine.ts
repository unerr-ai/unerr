/**
 * Sprint 10.2: Deterministic Rewind — `unerr_revert_to_working_state` MCP tool.
 *
 * Wraps offline-rewind.ts with working snapshot targeting.
 * The MCP tool accepts either a snapshot ID or "latest" to rewind to.
 *
 * Design authority: Phase 5.5 §1.3 (Deterministic Rewind)
 */

import type { CozoGraphStore } from "../intelligence/local-graph.js";
import { checkoutFile, getChangedFiles } from "../utils/git.js";
import { createModuleLogger } from "../utils/logger.js";
import { type OfflineRewindResult, offlineRewind } from "./offline-rewind.js";
import type { ShadowLedger } from "./shadow-ledger.js";
import type {
  WorkingSnapshot,
  WorkingSnapshotStore,
} from "./working-snapshots.js";

const log = createModuleLogger("rewind");

export interface RewindRequest {
  /** Snapshot ID to rewind to, or "latest" */
  snapshotId: string;
  /** Working directory (repo root) */
  cwd: string;
  /** Path to .unerr directory */
  unerrDir: string;
  /** CozoDB local graph */
  graph: CozoGraphStore;
  /** Shadow ledger */
  ledger: ShadowLedger;
  /** Working snapshot store */
  snapshotStore: WorkingSnapshotStore;
  /** If true, only compute blast radius without applying changes */
  dryRun?: boolean;
}

export interface RewindResult {
  /** Whether the rewind succeeded */
  success: boolean;
  /** Snapshot used for rewind */
  snapshot: WorkingSnapshot | null;
  /** Offline rewind result (if rewind was attempted) */
  rewindResult: OfflineRewindResult | null;
  /** Error message (if failed) */
  error?: string;
}

/**
 * Execute a deterministic rewind to a working snapshot.
 *
 * Steps:
 *   1. Resolve snapshot (by ID or "latest")
 *   2. Find the ledger entry closest to the snapshot timestamp
 *   3. Delegate to offlineRewind() for file restoration
 *   4. Return result with blast radius and restored files
 */
export async function revertToWorkingState(
  request: RewindRequest,
): Promise<RewindResult> {
  const { snapshotId, cwd, unerrDir, graph, ledger, snapshotStore, dryRun } =
    request;

  // Step 1: Resolve snapshot
  let snapshot: WorkingSnapshot | null;
  if (snapshotId === "latest") {
    snapshot = snapshotStore.getLatest();
  } else {
    snapshot = snapshotStore.get(snapshotId);
  }

  if (!snapshot) {
    return {
      success: false,
      snapshot: null,
      rewindResult: null,
      error:
        snapshotId === "latest"
          ? "No working snapshots found. Use unerr_mark_working to create one."
          : `Snapshot ${snapshotId} not found.`,
    };
  }

  log.info(
    `Reverting to snapshot ${snapshot.id} at ${snapshot.commitSha.slice(0, 8)} (${snapshot.reason})`,
  );

  // Step 2: Find the closest ledger entry to the snapshot
  const allEntries = ledger.readAllEntries();
  const snapshotTime = new Date(snapshot.timestamp).getTime();

  // Find the entry closest to (but not after) the snapshot timestamp
  let targetEntry: { id: string; ts: string } | null = null;
  let closestDelta = Number.POSITIVE_INFINITY;

  for (const entry of allEntries) {
    const entryTime = new Date(entry.ts).getTime();
    const delta = snapshotTime - entryTime;
    // Entry must be at or before snapshot time
    if (delta >= 0 && delta < closestDelta) {
      closestDelta = delta;
      targetEntry = entry;
    }
  }

  if (!targetEntry) {
    // No ledger entry found — fall back to git-only rewind
    log.info("No matching ledger entry found. Performing git-only rewind.");
    return await performGitOnlyRewind(snapshot, cwd, dryRun);
  }

  const result = await offlineRewind({
    targetEntryId: targetEntry.id,
    cwd,
    unerrDir,
    graph,
    ledger,
    dryRun,
  });

  return {
    success: result.status !== "error",
    snapshot,
    rewindResult: result,
  };
}

/**
 * Git-only rewind when no ledger entry matches.
 * Uses checkoutFile to restore files from the snapshot commit.
 */
async function performGitOnlyRewind(
  snapshot: WorkingSnapshot,
  cwd: string,
  dryRun?: boolean,
): Promise<RewindResult> {
  if (dryRun) {
    return {
      success: true,
      snapshot,
      rewindResult: {
        status: "dry_run",
        rewindEntryId: null,
        timelineBranch: snapshot.timelineBranch,
        entriesReverted: 0,
        blastRadius: {
          safeFiles: [],
          conflictedFiles: [],
          affectedEntities: [],
          affectedCallers: 0,
          resolvedInMs: 0,
        },
        filesRestored: [],
      },
    };
  }

  try {
    const changedFiles = await getChangedFiles(cwd, snapshot.commitSha, "HEAD");

    if (changedFiles.length === 0) {
      return {
        success: true,
        snapshot,
        rewindResult: {
          status: "simulated",
          rewindEntryId: null,
          timelineBranch: snapshot.timelineBranch,
          entriesReverted: 0,
          blastRadius: {
            safeFiles: [],
            conflictedFiles: [],
            affectedEntities: [],
            affectedCallers: 0,
            resolvedInMs: 0,
          },
          filesRestored: [],
        },
      };
    }

    const filesRestored: string[] = [];
    for (const file of changedFiles) {
      try {
        await checkoutFile(cwd, snapshot.commitSha, file);
        filesRestored.push(file);
      } catch {
        // File may not exist at snapshot commit
      }
    }

    return {
      success: true,
      snapshot,
      rewindResult: {
        status: "simulated",
        rewindEntryId: null,
        timelineBranch: snapshot.timelineBranch,
        entriesReverted: 0,
        blastRadius: {
          safeFiles: filesRestored,
          conflictedFiles: [],
          affectedEntities: [],
          affectedCallers: 0,
          resolvedInMs: 0,
        },
        filesRestored,
      },
    };
  } catch (err) {
    return {
      success: false,
      snapshot,
      rewindResult: null,
      error: `Git rewind failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}
