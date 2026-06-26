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
  changedFiles: string[]
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
   * Periodic full-reindex cadence — after this many incremental cycles, run a
   * full reindex. Default: 200.
   *
   * This is NOT a correctness counter (referential integrity is enforced by the
   * cheaper invariant check below). Its job is to refresh the derived layers
   * the incremental path deliberately SKIPS — community detection (Louvain),
   * convention detection, SCIP enrichment, co-change edges, and L1 edge
   * materialization — which would otherwise go stale indefinitely. A full
   * reindex is the expensive, latency-spiking path (re-scans the whole repo and
   * atomically swaps the graph), so the cadence is kept high (200) to stay
   * invisible during normal editing while still refreshing derived data.
   */
  fullReindexEveryNCycles?: number;
  /**
   * Correctness-check cadence — every this many incremental cycles, run the
   * cheap referential-integrity check (verifyGraphInvariants). Default: 50.
   *
   * On divergence the holder full-reindexes EARLY (before the periodic cadence)
   * to repair the graph; on a clean check it keeps taking the fast incremental
   * path. The check is count-only Datalog (no full scan via the edges:rev
   * index) so running it 4× as often as a full reindex is effectively free.
   * Must be ≤ fullReindexEveryNCycles to be meaningful.
   */
  invariantCheckEveryNCycles?: number;
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
  private readonly invariantCheckEveryNCycles: number;
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
    this.fullReindexEveryNCycles = config?.fullReindexEveryNCycles ?? 200;
    this.invariantCheckEveryNCycles = config?.invariantCheckEveryNCycles ?? 50;
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
   *
   * Decision order:
   *   1. Incremental is inapplicable (no factory / too many files) → full reindex.
   *   2. Periodic cadence reached (≥ fullReindexEveryNCycles) → full reindex to
   *      refresh derived layers (communities, SCIP, conventions, L1, co-change).
   *   3. Correctness cadence reached (multiple of invariantCheckEveryNCycles) →
   *      run the cheap referential-integrity check; full reindex EARLY only if
   *      it diverges, otherwise stay incremental.
   *   4. Otherwise → incremental.
   */
  private triggerRebuild(): void {
    if (!this.rebuildFactory) return;
    if (this.fileChangesSinceLastRebuild === 0) return; // No changes since last rebuild

    if (this.rebuilding) {
      this.rebuildPending = true;
      return;
    }

    // Guard the counter/set desync that drove the full-reindex storm: the
    // change counter can read > 0 while changedFilePaths is empty (a queued
    // rebuildPending re-fires triggerRebuild after a rebuild already consumed
    // the captured paths). An empty set means there is nothing to index, so a
    // full reindex here would re-scan the whole repo for no reason and, under
    // continued edits, loop every ~22s. Reconcile and bail. proxy.ts is the
    // only notifier and always passes non-empty paths, so an empty set is never
    // a legitimate "unknown change" signal.
    if (this.changedFilePaths.size === 0) {
      this.fileChangesSinceLastRebuild = 0;
      return;
    }

    this.rebuilding = true;
    const changesAtStart = this.fileChangesSinceLastRebuild;
    const changedFiles = [...this.changedFilePaths];
    const startMs = Date.now();

    const canIncremental =
      this.incrementalFactory !== null &&
      changedFiles.length > 0 &&
      changedFiles.length <= this.incrementalFileLimit;

    if (!canIncremental) {
      this.runFullRebuild(changedFiles, changesAtStart, startMs);
      return;
    }

    const n = this.incrementalCycleCount;

    // (2) Periodic full refresh of derived layers + drift backstop.
    if (n >= this.fullReindexEveryNCycles) {
      _log.info(
        `Periodic full reindex (derived-layer refresh after ${n} incremental cycles)`
      );
      this.incrementalCycleCount = 0;
      this.runFullRebuild(changedFiles, changesAtStart, startMs);
      return;
    }

    // (3) Correctness gate: at the check cadence, verify referential integrity
    // and full-reindex early only on divergence.
    if (n > 0 && n % this.invariantCheckEveryNCycles === 0) {
      this.checkInvariantsAndDispatch(changedFiles, changesAtStart, startMs);
      return;
    }

    // (4) Default fast path.
    this.runIncremental(changedFiles, changesAtStart, startMs);
  }

  /**
   * Run the referential-integrity check, then dispatch: incremental on a clean
   * graph, full reindex on divergence. Errors/timeouts are treated as "clean"
   * so a transient query failure never forces an expensive reindex — the
   * periodic cadence (fullReindexEveryNCycles) remains the backstop.
   */
  private checkInvariantsAndDispatch(
    changedFiles: string[],
    changesAtStart: number,
    startMs: number
  ): void {
    this.verifyGraphInvariants()
      .then(async (result) => {
        if (result.ok) {
          this.runIncremental(changedFiles, changesAtStart, startMs);
          return;
        }
        // Divergence found. Incremental indexing STRUCTURALLY leaves a few
        // orphans between full reindexes: it re-keys an entity on a signature
        // change (entityKey hashes the signature) and does not maintain the
        // full-index-only edge types (tests, co_changes), so their endpoints
        // dangle. Treating that as a full-reindex trigger means a 40-70s
        // reindex fires on essentially every check — a reindex storm that
        // starves the MCP handshake and drift queries. So repair cheaply
        // in place first (set-based :rm of orphan edges + file_index rows),
        // re-verify, and full-reindex ONLY if the sweep can't restore
        // integrity (true structural divergence).
        _log.info(
          `Referential-integrity check found drift (${result.reason}) — sweeping orphans in place`
        );
        const removed = await this.sweepOrphans();
        const recheck = await this.verifyGraphInvariants();
        if (recheck.ok) {
          _log.info(
            `Orphan sweep healed the graph (${removed} rows removed) — staying incremental`
          );
          this.runIncremental(changedFiles, changesAtStart, startMs);
        } else {
          _log.warn(
            `Orphan sweep did not resolve divergence (${recheck.reason}) after ${this.incrementalCycleCount} cycles — full reindex to repair`
          );
          this.incrementalCycleCount = 0;
          this.runFullRebuild(changedFiles, changesAtStart, startMs);
        }
      })
      .catch(() => {
        // Check (or sweep) itself failed — don't punish with a full reindex;
        // stay incremental and let the periodic cadence backstop any real drift.
        this.runIncremental(changedFiles, changesAtStart, startMs);
      });
  }

  /**
   * Cheap, in-place repair of the referential-integrity violations that
   * verifyGraphInvariants detects: delete orphan edges (either endpoint no
   * longer in entities) and orphan file_index rows. Three set-based :rm
   * writes, each independent of graph size — no full reindex. The orphan
   * lookup reuses the same `not *entities{key: …}` anti-join the check uses,
   * so a sweep clears exactly what the next check would flag. Returns the
   * number of rows removed (best-effort; correctness comes from the caller's
   * re-verify, not this count).
   */
  private async sweepOrphans(): Promise<number> {
    let removed = 0;
    // Count each orphan class (CozoDB :rm returns a status row, not a deleted-
    // row count, so we count first), then delete it in one set-based :rm.
    const sweeps: Array<{ count: string; rm: string }> = [
      {
        count: "?[count(to_key)] := *edges{to_key}, not *entities{key: to_key}",
        rm: "?[from_key, to_key, type] := *edges{from_key, to_key, type}, not *entities{key: to_key} :rm edges { from_key, to_key, type }",
      },
      {
        count:
          "?[count(from_key)] := *edges{from_key}, not *entities{key: from_key}",
        rm: "?[from_key, to_key, type] := *edges{from_key, to_key, type}, not *entities{key: from_key} :rm edges { from_key, to_key, type }",
      },
      {
        count:
          "?[count(entity_key)] := *file_index{entity_key}, not *entities{key: entity_key}",
        rm: "?[file_path, entity_key] := *file_index{file_path, entity_key}, not *entities{key: entity_key} :rm file_index { file_path, entity_key }",
      },
    ];
    for (const { count, rm } of sweeps) {
      try {
        const c = await this.current.query(count);
        removed += Number((c.rows[0]?.[0] as number | undefined) ?? 0);
        await this.current.write(rm);
      } catch {
        /* best-effort — a failed sweep just leaves the re-check to escalate */
      }
    }
    return removed;
  }

  /**
   * Cheap referential-integrity check over the active graph. Detects the drift
   * classes incremental indexing can introduce on a bug or partial failure:
   *   - file_index rows whose entity_key no longer exists in entities
   *   - edges whose to_key / from_key endpoint no longer exists in entities
   * Each is a count-only Datalog query; the to_key scan rides the edges:rev
   * index. Returns { ok:false, reason } on the first divergence found.
   */
  private async verifyGraphInvariants(): Promise<{
    ok: boolean;
    reason?: string;
  }> {
    const CHECK_TIMEOUT_MS = 5_000;
    const count = async (script: string): Promise<number> => {
      const r = await this.current.query(script, undefined, CHECK_TIMEOUT_MS);
      return Number((r.rows[0]?.[0] as number | undefined) ?? 0);
    };

    const orphanFileIndex = await count(
      "?[count(entity_key)] := *file_index{entity_key}, not *entities{key: entity_key}"
    );
    if (orphanFileIndex > 0) {
      return {
        ok: false,
        reason: `${orphanFileIndex} file_index rows reference missing entities`,
      };
    }

    const orphanEdgeTo = await count(
      "?[count(to_key)] := *edges:rev{to_key}, not *entities{key: to_key}"
    );
    if (orphanEdgeTo > 0) {
      return {
        ok: false,
        reason: `${orphanEdgeTo} edges point to missing entities`,
      };
    }

    const orphanEdgeFrom = await count(
      "?[count(from_key)] := *edges{from_key}, not *entities{key: from_key}"
    );
    if (orphanEdgeFrom > 0) {
      return {
        ok: false,
        reason: `${orphanEdgeFrom} edges originate from missing entities`,
      };
    }

    return { ok: true };
  }

  private runIncremental(
    changedFiles: string[],
    changesAtStart: number,
    startMs: number
  ): void {
    _log.info(`Incremental indexing ${changedFiles.length} files...`);

    this.incrementalFactory?.(changedFiles)
      .then((result) => {
        // Clear tracked files that were processed
        for (const fp of changedFiles) {
          this.changedFilePaths.delete(fp);
        }
        this.fileChangesSinceLastRebuild = Math.max(
          0,
          this.fileChangesSinceLastRebuild - changesAtStart
        );
        this.lastRebuildTimestamp = Date.now();
        this.incrementalCycleCount++;

        _log.info(
          `Incremental done in ${Date.now() - startMs}ms — ` +
            `+${result.entitiesAdded}/-${result.entitiesDeleted}/~${result.entitiesUpdated} entities, ` +
            `+${result.edgesAdded}/-${result.edgesDeleted} edges`
        );

        // Notify swap callbacks (graph is same instance, but data changed)
        for (const cb of this.swapCallbacks) {
          try {
            cb(this.current);
          } catch (err) {
            _log.warn(
              `Swap callback failed: ${err instanceof Error ? err.message : String(err)}`
            );
          }
        }
      })
      .catch((err: unknown) => {
        _log.warn(
          `Incremental indexing failed: ${err instanceof Error ? err.message : String(err)}. Falling back to full reindex.`
        );
        // Fallback to full reindex
        this.runFullRebuild(changedFiles, changesAtStart, startMs);
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

  private runFullRebuild(
    changedFiles: string[],
    changesAtStart: number,
    startMs: number
  ): void {
    _log.info(
      `Full reindex (${changesAtStart} file changes since last rebuild)...`
    );

    this.rebuildFactory?.()
      .then(({ graph: newGraph, result }) => {
        const oldGraph = this.current;
        this.current = newGraph;

        // Propagate to all consumers
        for (const cb of this.swapCallbacks) {
          try {
            cb(newGraph);
          } catch (err) {
            _log.warn(
              `Swap callback failed: ${err instanceof Error ? err.message : String(err)}`
            );
          }
        }

        // Drop only the paths this rebuild captured at start. Paths added by
        // edits that arrived DURING the ~22s rebuild were never indexed and
        // must survive to the next cycle. The previous clear() wiped them,
        // leaving the counter > 0 with an empty set, which collapsed the next
        // decision to canIncremental=false and re-fired a full reindex over
        // zero files — a self-sustaining full-reindex storm.
        for (const fp of changedFiles) {
          this.changedFilePaths.delete(fp);
        }
        this.fileChangesSinceLastRebuild = Math.max(
          0,
          this.fileChangesSinceLastRebuild - changesAtStart
        );
        this.lastRebuildTimestamp = Date.now();

        _log.info(
          `Graph rebuilt in ${Date.now() - startMs}ms — ${result.entityCount} entities, ${result.edgeCount} edges. Swapped.`
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
          `Graph rebuild failed: ${err instanceof Error ? err.message : String(err)}`
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
