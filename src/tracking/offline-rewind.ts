/**
 * Offline Rewind — Zero-Network rewind using CozoDB + local git.
 * Phase 5.5 §1.3.4 (P5.5-CB-03)
 *
 * When the user is offline, this module performs a filesystem-level rewind
 * using the local CozoDB graph for blast radius computation and git for
 * file restoration.
 *
 * Integration Points:
 *   • P10 Bridge: Reads shadow ledger entries from .unerr/ledger/shadow.jsonl
 *   • P13 Bridge: Uses `git checkout {ref} -- {files}` for atomic file restore
 *   • P5.5 Bridge: On connectivity restore, flushes simulated rewind via sync-intent
 *
 * Invariant: Offline rewind produces identical file state as online rewind.
 * Difference: Anti-pattern rule synthesis deferred until connectivity (requires LLM).
 *
 * Blast radius resolution target: <200ms (CozoDB is in-process, no network).
 */

import { randomBytes } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { CozoGraphStore } from "../intelligence/local-graph.js";
import { checkoutFile } from "../utils/git.js";
import { createModuleLogger } from "../utils/logger.js";
import type { ShadowLedger } from "./shadow-ledger.js";

const log = createModuleLogger("offline-rewind");

// ── Types ──────────────────────────────────────────────────────────────────

export interface OfflineRewindInput {
  /** Target entry ID to rewind to (from shadow ledger) */
  targetEntryId: string;
  /** Working directory (repo root) */
  cwd: string;
  /** Path to .unerr directory */
  unerrDir: string;
  /** CozoDB local graph (for blast radius) */
  graph: CozoGraphStore;
  /** Shadow ledger instance */
  ledger: ShadowLedger;
  /** If true, only compute blast radius without applying changes */
  dryRun?: boolean;
}

export interface LocalBlastRadius {
  /** Files safely revertible (no conflicts) */
  safeFiles: string[];
  /** Files with potential conflicts */
  conflictedFiles: Array<{ filePath: string; reason: string }>;
  /** Entities affected by the rewind */
  affectedEntities: Array<{
    key: string;
    name: string;
    filePath: string;
    riskLevel: string;
  }>;
  /** Callers of affected entities (1-hop) */
  affectedCallers: number;
  /** Resolution time in milliseconds (<200ms target) */
  resolvedInMs: number;
}

export interface OfflineRewindResult {
  status: "simulated" | "dry_run" | "error";
  rewindEntryId: string | null;
  timelineBranch: number;
  entriesReverted: number;
  blastRadius: LocalBlastRadius;
  /** Files actually restored via git checkout */
  filesRestored: string[];
  errorMessage?: string;
}

// ── Core Logic ─────────────────────────────────────────────────────────────

/**
 * Perform an offline rewind using local resources only.
 *
 * Steps (per §1.3.4):
 *   1. Read local ledger entries from shadow.jsonl
 *   2. Identify the target entry and entries to revert
 *   3. Compute blast radius using CozoDB (entity lookup + 1-hop callers)
 *   4. If not dry run: apply file restores via `git checkout`
 *   5. Update local state: shadow.jsonl, branch_context.json, drift overlay
 */
export async function offlineRewind(
  input: OfflineRewindInput
): Promise<OfflineRewindResult> {
  const startTime = Date.now();
  const { targetEntryId, cwd, unerrDir, graph, ledger, dryRun } = input;

  try {
    // ── Step 1: Read local ledger entries ─────────────────────────────
    const allEntries = ledger.readAllEntries();
    const targetEntry = allEntries.find((e) => e.id === targetEntryId);

    if (!targetEntry) {
      return errorResult(
        `Target entry ${targetEntryId} not found in local ledger`
      );
    }

    // ── Step 2: Identify entries to revert ────────────────────────────
    // All entries created AFTER the target, on the same branch, not already reverted
    const entriesToRevert = allEntries.filter(
      (e) =>
        e.branch === targetEntry.branch &&
        e.ts > targetEntry.ts &&
        e.id !== targetEntryId &&
        !(e.result_summary as Record<string, unknown>)?.rewind_status
    );

    // Collect all files changed in entries to revert
    const filesToRevert = new Set<string>();
    for (const entry of entriesToRevert) {
      const files = extractFilesFromEntry(entry);
      for (const f of files) filesToRevert.add(f);
    }

    // Files in the target entry
    const targetFiles = new Set(extractFilesFromEntry(targetEntry));

    // ── Step 3: Compute blast radius using CozoDB (<200ms) ────────────
    const blastRadius = await computeLocalBlastRadius(
      graph,
      Array.from(filesToRevert),
      targetFiles,
      startTime
    );

    if (dryRun) {
      return {
        status: "dry_run",
        rewindEntryId: null,
        timelineBranch: readBranchCounter(unerrDir),
        entriesReverted: entriesToRevert.length,
        blastRadius,
        filesRestored: [],
      };
    }

    // ── Step 4: Apply file restores via git checkout ──────────────────
    const filesRestored: string[] = [];
    const safeToRestore = blastRadius.safeFiles;

    if (safeToRestore.length > 0) {
      // Find the HEAD SHA to restore from (target entry's head_sha)
      const restoreRef = targetEntry.head_sha;
      if (restoreRef) {
        for (const filePath of safeToRestore) {
          try {
            await checkoutFile(cwd, restoreRef, filePath);
            filesRestored.push(filePath);
          } catch {
            log.warn(`Could not restore ${filePath}`);
          }
        }
      }
    }

    // ── Step 5: Update local state ────────────────────────────────────

    // 5a. Increment timeline branch
    const newBranch = incrementBranchCounter(unerrDir);

    // 5b. Create rewind entry in shadow.jsonl
    const rewindEntryId = generateId();
    const rewindEntry = {
      id: rewindEntryId,
      ts: new Date().toISOString(),
      tool: "revert_to_working_state",
      args_summary: { target_entry_id: targetEntryId, offline: true },
      result_summary: {
        rewind_status: "simulated",
        entries_reverted: entriesToRevert.length,
        files_restored: filesRestored.length,
        timeline_branch: newBranch,
        rewind_target_id: targetEntryId,
        blast_radius: {
          safeFiles: blastRadius.safeFiles,
          conflictedFiles: blastRadius.conflictedFiles.map((f) => f.filePath),
        },
      },
      branch: targetEntry.branch,
      head_sha: targetEntry.head_sha,
      session_id: ledger.getSessionId(),
      correlation_id: null,
    };

    // Append to shadow.jsonl
    const ledgerPath = join(unerrDir, "ledger", "shadow.jsonl");
    appendFileSync(ledgerPath, `${JSON.stringify(rewindEntry)}\n`, "utf-8");

    // 5c. Mark intermediate entries as reverted locally
    markEntriesReverted(
      unerrDir,
      entriesToRevert.map((e) => e.id)
    );

    // 5d. Clear drift overlay for reverted files (they're now at target state)
    for (const _filePath of filesRestored) {
      await graph.clearDriftOverlay();
    }

    return {
      status: "simulated",
      rewindEntryId,
      timelineBranch: newBranch,
      entriesReverted: entriesToRevert.length,
      blastRadius,
      filesRestored,
    };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return errorResult(message);
  }
}

// ── Blast Radius Computation (CozoDB, <200ms) ─────────────────────────────

async function computeLocalBlastRadius(
  graph: CozoGraphStore,
  revertFiles: string[],
  targetFiles: Set<string>,
  startTime: number
): Promise<LocalBlastRadius> {
  const safeFiles: string[] = [];
  const conflictedFiles: Array<{ filePath: string; reason: string }> = [];
  const affectedEntities: Array<{
    key: string;
    name: string;
    filePath: string;
    riskLevel: string;
  }> = [];
  const callerKeys = new Set<string>();

  for (const filePath of revertFiles) {
    // Conflict: file exists in both target and reverted entries
    if (targetFiles.has(filePath)) {
      conflictedFiles.push({
        filePath,
        reason: "File modified in both target and reverted entries",
      });
    } else {
      safeFiles.push(filePath);
    }

    // Entity lookup via CozoDB file_index (in-process, <10ms)
    const entities = await graph.getEntitiesByFile(filePath);
    for (const entity of entities) {
      affectedEntities.push({
        key: entity.key,
        name: entity.name,
        filePath: entity.file_path,
        riskLevel: entity.risk_level,
      });

      // 1-hop callers via CozoDB edges (pre-indexed, <50ms)
      const callers = await graph.getCallersOf(entity.key);
      for (const caller of callers) {
        callerKeys.add(caller.key);
      }
    }
  }

  return {
    safeFiles,
    conflictedFiles,
    affectedEntities,
    affectedCallers: callerKeys.size,
    resolvedInMs: Date.now() - startTime,
  };
}

// ── Local State Helpers ────────────────────────────────────────────────────

/**
 * Read the current timeline branch counter from branch_context.json.
 */
function readBranchCounter(unerrDir: string): number {
  const contextPath = join(unerrDir, "ledger", "branch_context.json");
  if (!existsSync(contextPath)) return 1;

  try {
    const data = JSON.parse(readFileSync(contextPath, "utf-8")) as {
      timeline_branch?: number;
    };
    return data.timeline_branch ?? 1;
  } catch {
    return 1;
  }
}

/**
 * Increment the timeline branch counter and return the new value.
 */
function incrementBranchCounter(unerrDir: string): number {
  const contextPath = join(unerrDir, "ledger", "branch_context.json");
  const ledgerDir = join(unerrDir, "ledger");

  if (!existsSync(ledgerDir)) {
    mkdirSync(ledgerDir, { recursive: true });
  }

  let data: Record<string, unknown> = {};
  if (existsSync(contextPath)) {
    try {
      data = JSON.parse(readFileSync(contextPath, "utf-8")) as Record<
        string,
        unknown
      >;
    } catch {
      // Start fresh
    }
  }

  const current =
    typeof data.timeline_branch === "number" ? data.timeline_branch : 1;
  const next = current + 1;
  data.timeline_branch = next;
  data.last_rewind_at = new Date().toISOString();

  writeFileSync(contextPath, JSON.stringify(data, null, 2), "utf-8");
  return next;
}

/**
 * Mark entries as reverted in the pending_correlations.json file.
 * These entries are tracked locally as reverted.
 */
function markEntriesReverted(unerrDir: string, entryIds: string[]): void {
  if (entryIds.length === 0) return;

  const revertedPath = join(unerrDir, "ledger", "reverted_entries.json");
  const ledgerDir = join(unerrDir, "ledger");

  if (!existsSync(ledgerDir)) {
    mkdirSync(ledgerDir, { recursive: true });
  }

  let existing: string[] = [];
  if (existsSync(revertedPath)) {
    try {
      existing = JSON.parse(readFileSync(revertedPath, "utf-8")) as string[];
    } catch {
      // Start fresh
    }
  }

  const merged = Array.from(new Set([...existing, ...entryIds]));
  writeFileSync(revertedPath, JSON.stringify(merged, null, 2), "utf-8");
}

/**
 * Extract file paths from a shadow ledger entry's args_summary.
 */
function extractFilesFromEntry(entry: {
  args_summary: Record<string, unknown>;
  result_summary: Record<string, unknown>;
}): string[] {
  const files: string[] = [];

  // Check args_summary for file references
  const args = entry.args_summary;
  if (Array.isArray(args.files)) {
    for (const f of args.files) {
      if (typeof f === "string") files.push(f);
      else if (
        f &&
        typeof (f as Record<string, unknown>).file_path === "string"
      ) {
        files.push((f as Record<string, unknown>).file_path as string);
      }
    }
  }
  if (typeof args.file_path === "string") files.push(args.file_path);

  // Check result_summary for affected files
  const result = entry.result_summary;
  if (Array.isArray(result.files_changed)) {
    for (const f of result.files_changed) {
      if (typeof f === "string") files.push(f);
    }
  }

  return files;
}

// ── Utilities ──────────────────────────────────────────────────────────────

function generateId(): string {
  return randomBytes(6).toString("hex");
}

function errorResult(message: string): OfflineRewindResult {
  return {
    status: "error",
    rewindEntryId: null,
    timelineBranch: 0,
    entriesReverted: 0,
    blastRadius: {
      safeFiles: [],
      conflictedFiles: [],
      affectedEntities: [],
      affectedCallers: 0,
      resolvedInMs: 0,
    },
    filesRestored: [],
    errorMessage: message,
  };
}
