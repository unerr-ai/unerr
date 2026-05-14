/**
 * Graph Holder — manages the active CozoGraphStore reference and handles
 * swap-on-idle rebuilds for consistent, always-queryable graph access.
 *
 * Design: The old graph remains fully operational during rebuild (~8s).
 * Once the new graph is ready, all consumers are atomically swapped to the
 * new instance. The old graph is then eligible for GC.
 *
 * Trigger: File changes (from file watcher or LLM tool calls) reset an idle
 * timer. When no file change occurs for IDLE_THRESHOLD_MS, a full reindex
 * is triggered into a fresh CozoDB instance. On completion, the reference
 * is swapped across all consumers.
 */

import type { IncrementalResult } from "./incremental-indexer.js";
import type { CozoGraphStore } from "./local-graph.js";
import type { IndexResult } from "./local-indexer.js";

/** Callback to propagate the new graph instance to all consumers. */
export type GraphSwapCallback = (newGraph: CozoGraphStore) => void;

/** Factory that creates a fresh CozoGraphStore and indexes the project into it. */
export type GraphRebuildFactory = () => Promise<{
  graph: CozoGraphStore;
  result: IndexResult;
}>;

/** Factory for incremental indexing — processes only changed files. */
export type IncrementalIndexFactory = (
  changedFiles: string[],
) => Promise<IncrementalResult>;

export interface GraphHolderConfig {
  /**
   * Idle threshold in ms — how long after the last file change before
   * triggering a rebuild. Should be long enough to batch multi-file edits
   * from LLMs (which make rapid sequential edits within a turn).
   * Default: 5000ms (5s). LLM edits are typically 1-3s apart within a turn.
   */
  idleThresholdMs?: number;
  /**
   * Max files for incremental indexing. If more files changed, fallback to full reindex.
   * Default: 20.
   */
  incrementalFileLimit?: number;
  /**
   * After this many incremental cycles, force a full reindex to correct drift.
   * Default: 10.
   */
  fullReindexEveryNCycles?: number;
}

const DEFAULT_IDLE_THRESHOLD_MS = 5_000;

const _log = {
  info: (msg: string) => process.stderr.write(`▸ [graph-holder] ${msg}\n`),
  warn: (msg: string) => process.stderr.write(`⚠ [graph-holder] ${msg}\n`),
};

export class GraphHolder {
  private current: CozoGraphStore;
  private rebuildFactory: GraphRebuildFactory | null = null;
  private incrementalFactory: IncrementalIndexFactory | null = null;
  private swapCallbacks: GraphSwapCallback[] = [];
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly idleThresholdMs: number;
  private readonly incrementalFileLimit: number;
  private readonly fullReindexEveryNCycles: number;
  private rebuilding = false;
  private rebuildPending = false;
  private fileChangesSinceLastRebuild = 0;
  private lastRebuildTimestamp = 0;
  private changedFilePaths: Set<string> = new Set();
  private incrementalCycleCount = 0;

  constructor(initialGraph: CozoGraphStore, config?: GraphHolderConfig) {
    this.current = initialGraph;
    this.idleThresholdMs = config?.idleThresholdMs ?? DEFAULT_IDLE_THRESHOLD_MS;
    this.incrementalFileLimit = config?.incrementalFileLimit ?? 20;
    this.fullReindexEveryNCycles = config?.fullReindexEveryNCycles ?? 10;
  }

  /** Get the current active graph instance. Always valid, never null. */
  get graph(): CozoGraphStore {
    return this.current;
  }

  /** Register the factory that creates a fresh graph + indexes into it. */
  setRebuildFactory(factory: GraphRebuildFactory): void {
    this.rebuildFactory = factory;
  }

  /** Register the incremental indexing factory (processes only changed files). */
  setIncrementalFactory(factory: IncrementalIndexFactory): void {
    this.incrementalFactory = factory;
  }

  /**
   * Register a callback invoked when the graph is swapped.
   * Used to propagate the new instance to QueryRouter, DriftTracker, behaviors, etc.
   */
  onSwap(callback: GraphSwapCallback): void {
    this.swapCallbacks.push(callback);
  }

  /**
   * Notify the holder that files changed. Resets the idle timer.
   * Called by file watcher (covers both LLM writes and user edits).
   * @param filePaths — absolute paths of changed files (for incremental indexing)
   */
  notifyFileChange(filePaths?: string[]): void {
    this.fileChangesSinceLastRebuild++;
    if (filePaths) {
      for (const fp of filePaths) {
        this.changedFilePaths.add(fp);
      }
    }

    // Reset idle timer
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
    }

    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      this.triggerRebuild();
    }, this.idleThresholdMs);
  }

  /**
   * Force an immediate rebuild (e.g., on explicit user command).
   * Skips idle timer.
   */
  forceRebuild(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    this.triggerRebuild();
  }

  /** Whether a rebuild is currently in progress. */
  get isRebuilding(): boolean {
    return this.rebuilding;
  }

  /** Number of file changes since last successful rebuild. */
  get pendingChanges(): number {
    return this.fileChangesSinceLastRebuild;
  }

  /** Clean up timers on shutdown. */
  dispose(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }

  // ─── Private ───────────────────────────────────────────────────────────────

  /**
   * Decide whether to use incremental or full reindex, then execute.
   * Incremental when: factory exists, file count ≤ limit, not a periodic full cycle.
   * Full otherwise (or as fallback on incremental failure).
   */
  private triggerRebuild(): void {
    if (!this.rebuildFactory) return;
    if (this.fileChangesSinceLastRebuild === 0) return; // No changes since last rebuild

    if (this.rebuilding) {
      this.rebuildPending = true;
      return;
    }

    this.rebuilding = true;
    const changesAtStart = this.fileChangesSinceLastRebuild;
    const changedFiles = [...this.changedFilePaths];
    const startMs = Date.now();

    // Decision: incremental or full?
    const useIncremental =
      this.incrementalFactory !== null &&
      changedFiles.length > 0 &&
      changedFiles.length <= this.incrementalFileLimit &&
      this.incrementalCycleCount < this.fullReindexEveryNCycles;

    if (useIncremental) {
      this.runIncremental(changedFiles, changesAtStart, startMs);
    } else {
      if (this.incrementalCycleCount >= this.fullReindexEveryNCycles) {
        _log.info(
          `Periodic full reindex (after ${this.incrementalCycleCount} incremental cycles)`,
        );
        this.incrementalCycleCount = 0;
      }
      this.runFullRebuild(changesAtStart, startMs);
    }
  }

  private runIncremental(
    changedFiles: string[],
    changesAtStart: number,
    startMs: number,
  ): void {
    _log.info(`Incremental indexing ${changedFiles.length} files...`);

    this.incrementalFactory!(changedFiles)
      .then((result) => {
        // Clear tracked files that were processed
        for (const fp of changedFiles) {
          this.changedFilePaths.delete(fp);
        }
        this.fileChangesSinceLastRebuild = Math.max(
          0,
          this.fileChangesSinceLastRebuild - changesAtStart,
        );
        this.lastRebuildTimestamp = Date.now();
        this.incrementalCycleCount++;

        _log.info(
          `Incremental done in ${Date.now() - startMs}ms — ` +
            `+${result.entitiesAdded}/-${result.entitiesDeleted}/~${result.entitiesUpdated} entities, ` +
            `+${result.edgesAdded}/-${result.edgesDeleted} edges`,
        );

        // Notify swap callbacks (graph is same instance, but data changed)
        for (const cb of this.swapCallbacks) {
          try {
            cb(this.current);
          } catch (err) {
            _log.warn(
              `Swap callback failed: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
        }
      })
      .catch((err: unknown) => {
        _log.warn(
          `Incremental indexing failed: ${err instanceof Error ? err.message : String(err)}. Falling back to full reindex.`,
        );
        // Fallback to full reindex
        this.runFullRebuild(changesAtStart, startMs);
        return; // runFullRebuild handles its own finally logic via .finally()
      })
      .finally(() => {
        this.rebuilding = false;
        if (this.rebuildPending) {
          this.rebuildPending = false;
          this.triggerRebuild();
        }
      });
  }

  private runFullRebuild(changesAtStart: number, startMs: number): void {
    _log.info(
      `Full reindex (${changesAtStart} file changes since last rebuild)...`,
    );

    this.rebuildFactory!()
      .then(({ graph: newGraph, result }) => {
        const oldGraph = this.current;
        this.current = newGraph;

        // Propagate to all consumers
        for (const cb of this.swapCallbacks) {
          try {
            cb(newGraph);
          } catch (err) {
            _log.warn(
              `Swap callback failed: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
        }

        // Clear all tracked state — full reindex is authoritative
        this.changedFilePaths.clear();
        this.fileChangesSinceLastRebuild = Math.max(
          0,
          this.fileChangesSinceLastRebuild - changesAtStart,
        );
        this.lastRebuildTimestamp = Date.now();

        _log.info(
          `Graph rebuilt in ${Date.now() - startMs}ms — ${result.entityCount} entities, ${result.edgeCount} edges. Swapped.`,
        );

        // Close old graph if different instance
        if (oldGraph !== newGraph) {
          try {
            (oldGraph as unknown as { close?: () => void }).close?.();
          } catch {
            // best-effort
          }
        }
      })
      .catch((err: unknown) => {
        _log.warn(
          `Graph rebuild failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      })
      .finally(() => {
        this.rebuilding = false;
        if (this.rebuildPending) {
          this.rebuildPending = false;
          this.triggerRebuild();
        }
      });
  }
}
