/**
 * Background Index Runner — Sprint L11.1
 *
 * Non-blocking wrapper around `indexLocalProject()` that runs indexing
 * as an async task. Exposes observable progress state that the proxy,
 * query router, and ora spinner can poll at any time.
 *
 * Contract TL-25: MCP server starts within 2 seconds of boot.
 * Contract TL-26: Background indexing never blocks the MCP event loop.
 * Contract TL-30: Zero LLM calls during indexing (tree-sitter only).
 */

import type { CozoGraphStore } from "./local-graph.js";
import type { IndexProgressEvent, IndexResult } from "./local-indexer.js";

// ── Types ────────────────────────────────────────────────────────

export type IndexingStatus = "idle" | "indexing" | "complete" | "error";

export interface IndexingProgress {
  /** Number of files processed so far */
  processed: number;
  /** Total number of files to index */
  total: number;
  /** Current indexing phase */
  phase: string;
  /** Percentage complete (0-100) */
  pct: number;
  /** File currently being processed */
  currentFile: string | null;
}

export interface BackgroundIndexerState {
  status: IndexingStatus;
  progress: IndexingProgress;
  result: IndexResult | null;
  error: Error | null;
  startedAt: number | null;
  completedAt: number | null;
}

// ── BackgroundIndexer ────────────────────────────────────────────

export class BackgroundIndexer {
  private _status: IndexingStatus = "idle";
  private _processed = 0;
  private _total = 0;
  private _phase = "";
  private _currentFile: string | null = null;
  private _result: IndexResult | null = null;
  private _error: Error | null = null;
  private _startedAt: number | null = null;
  private _completedAt: number | null = null;

  /**
   * Start background indexing. Returns immediately — indexing runs
   * as an async microtask that yields to the event loop between files.
   *
   * @param projectRoot - Absolute path to the project root
   * @param graphStore - CozoGraphStore instance (schema already initialized)
   * @param repoId - Repository ID for entity key generation
   * @param onComplete - Called when indexing finishes successfully
   * @param onError - Called if indexing fails (proxy continues with empty graph)
   */
  start(
    projectRoot: string,
    graphStore: CozoGraphStore,
    repoId: string,
    onComplete: (result: IndexResult) => void,
    onError: (err: Error) => void
  ): void {
    if (this._status === "indexing") return; // Already running

    this._status = "indexing";
    this._startedAt = Date.now();
    this._processed = 0;
    this._total = 0;
    this._phase = "discovering";
    this._currentFile = null;
    this._result = null;
    this._error = null;
    this._completedAt = null;

    // Fire-and-forget async — does not block the caller
    this.runIndexing(projectRoot, graphStore, repoId, onComplete, onError);
  }

  /** Whether indexing is currently in progress. */
  isIndexing(): boolean {
    return this._status === "indexing";
  }

  /** Whether indexing has completed successfully. */
  isComplete(): boolean {
    return this._status === "complete";
  }

  /** Current status. */
  getStatus(): IndexingStatus {
    return this._status;
  }

  /** Current progress snapshot (safe to poll from any module). */
  getProgress(): IndexingProgress {
    const pct =
      this._total > 0 ? Math.round((this._processed / this._total) * 100) : 0;
    return {
      processed: this._processed,
      total: this._total,
      phase: this._phase,
      pct,
      currentFile: this._currentFile,
    };
  }

  /** Full state snapshot. */
  getState(): BackgroundIndexerState {
    return {
      status: this._status,
      progress: this.getProgress(),
      result: this._result,
      error: this._error,
      startedAt: this._startedAt,
      completedAt: this._completedAt,
    };
  }

  /** Index result (null if not yet complete). */
  getResult(): IndexResult | null {
    return this._result;
  }

  /** Error (null if no error). */
  getError(): Error | null {
    return this._error;
  }

  /** Elapsed time in milliseconds since indexing started. */
  getElapsedMs(): number {
    if (!this._startedAt) return 0;
    const end = this._completedAt ?? Date.now();
    return end - this._startedAt;
  }

  // ── Internal ──────────────────────────────────────────────────

  private async runIndexing(
    projectRoot: string,
    graphStore: CozoGraphStore,
    repoId: string,
    onComplete: (result: IndexResult) => void,
    onError: (err: Error) => void
  ): Promise<void> {
    try {
      const { indexLocalProject } = await import("./local-indexer.js");

      const result = await indexLocalProject(projectRoot, graphStore, repoId, {
        onProgress: (event: IndexProgressEvent) => {
          this._processed = event.processed;
          this._total = event.total;
          this._phase = event.phase;
          this._currentFile = event.currentFile;
        },
      });

      this._status = "complete";
      this._result = result;
      this._completedAt = Date.now();
      onComplete(result);
    } catch (err: unknown) {
      this._status = "error";
      this._error = err instanceof Error ? err : new Error(String(err));
      this._completedAt = Date.now();
      onError(this._error);
    }
  }
}
