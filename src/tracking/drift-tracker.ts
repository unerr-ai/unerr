/**
 * Drift Tracker Engine — detects workspace drift between local files and graph.
 *
 * Processing pipeline (per changed file):
 *   1. Content SHA → skip if unchanged (via FileHashManager)
 *   2. Extract entities via AST extractor (regex-based, fast)
 *   3. Diff against CozoDB base entities for same file_path
 *   4. Upsert drift_overlay: added / modified / deleted
 *   5. Update file hash state
 *
 * Runs within the proxy loop, triggered by file watcher or on-demand.
 * All logging to stderr. Never touches stdout.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  detectLanguage,
  entityKey,
  extractEntities,
  extractEntitiesAsync,
} from "../intelligence/ast-extractor.js";
import type {
  CozoGraphStore,
  DriftEdge,
  DriftEntity,
  DriftSummary,
} from "../intelligence/local-graph.js";
import type { evaluateRules as EvaluateRulesFn } from "../intelligence/rule-evaluator.js";
import { BranchSnapshotManager } from "./branch-snapshot.js";
import { contentSha256 } from "./file-hash-state.js";
import type { FileHashManager } from "./file-hash-state.js";
import type { PendingViolationStore } from "./pending-violations.js";
import { StashManager } from "./stash-manager.js";

/** Attribution origin based on timing heuristic. */
export type DriftOrigin = "ai" | "human" | "mixed";

/** Thresholds for AI attribution heuristic (ms). */
const AI_THRESHOLD_MS = 10_000; // <10s after sync = AI
const MIXED_THRESHOLD_MS = 60_000; // 10-60s = mixed, >60s = human

/**
 * Determine change origin based on time since last sync_local_diff.
 * - <10s after sync → "ai" (agent just wrote code)
 * - 10-60s → "mixed" (ambiguous, agent wrote + human may have edited)
 * - >60s → "human" (no recent agent activity)
 */
export function determineOrigin(lastSyncTimestamp: number): DriftOrigin {
  if (lastSyncTimestamp === 0) return "human";
  const elapsed = Date.now() - lastSyncTimestamp;
  if (elapsed < AI_THRESHOLD_MS) return "ai";
  if (elapsed < MIXED_THRESHOLD_MS) return "mixed";
  return "human";
}

export interface DriftTrackerConfig {
  /** Project root directory (where .git lives) */
  projectRoot: string;
  /** The repo ID for entity key hashing */
  repoId: string;
  /** Path to .unerr directory */
  unerrDir: string;
}

export interface DriftResult {
  /** Number of files processed */
  filesProcessed: number;
  /** Number of files skipped (unchanged) */
  filesSkipped: number;
  /** Number of entities added to overlay */
  entitiesAdded: number;
  /** Number of entities modified in overlay */
  entitiesModified: number;
  /** Number of entities deleted in overlay */
  entitiesDeleted: number;
  /** Number of cross-file entities invalidated (dependency_changed) */
  crossFileInvalidated: number;
  /** Number of drift edges extracted (Task 6.4) */
  edgesExtracted: number;
}

/** Layer 7: Payload for dashboard SSE (`drift` events). */
export type DriftDashboardPayload = DriftResult & { file: string };

/**
 * Chokidar `awaitWriteFinish` config for IDE auto-save noise filtering.
 * Use when setting up a file watcher that feeds into DriftTracker.
 *
 * stabilityThreshold: wait 300ms after last write before emitting 'change'
 * pollInterval: check every 100ms during the stability window
 */
export const DRIFT_WATCHER_OPTIONS = {
  awaitWriteFinish: {
    stabilityThreshold: 300,
    pollInterval: 100,
  },
} as const;

/**
 * In-memory mtime cache for fast rejection of unchanged files.
 * Avoids reading file content + computing SHA-256 when mtime hasn't changed.
 */
export class MtimeCache {
  private cache = new Map<string, number>();

  /**
   * Returns true if the file's mtime has changed (or is new).
   * Updates the cache entry on change.
   */
  check(filePath: string): boolean {
    try {
      const stat = statSync(filePath);
      const lastMtime = this.cache.get(filePath);
      if (lastMtime !== undefined && stat.mtimeMs === lastMtime) {
        return false; // unchanged
      }
      this.cache.set(filePath, stat.mtimeMs);
      return true; // changed or new
    } catch {
      // File doesn't exist or stat failed — evict from cache, let caller handle
      this.cache.delete(filePath);
      return true;
    }
  }

  /** Remove a file from the cache (e.g., on delete). */
  evict(filePath: string): void {
    this.cache.delete(filePath);
  }

  /** Clear entire cache (e.g., on branch switch). */
  clear(): void {
    this.cache.clear();
  }

  /** Number of cached entries. */
  get size(): number {
    return this.cache.size;
  }
}

/** stderr logger */
const _log = {
  info: (msg: string) => process.stderr.write(`[unerr:drift] ${msg}\n`),
  warn: (msg: string) => process.stderr.write(`[unerr:drift] WARN: ${msg}\n`),
};

export class DriftTracker {
  private config: DriftTrackerConfig;
  private localGraph: CozoGraphStore;
  private fileHashManager: FileHashManager;
  private mtimeCache = new MtimeCache();
  /** Timestamp of last sync_local_diff, set by proxy for attribution heuristic. */
  private _lastSyncTimestamp = 0;
  /** Optional rule evaluator for push-based violation detection (Task 7.3). */
  private ruleEvaluator: typeof EvaluateRulesFn | null = null;
  /** Optional violation store — shared with QueryRouter (Task 7.3). */
  private violationStore: PendingViolationStore | null = null;
  /** Local Mode incremental re-index hook (L2.5). Kept but disabled — full reindex preferred. */
  private localReindexFn:
    | ((
        projectRoot: string,
        filePath: string,
        graphStore: CozoGraphStore,
        repoId: string
      ) => Promise<{ entities: number; edges: number }>)
    | null = null;
  /** File change notification callback — wired to GraphHolder.notifyFileChange(). */
  private fileChangeNotifier: (() => void) | null = null;
  /** Stash manager for save/restore on git stash/pop (Task 7.1). */
  private stashManager: StashManager | null = null;
  /** Branch snapshot manager for save/restore on branch switch (Task 6.2). */
  private branchSnapshotManager: BranchSnapshotManager | null = null;
  /** Layer 7: Optional sink for dashboard SSE (same-process, no IPC). */
  private driftSink: ((payload: DriftDashboardPayload) => void) | null = null;

  constructor(
    config: DriftTrackerConfig,
    localGraph: CozoGraphStore,
    fileHashManager: FileHashManager
  ) {
    this.config = config;
    this.localGraph = localGraph;
    this.fileHashManager = fileHashManager;
  }

  /**
   * Enable push-based rule enforcement (Task 7.3).
   * When set, file changes trigger automatic rule evaluation.
   */
  setRuleEnforcement(
    evaluator: typeof EvaluateRulesFn,
    store: PendingViolationStore
  ): void {
    this.ruleEvaluator = evaluator;
    this.violationStore = store;
  }

  /**
   * Enable Local Mode incremental re-indexing (L2.5).
   * DISABLED — kept for reference. Full reindex is used instead (8s for 450 files).
   */
  setLocalReindex(
    reindexFn: (
      projectRoot: string,
      filePath: string,
      graphStore: CozoGraphStore,
      repoId: string
    ) => Promise<{ entities: number; edges: number }>
  ): void {
    this.localReindexFn = reindexFn;
  }

  /**
   * Wire the file change notifier (from GraphHolder.notifyFileChange).
   * Called on every drift-processed file change to signal the GraphHolder's idle timer.
   */
  setFileChangeNotifier(notifier: () => void): void {
    this.fileChangeNotifier = notifier;
  }

  /**
   * Swap the graph reference atomically (called by GraphHolder on rebuild completion).
   * All subsequent drift detection will use the new graph instance.
   */
  swapGraph(newGraph: CozoGraphStore): void {
    this.localGraph = newGraph;
  }

  /** Update the last sync timestamp (called by proxy on sync_local_diff). */
  setLastSyncTimestamp(ts: number): void {
    this._lastSyncTimestamp = ts;
  }

  /**
   * Layer 7: Wire dashboard event bus — emits when drift counts change for a file.
   */
  setDriftEventSink(
    sink: ((payload: DriftDashboardPayload) => void) | null
  ): void {
    this.driftSink = sink;
  }

  private maybeEmitDrift(relPath: string, result: DriftResult): void {
    if (!this.driftSink) return;
    const activity =
      result.entitiesAdded +
      result.entitiesModified +
      result.entitiesDeleted +
      result.crossFileInvalidated +
      result.edgesExtracted;
    if (activity === 0) return;
    this.driftSink({ file: relPath, ...result });
  }

  /**
   * Process a single file for drift detection.
   * Returns the drift result for this file.
   */
  async processFile(
    filePath: string,
    headSha: string,
    intentId?: string
  ): Promise<DriftResult> {
    const result: DriftResult = {
      filesProcessed: 0,
      filesSkipped: 0,
      entitiesAdded: 0,
      entitiesModified: 0,
      entitiesDeleted: 0,
      crossFileInvalidated: 0,
      edgesExtracted: 0,
    };

    // Resolve absolute path
    const absPath = filePath.startsWith("/")
      ? filePath
      : join(this.config.projectRoot, filePath);

    // Relative path for entity storage (from project root)
    const relPath = filePath.startsWith("/")
      ? filePath.slice(this.config.projectRoot.length + 1)
      : filePath;

    // Check if language is supported
    const language = detectLanguage(relPath);
    if (!language) return result;

    // Fast mtime rejection — avoid reading content + SHA if mtime unchanged
    if (existsSync(absPath) && !this.mtimeCache.check(absPath)) {
      result.filesSkipped = 1;
      return result;
    }

    // Check if file exists
    if (!existsSync(absPath)) {
      // File was deleted — mark all entities from this file as deleted
      const baseEntities = await this.localGraph.getEntitiesByFile(relPath);
      this.markFileDeleted(relPath, intentId);
      result.filesProcessed = 1;
      result.entitiesDeleted = baseEntities.length;

      // Cross-file invalidation: callers of deleted entities need notification
      const now = new Date().toISOString();
      const origin = determineOrigin(this._lastSyncTimestamp);
      for (const entity of baseEntities) {
        const callers = await this.localGraph.getCallersOf(entity.key);
        for (const caller of callers) {
          if (caller.file_path === relPath) continue;
          const existing = (
            await this.localGraph.getDriftEntitiesForFile(caller.file_path)
          ).find((e: { key: string }) => e.key === caller.key);
          if (existing && existing.drift_status !== "dependency_changed")
            continue;
          const drift: DriftEntity = {
            key: caller.key,
            name: caller.name,
            kind: caller.kind,
            signature: caller.signature ?? "",
            body: caller.body ?? "",
            file_path: caller.file_path,
            line_start: caller.start_line ?? 0,
            line_end: caller.start_line ?? 0,
            content_hash: "",
            drift_status: "dependency_changed",
            intent_id: intentId ?? "",
            modified_at: now,
            origin,
            previous_body: "",
            previous_signature: "",
          };
          await this.localGraph.upsertDriftEntity(drift);
          result.crossFileInvalidated++;
        }
      }

      this.maybeEmitDrift(relPath, result);
      return result;
    }

    // Read content and compute hash
    const content = readFileSync(absPath, "utf-8");
    const sha = contentSha256(content);

    // Skip if unchanged
    const decision = this.fileHashManager.shouldProcess(relPath, sha, headSha);
    if (decision === "skip") {
      result.filesSkipped = 1;
      return result;
    }

    result.filesProcessed = 1;

    // Extract entities from local file (tree-sitter WASM with regex fallback)
    const localEntities = await extractEntitiesAsync(content, relPath);

    // Get base entities from CozoDB for this file
    const baseEntities = await this.localGraph.getEntitiesByFile(relPath);

    // Build lookup maps
    const localByKey = new Map<string, (typeof localEntities)[0]>();
    for (const entity of localEntities) {
      const key = entityKey(
        this.config.repoId,
        relPath,
        entity.kind,
        entity.name,
        entity.signature
      );
      localByKey.set(key, entity);
    }

    const baseByKey = new Map<string, (typeof baseEntities)[0]>();
    for (const entity of baseEntities) {
      baseByKey.set(entity.key, entity);
    }

    // Reconcile stale "deleted" overlays before re-scanning. A "deleted" row is
    // written (below) when a base key is absent from local — e.g. a transient
    // empty/partial read, a tree-sitter parse miss, or a since-reverted edit. If
    // that entity is present in the file on this pass, neither loop below clears
    // the orphan row: the added/modified loop skips it (base present + hash match
    // → no upsert fires) and the deleted loop only marks base keys ABSENT from
    // local. The stale row then masks a LIVE entity as deleted in get_entity and
    // drift meta until the next full reindex. Drop any "deleted" overlay whose
    // key is back in localByKey — the entity exists locally, so it is not gone.
    const priorDrift = await this.localGraph.getDriftEntitiesForFile(relPath);
    for (const overlay of priorDrift) {
      if (overlay.drift_status === "deleted" && localByKey.has(overlay.key)) {
        await this.localGraph.removeDriftEntity(overlay.key);
      }
    }

    const now = new Date().toISOString();
    const origin = determineOrigin(this._lastSyncTimestamp);

    // Find added and modified entities
    for (const [key, local] of localByKey) {
      const base = baseByKey.get(key);

      if (!base) {
        // New entity — not in base graph
        const drift: DriftEntity = {
          key,
          name: local.name,
          kind: local.kind,
          signature: local.signature,
          body: extractBodyLines(content, local.line_start, local.line_end),
          file_path: relPath,
          line_start: local.line_start,
          line_end: local.line_end,
          content_hash: local.content_hash,
          drift_status: "added",
          intent_id: intentId ?? "",
          modified_at: now,
          origin,
          previous_body: "",
          previous_signature: "",
        };
        await this.localGraph.upsertDriftEntity(drift);
        result.entitiesAdded++;
      } else if (
        local.content_hash !== contentSha256(base.body || "").slice(0, 16)
      ) {
        // Content changed — mark as modified (preserve previous body for rewind)
        const drift: DriftEntity = {
          key,
          name: local.name,
          kind: local.kind,
          signature: local.signature,
          body: extractBodyLines(content, local.line_start, local.line_end),
          file_path: relPath,
          line_start: local.line_start,
          line_end: local.line_end,
          content_hash: local.content_hash,
          drift_status: "modified",
          intent_id: intentId ?? "",
          modified_at: now,
          origin,
          previous_body: base.body || "",
          previous_signature: base.signature || "",
        };
        await this.localGraph.upsertDriftEntity(drift);
        result.entitiesModified++;
      }
    }

    // Find deleted entities (in base but not in local)
    for (const [key, base] of baseByKey) {
      if (!localByKey.has(key)) {
        const drift: DriftEntity = {
          key,
          name: base.name,
          kind: base.kind,
          signature: base.signature,
          body: "",
          file_path: relPath,
          line_start: base.start_line,
          line_end: base.start_line,
          content_hash: "",
          drift_status: "deleted",
          intent_id: intentId ?? "",
          modified_at: now,
          origin,
          previous_body: base.body || "",
          previous_signature: base.signature || "",
        };
        await this.localGraph.upsertDriftEntity(drift);
        result.entitiesDeleted++;
      }
    }

    // Cross-file drift invalidation: notify callers of modified/deleted entities
    result.crossFileInvalidated = await this.invalidateCrossFileCallers(
      localByKey,
      baseByKey,
      relPath,
      now,
      origin,
      intentId
    );

    // Task 6.4: Extract drift edges (imports + function calls)
    result.edgesExtracted = await this.extractDriftEdges(
      content,
      relPath,
      localByKey,
      now
    );

    // Notify GraphHolder of file change — resets idle timer for swap-on-idle rebuild.
    // GraphHolder handles debouncing + full reindex + atomic graph swap.
    this.fileChangeNotifier?.();

    // Task 7.3: Push-based rule enforcement — evaluate rules on changed file
    if (
      this.ruleEvaluator &&
      this.violationStore &&
      (await this.localGraph.hasRules())
    ) {
      this.runRuleCheck(relPath, content);
    }

    // Update file hash state
    this.fileHashManager.markProcessed(relPath, sha, headSha);

    this.maybeEmitDrift(relPath, result);
    return result;
  }

  /**
   * Process multiple files for drift detection (batch).
   */
  async processFiles(
    filePaths: string[],
    headSha: string,
    intentId?: string
  ): Promise<DriftResult> {
    const aggregate: DriftResult = {
      filesProcessed: 0,
      filesSkipped: 0,
      entitiesAdded: 0,
      entitiesModified: 0,
      entitiesDeleted: 0,
      crossFileInvalidated: 0,
      edgesExtracted: 0,
    };

    for (const filePath of filePaths) {
      const result = await this.processFile(filePath, headSha, intentId);
      aggregate.filesProcessed += result.filesProcessed;
      aggregate.filesSkipped += result.filesSkipped;
      aggregate.entitiesAdded += result.entitiesAdded;
      aggregate.entitiesModified += result.entitiesModified;
      aggregate.entitiesDeleted += result.entitiesDeleted;
      aggregate.crossFileInvalidated += result.crossFileInvalidated;
      aggregate.edgesExtracted += result.edgesExtracted;
    }

    // Persist file hash state after batch
    this.fileHashManager.save();

    // Update drift summary on disk
    await this.saveDriftSummary();

    return aggregate;
  }

  /**
   * Initialize branch snapshot manager (Task 6.2).
   * Returns the manager for external use (e.g., GC on startup).
   */
  initBranchSnapshots(): BranchSnapshotManager {
    this.branchSnapshotManager = new BranchSnapshotManager(
      this.config.unerrDir,
      this.config.projectRoot
    );
    return this.branchSnapshotManager;
  }

  /**
   * Handle branch switch: save outgoing branch overlay, restore incoming.
   *
   * With BranchSnapshotManager (Task 6.2):
   *   1. Save current overlay + file hashes for outgoing branch
   *   2. Clear overlay + hashes + mtime cache
   *   3. Attempt restore from snapshot (fast, <10ms)
   *   4. If no snapshot (first visit), recompute from scratch
   *
   * Without BranchSnapshotManager: falls back to clear + recompute.
   */
  async onBranchSwitch(
    changedFiles: string[],
    headSha: string,
    fromBranch?: string,
    toBranch?: string
  ): Promise<DriftResult> {
    // Save outgoing branch snapshot
    if (this.branchSnapshotManager && fromBranch) {
      const fileHashState = this.fileHashManager.getState();
      await this.branchSnapshotManager.saveSnapshot(
        fromBranch,
        this.localGraph,
        {
          ...fileHashState,
        }
      );
    }

    // Clear current state
    await this.localGraph.clearDriftOverlay();
    this.fileHashManager.clearAll();
    this.mtimeCache.clear();

    // Attempt restore from snapshot
    if (this.branchSnapshotManager && toBranch) {
      const snapshot = await this.branchSnapshotManager.restoreSnapshot(
        toBranch,
        this.localGraph
      );
      if (snapshot) {
        // Restored from snapshot — skip recompute
        // Restore file hash state so subsequent processFile() calls
        // correctly skip unchanged files
        this.fileHashManager.restoreState(snapshot.fileHashes);
        return {
          filesProcessed: 0,
          filesSkipped: 0,
          entitiesAdded: snapshot.entities.length,
          entitiesModified: 0,
          entitiesDeleted: 0,
          crossFileInvalidated: 0,
          edgesExtracted: snapshot.edges?.length ?? 0,
        };
      }
    }

    // No snapshot — first visit, recompute from scratch
    return this.processFiles(changedFiles, headSha);
  }

  /**
   * Get the current drift summary from CozoDB.
   */
  async getDriftSummary(): Promise<DriftSummary> {
    return await this.localGraph.getDriftSummary();
  }

  /**
   * Initialize stash awareness (Task 7.1).
   * Returns the StashManager for use in polling.
   */
  initStashManager(): StashManager {
    this.stashManager = new StashManager(
      this.config.unerrDir,
      this.config.projectRoot
    );
    return this.stashManager;
  }

  /**
   * Handle git stash push: save current overlay + file hashes to snapshot.
   */
  async onStashSave(): Promise<string | null> {
    if (!this.stashManager) return null;
    const fileHashState = this.fileHashManager.getState();
    return await this.stashManager.saveSnapshot(this.localGraph, {
      ...fileHashState,
    });
  }

  /**
   * Handle git stash pop: restore overlay from most recent snapshot.
   */
  async onStashPop(): Promise<number> {
    if (!this.stashManager) return 0;
    return await this.stashManager.restoreSnapshot(this.localGraph);
  }

  private async markFileDeleted(
    filePath: string,
    intentId?: string
  ): Promise<void> {
    // Evict from mtime cache — file no longer exists
    const absPath = filePath.startsWith("/")
      ? filePath
      : join(this.config.projectRoot, filePath);
    this.mtimeCache.evict(absPath);

    const baseEntities = await this.localGraph.getEntitiesByFile(filePath);
    const now = new Date().toISOString();
    const origin = determineOrigin(this._lastSyncTimestamp);

    for (const entity of baseEntities) {
      const drift: DriftEntity = {
        key: entity.key,
        name: entity.name,
        kind: entity.kind,
        signature: entity.signature,
        body: "",
        file_path: filePath,
        line_start: entity.start_line,
        line_end: entity.start_line,
        content_hash: "",
        drift_status: "deleted",
        intent_id: intentId ?? "",
        modified_at: now,
        origin,
        previous_body: entity.body || "",
        previous_signature: entity.signature || "",
      };
      await this.localGraph.upsertDriftEntity(drift);
    }
  }

  /**
   * For modified/deleted entities in this file, find callers in OTHER files
   * and mark them as "dependency_changed" in the drift overlay.
   */
  private async invalidateCrossFileCallers(
    localByKey: Map<
      string,
      { name: string; kind: string; content_hash: string }
    >,
    baseByKey: Map<
      string,
      { key: string; name: string; kind: string; body?: string }
    >,
    filePath: string,
    now: string,
    origin: DriftOrigin,
    intentId?: string
  ): Promise<number> {
    // Collect keys of entities that were modified or deleted
    const changedKeys: string[] = [];

    for (const [key, local] of localByKey) {
      const base = baseByKey.get(key);
      if (!base) {
        // Added entity — no callers to invalidate yet
        continue;
      }
      if (local.content_hash !== contentSha256(base.body || "").slice(0, 16)) {
        changedKeys.push(key);
      }
    }

    for (const [key] of baseByKey) {
      if (!localByKey.has(key)) {
        changedKeys.push(key); // deleted
      }
    }

    if (changedKeys.length === 0) return 0;

    let invalidated = 0;

    for (const key of changedKeys) {
      const callers = await this.localGraph.getCallersOf(key);
      for (const caller of callers) {
        // Skip callers in the same file — already handled by normal diff
        if (caller.file_path === filePath) continue;

        // Don't overwrite a stronger drift status (added/modified/deleted)
        const existingEntities = await this.localGraph.getDriftEntitiesForFile(
          caller.file_path
        );
        const existing = existingEntities.find(
          (e: { key: string }) => e.key === caller.key
        );
        if (existing && existing.drift_status !== "dependency_changed") {
          continue;
        }

        const drift: DriftEntity = {
          key: caller.key,
          name: caller.name,
          kind: caller.kind,
          signature: caller.signature ?? "",
          body: caller.body ?? "",
          file_path: caller.file_path,
          line_start: caller.start_line ?? 0,
          line_end: caller.start_line ?? 0,
          content_hash: "",
          drift_status: "dependency_changed",
          intent_id: intentId ?? "",
          modified_at: now,
          origin,
          previous_body: "",
          previous_signature: "",
        };
        await this.localGraph.upsertDriftEntity(drift);
        invalidated++;
      }
    }

    return invalidated;
  }

  private async saveDriftSummary(): Promise<void> {
    const driftDir = join(this.config.unerrDir, "drift");
    if (!existsSync(driftDir)) {
      mkdirSync(driftDir, { recursive: true });
    }
    const summary = await this.getDriftSummary();
    writeFileSync(
      join(driftDir, "drift_summary.json"),
      JSON.stringify(summary, null, 2),
      "utf-8"
    );
  }

  /**
   * Task 7.3: Run rule evaluation on a changed file and store violations.
   * Non-blocking: fires and forgets. If evaluation takes >10ms, times out silently.
   */
  /**
   * Task 6.4: Extract import and function call edges from file content.
   * Upserts them into drift_edges. Approximate — no full scope resolution.
   */
  private async extractDriftEdges(
    content: string,
    filePath: string,
    localByKey: Map<
      string,
      { name: string; kind: string; content_hash: string }
    >,
    now: string
  ): Promise<number> {
    let count = 0;

    // Extract import edges: import { X } from './module'
    const importEdges = extractImportEdges(content, filePath);
    for (const imp of importEdges) {
      // Resolve target: find entity key matching imported name in target file
      const targetKey = await this.resolveImportTarget(
        imp.importedName,
        imp.targetPath
      );
      if (!targetKey) continue;

      // Find a source entity that is the "file module" or first entity in this file
      const sourceKey = this.resolveImportSource(filePath, localByKey);
      if (!sourceKey) continue;

      await this.localGraph.upsertDriftEdge({
        from_key: sourceKey,
        to_key: targetKey,
        type: "imports",
        drift_status: "added",
        modified_at: now,
      });
      count++;
    }

    // Extract function call edges within entities in this file.
    // Only callable kinds can emit "calls" edges — variables, interfaces, types
    // are not call sites, and scanning the full file body for them would attribute
    // unrelated calls in the same file to non-callable entities (false positives in
    // get_references). Class is included because class bodies can contain static
    // initializers and field initializers that perform calls.
    const CALLABLE_KINDS = new Set(["function", "method", "class"]);
    for (const [callerKey, entity] of localByKey) {
      if (!CALLABLE_KINDS.has(entity.kind)) continue;
      const callEdges = extractCallEdges(content, entity.name, callerKey);
      for (const call of callEdges) {
        // Find target entity by name in any file
        const targetKey = await this.resolveCallTarget(call.calledName);
        if (!targetKey || targetKey === callerKey) continue;

        await this.localGraph.upsertDriftEdge({
          from_key: callerKey,
          to_key: targetKey,
          type: "calls",
          drift_status: "added",
          modified_at: now,
        });
        count++;
      }
    }

    return count;
  }

  /**
   * Resolve an imported name to an entity key in the target file.
   */
  private async resolveImportTarget(
    name: string,
    targetPath: string
  ): Promise<string | null> {
    // Look in base entities first
    const baseEntities = await this.localGraph.getEntitiesByFile(targetPath);
    for (const entity of baseEntities) {
      if (entity.name === name) return entity.key;
    }
    // Check drift overlay
    const driftEntities =
      await this.localGraph.getDriftEntitiesForFile(targetPath);
    for (const entity of driftEntities) {
      if (entity.name === name && entity.drift_status !== "deleted")
        return entity.key;
    }
    return null;
  }

  /**
   * Find the first entity in this file to use as import source.
   */
  private resolveImportSource(
    filePath: string,
    localByKey: Map<
      string,
      { name: string; kind: string; content_hash: string }
    >
  ): string | null {
    // Use first entity from local extraction as the module representative
    for (const [key] of localByKey) {
      return key;
    }
    return null;
  }

  /**
   * Resolve a called function name to an entity key.
   * Searches base entities + drift overlay across all files.
   */
  private async resolveCallTarget(name: string): Promise<string | null> {
    // Search base entities by name
    const entity = await this.localGraph.findEntityByName(name);
    if (entity) return entity.key;
    return null;
  }

  private async runRuleCheck(filePath: string, content: string): Promise<void> {
    if (!this.ruleEvaluator || !this.violationStore) return;

    const rules = await this.localGraph.getRules();
    if (rules.length === 0) return;

    const evaluator = this.ruleEvaluator;
    const store = this.violationStore;

    // Run async rule evaluation — fire and forget, don't block drift processing
    const t0 = performance.now();
    evaluator(rules, filePath, content, this.localGraph)
      .then((result) => {
        const elapsed = performance.now() - t0;
        if (elapsed > 10) {
          _log.warn(
            `Rule evaluation for ${filePath} took ${elapsed.toFixed(1)}ms (>10ms budget)`
          );
        }
        store.addViolations(filePath, result.violations);
      })
      .catch(() => {
        // Rule evaluation failed — skip silently, don't break drift processing
      });
  }
}

function extractBodyLines(
  content: string,
  lineStart: number,
  lineEnd: number
): string {
  const lines = content.split("\n");
  return lines.slice(lineStart - 1, lineEnd).join("\n");
}

// ── Task 6.4: Edge Extraction Helpers ───────────────────────────────

interface ImportEdge {
  importedName: string;
  targetPath: string;
}

interface CallEdge {
  callerKey: string;
  calledName: string;
}

/** Regex for ES import statements: import { X, Y } from './path' */
const IMPORT_REGEX =
  /import\s+(?:\{([^}]+)\}|(\w+))\s+from\s+['"]([^'"]+)['"]/g;

/**
 * Extract import edges from file content.
 * Resolves relative import paths to project-relative paths.
 */
function extractImportEdges(content: string, filePath: string): ImportEdge[] {
  const edges: ImportEdge[] = [];

  // Reset lastIndex for global regex
  IMPORT_REGEX.lastIndex = 0;

  for (
    let match = IMPORT_REGEX.exec(content);
    match !== null;
    match = IMPORT_REGEX.exec(content)
  ) {
    const namedImports = match[1]; // { X, Y }
    const defaultImport = match[2]; // default import
    const importPath = match[3] ?? "";

    // Only handle relative imports (local project files)
    if (!importPath.startsWith(".")) continue;

    // Resolve target path relative to current file
    const targetPath = resolveImportPath(filePath, importPath);
    if (!targetPath) continue;

    if (namedImports) {
      // Split named imports: { X, Y as Z } → ["X", "Y"]
      for (const name of namedImports.split(",")) {
        const trimmed = name
          .trim()
          .split(/\s+as\s+/)[0]
          ?.trim();
        if (trimmed) {
          edges.push({ importedName: trimmed, targetPath });
        }
      }
    }

    if (defaultImport) {
      edges.push({ importedName: defaultImport, targetPath });
    }
  }

  return edges;
}

/**
 * Resolve a relative import path to a project-relative file path.
 * './service' from 'src/auth/handler.ts' → 'src/auth/service.ts'
 */
function resolveImportPath(
  fromFile: string,
  importPath: string
): string | null {
  // Remove file extension from current file to get directory
  const dir = fromFile.replace(/\/[^/]+$/, "");
  // Normalize the import path
  let resolved = importPath;

  if (resolved.startsWith("./")) {
    resolved = `${dir}/${resolved.slice(2)}`;
  } else if (resolved.startsWith("../")) {
    const parts = dir.split("/");
    let rel = resolved;
    while (rel.startsWith("../")) {
      parts.pop();
      rel = rel.slice(3);
    }
    resolved = [...parts, rel].join("/");
  }

  // Remove .js extension (NodeNext resolution: imports use .js but files are .ts)
  resolved = resolved.replace(/\.js$/, "");

  // Try common extensions
  for (const ext of [".ts", ".tsx", ".js", ".jsx"]) {
    const candidate = resolved + ext;
    // Return project-relative path (we don't check existence here —
    // the caller will look up entities in that file path)
    return candidate;
  }

  return null;
}

/**
 * Extract function call edges from within an entity's body.
 * Simple regex: matches `name(` patterns that look like function calls.
 */
function extractCallEdges(
  content: string,
  _entityName: string,
  callerKey: string
): CallEdge[] {
  const edges: CallEdge[] = [];
  const seen = new Set<string>();

  // Match function/method calls: identifier( or this.identifier( or obj.identifier(
  const CALL_REGEX = /(?:this\.|[\w]+\.)?(\w+)\s*\(/g;

  for (
    let match = CALL_REGEX.exec(content);
    match !== null;
    match = CALL_REGEX.exec(content)
  ) {
    const name = match[1];
    if (!name || name.length < 2) continue;
    // Skip common built-ins and keywords
    if (BUILTIN_NAMES.has(name)) continue;
    if (seen.has(name)) continue;
    seen.add(name);

    edges.push({ callerKey, calledName: name });
  }

  return edges;
}

/** Names to skip during call extraction (language builtins, common patterns). */
const BUILTIN_NAMES = new Set([
  "if",
  "for",
  "while",
  "switch",
  "catch",
  "return",
  "throw",
  "new",
  "typeof",
  "instanceof",
  "delete",
  "void",
  "require",
  "import",
  "console",
  "log",
  "warn",
  "error",
  "info",
  "debug",
  "parseInt",
  "parseFloat",
  "isNaN",
  "isFinite",
  "setTimeout",
  "setInterval",
  "clearTimeout",
  "clearInterval",
  "Promise",
  "resolve",
  "reject",
  "then",
  "catch",
  "finally",
  "Array",
  "Object",
  "String",
  "Number",
  "Boolean",
  "Map",
  "Set",
  "JSON",
  "parse",
  "stringify",
  "Math",
  "Date",
  "push",
  "pop",
  "shift",
  "unshift",
  "splice",
  "slice",
  "concat",
  "map",
  "filter",
  "reduce",
  "forEach",
  "find",
  "some",
  "every",
  "join",
  "split",
  "replace",
  "match",
  "test",
  "exec",
  "keys",
  "values",
  "entries",
  "from",
  "of",
  "trim",
  "includes",
  "startsWith",
  "endsWith",
  "indexOf",
  "length",
  "toString",
  "valueOf",
]);
