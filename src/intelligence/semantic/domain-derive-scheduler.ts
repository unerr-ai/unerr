/**
 * Layer 8 — debounced domain-graph re-derive for the live-edit path.
 *
 * The full index runs `deriveDomainGraph` (propagation → community vote →
 * domain edges) once per pass. Incremental indexing only refreshes the raw
 * `domain_annotations` rows (and inline comment-drift); it intentionally skips
 * the global derive, which is O(communities + edges) and wasteful to run on
 * every keystroke-triggered save.
 *
 * This scheduler closes the gap without paying that cost per edit: each
 * annotation-touching incremental batch calls `schedule()`, which (re)arms a
 * single debounce timer. After a quiet window the derive runs ONCE over the
 * current graph, coalescing a save-storm into one refresh. The community
 * membership itself is still corrected only at the next full reindex (Louvain
 * is not re-run here) — but the domain vote / propagated labels / domain edges
 * track live annotations within seconds instead of waiting for the idle full
 * rebuild.
 *
 * Concurrency-safe: a derive requested while one is in flight is coalesced into
 * exactly one follow-up run (never overlapping, never lost). Best-effort: a
 * derive failure is reported via `onError` and never throws into the caller.
 */

import type { AnnotationDb } from "./annotation-indexer.js";
import { type DomainGraphResult, deriveDomainGraph } from "./domain-graph.js";

/**
 * Debounce window. Shorter than the GraphHolder idle-reindex threshold (5s) so
 * domain labels refresh BEFORE the next full rebuild, long enough to coalesce a
 * burst of file saves into one derive.
 */
export const DOMAIN_DERIVE_DEBOUNCE_MS = 2000;

export interface DomainDeriveSchedulerOptions {
  /**
   * Resolve the graph db to derive against AT FIRE TIME — not at construction.
   * The graph is swapped on full reindex, so a live getter (e.g.
   * `() => liveGraph.db`) ensures the derive always targets the current graph
   * and never a retired/closed instance. Return null to skip the derive.
   */
  getDb: () => AnnotationDb | null;
  /** Override the debounce window (ms). Defaults to {@link DOMAIN_DERIVE_DEBOUNCE_MS}. */
  debounceMs?: number;
  /** Injection seam for tests; defaults to the real `deriveDomainGraph`. */
  deriveFn?: (db: AnnotationDb) => Promise<DomainGraphResult>;
  /** Called after each successful derive with its result (for logging/telemetry). */
  onDerive?: (result: DomainGraphResult) => void;
  /** Called when a derive throws. The scheduler swallows the error after this. */
  onError?: (err: unknown) => void;
}

export class DomainDeriveScheduler {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private rerunRequested = false;
  private stopped = false;
  private currentRun: Promise<void> | null = null;

  private readonly getDb: () => AnnotationDb | null;
  private readonly debounceMs: number;
  private readonly deriveFn: (db: AnnotationDb) => Promise<DomainGraphResult>;
  private readonly onDerive?: (result: DomainGraphResult) => void;
  private readonly onError?: (err: unknown) => void;

  constructor(opts: DomainDeriveSchedulerOptions) {
    this.getDb = opts.getDb;
    this.debounceMs = opts.debounceMs ?? DOMAIN_DERIVE_DEBOUNCE_MS;
    this.deriveFn = opts.deriveFn ?? deriveDomainGraph;
    this.onDerive = opts.onDerive;
    this.onError = opts.onError;
  }

  /**
   * (Re)arm the debounce timer. Repeated calls within the window collapse to a
   * single derive that runs `debounceMs` after the LAST call. No-op once
   * stopped.
   */
  schedule(): void {
    if (this.stopped) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.fire();
    }, this.debounceMs);
    // Never let a pending derive keep the process alive on its own.
    this.timer.unref?.();
  }

  /**
   * Run a derive now, awaiting completion (bypasses the debounce). Used by tests
   * and any deterministic flush point. If a derive is already running, awaits it
   * (and the coalesced follow-up, if one was requested) rather than starting an
   * overlapping pass.
   */
  async flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    await this.fire();
  }

  /** Cancel any pending timer and refuse further work. Idempotent. */
  stop(): void {
    this.stopped = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  /** True while a derive is in flight (for tests/telemetry). */
  get isRunning(): boolean {
    return this.running;
  }

  private fire(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    // A derive is already running: coalesce into exactly one follow-up and
    // await the in-flight pass so flush() callers see it through.
    if (this.running) {
      this.rerunRequested = true;
      return this.currentRun ?? Promise.resolve();
    }
    this.running = true;
    this.currentRun = (async () => {
      try {
        const db = this.getDb();
        if (db) {
          const result = await this.deriveFn(db);
          this.onDerive?.(result);
        }
      } catch (err) {
        this.onError?.(err);
      } finally {
        this.running = false;
        this.currentRun = null;
        const rerun = this.rerunRequested && !this.stopped;
        this.rerunRequested = false;
        if (rerun) this.schedule();
      }
    })();
    return this.currentRun;
  }
}
