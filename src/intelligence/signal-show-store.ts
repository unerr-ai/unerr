/**
 * SignalShowStore — persistent, cross-session rotation state for `ur|act`,
 * `ur|ctx`, `ur|rsk`, `ur|fct`, conventions, and any other deduplicated signal.
 *
 * Backed by `signal_shows` relation in timeline.db (per-session rows, no write
 * contention across parallel `unerr --mcp` instances). Each session writes
 * only its own (signal_id, session_id) row; aggregate state is SUM/MAX over
 * all rows for the signal_id.
 *
 * Hot path stays sync: the ranker calls `getEffectiveShowCount(id, now)` which
 * reads only the in-memory cache (this-session counts + aggregated other-session
 * snapshot). DB I/O happens off the hot path on the flush interval.
 *
 * Decay: `effective_shows = count × exp(−(now − lastShownMs)/24h)`. Yesterday's
 * shows naturally fall out of weight without requiring explicit pruning.
 */

import type { CozoDb } from "./cozo-schema.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_FLUSH_INTERVAL_MS = 10_000;

interface ShowAggregate {
  count: number;
  lastShownMs: number;
}

export interface SignalShowStoreOptions {
  flushIntervalMs?: number;
  /** Per-day decay factor for time-weighted show counts. Default 24h half-life-ish. */
  decayWindowMs?: number;
}

export class SignalShowStore {
  private readonly db: CozoDb;
  private readonly sessionId: string;
  private readonly flushIntervalMs: number;
  private readonly decayWindowMs: number;

  /** This session's per-signal show counts; flushed to DB periodically. */
  private readonly mineCount = new Map<string, number>();
  private readonly mineScope = new Map<string, string>();
  private readonly mineLastShown = new Map<string, number>();
  /** Dirty keys awaiting flush. */
  private readonly dirty = new Set<string>();

  /**
   * Cached snapshot of *other* sessions' aggregated counts. Refreshed every
   * flush tick; combined with `mineCount` to produce effective counts for
   * the ranker. Initialized empty until first hydrate().
   */
  private othersSnapshot = new Map<string, ShowAggregate>();

  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private hydrated = false;
  private closed = false;

  constructor(
    db: CozoDb,
    sessionId: string,
    opts: SignalShowStoreOptions = {}
  ) {
    this.db = db;
    this.sessionId = sessionId;
    this.flushIntervalMs = opts.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS;
    this.decayWindowMs = opts.decayWindowMs ?? DAY_MS;
  }

  /**
   * Load initial snapshot of other sessions' counts and start the periodic
   * flush+refresh loop. Idempotent.
   */
  async start(): Promise<void> {
    if (this.hydrated) return;
    await this.refreshOthersSnapshot();
    this.hydrated = true;

    if (this.flushTimer === null && !this.closed) {
      this.flushTimer = setInterval(() => {
        // Fire and forget; errors logged but never thrown to break the interval.
        this.tick().catch(() => {});
      }, this.flushIntervalMs);
      // Don't keep the event loop alive solely for the flush timer.
      this.flushTimer.unref?.();
    }
  }

  /** Record that the agent just emitted this signal. Sync — no DB I/O. */
  recordShown(signalId: string, scope: string, now: number = Date.now()): void {
    if (!signalId) return;
    this.mineCount.set(signalId, (this.mineCount.get(signalId) ?? 0) + 1);
    this.mineScope.set(signalId, scope || "");
    this.mineLastShown.set(signalId, now);
    this.dirty.add(signalId);
  }

  /**
   * Effective (time-decayed) show count for ranking. Sums this-session count
   * and the cached snapshot of all other sessions' counts, then applies a
   * 24h exponential decay against the most recent shown timestamp.
   */
  getEffectiveShowCount(signalId: string, now: number = Date.now()): number {
    if (!signalId) return 0;
    const mine = this.mineCount.get(signalId) ?? 0;
    const others = this.othersSnapshot.get(signalId);
    const totalCount = mine + (others?.count ?? 0);
    if (totalCount === 0) return 0;
    const myLast = this.mineLastShown.get(signalId) ?? 0;
    const lastShown = Math.max(myLast, others?.lastShownMs ?? 0);
    if (lastShown === 0) return totalCount;
    const ageMs = Math.max(0, now - lastShown);
    return totalCount * Math.exp(-ageMs / this.decayWindowMs);
  }

  /**
   * When was this signal last shown (in any session)? Used for cross-channel
   * dedup window and for "stale" re-show logic on conventions.
   */
  getLastShownMs(signalId: string): number {
    if (!signalId) return 0;
    const mine = this.mineLastShown.get(signalId) ?? 0;
    const others = this.othersSnapshot.get(signalId)?.lastShownMs ?? 0;
    return Math.max(mine, others);
  }

  /** Flush dirty rows AND refresh the other-sessions snapshot. */
  async tick(): Promise<void> {
    if (this.closed) return;
    await this.flush();
    await this.refreshOthersSnapshot();
  }

  /** Write this session's dirty entries to timeline.db. */
  async flush(): Promise<void> {
    if (this.dirty.size === 0) return;
    const ids = Array.from(this.dirty);
    this.dirty.clear();
    for (const signalId of ids) {
      const count = this.mineCount.get(signalId) ?? 0;
      const scope = this.mineScope.get(signalId) ?? "";
      const last = this.mineLastShown.get(signalId) ?? 0;
      try {
        await this.db.run(
          `?[signal_id, session_id, scope, count, last_shown_ms] <- [[$sid, $sess, $scope, $count, $last]]
           :put signal_shows { signal_id, session_id => scope, count, last_shown_ms }`,
          {
            sid: signalId,
            sess: this.sessionId,
            scope,
            count,
            last,
          }
        );
      } catch {
        // Restore to dirty so the next tick retries; don't lose updates.
        this.dirty.add(signalId);
      }
    }
  }

  /** Stop the periodic flush; final flush. Safe to call multiple times. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.flushTimer !== null) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
    await this.flush();
  }

  /**
   * Read aggregated counts from rows belonging to *other* sessions. Self rows
   * are excluded so the in-memory `mineCount` remains the authoritative source
   * for this session — otherwise we'd double-count after each flush.
   */
  private async refreshOthersSnapshot(): Promise<void> {
    try {
      const result = await this.db.run(
        `?[signal_id, total_count, last] :=
           *signal_shows{signal_id, session_id, count, last_shown_ms},
           session_id != $sess,
           total_count = count,
           last = last_shown_ms`,
        { sess: this.sessionId }
      );
      // Aggregate in TS — Cozo's group-by syntax varies by version; this is
      // simpler and the row count is small (one row per (signal_id, session_id)).
      const agg = new Map<string, ShowAggregate>();
      for (const row of result.rows) {
        const sid = row[0] as string;
        const c = Number(row[1] ?? 0);
        const last = Number(row[2] ?? 0);
        const prev = agg.get(sid);
        if (prev) {
          prev.count += c;
          if (last > prev.lastShownMs) prev.lastShownMs = last;
        } else {
          agg.set(sid, { count: c, lastShownMs: last });
        }
      }
      this.othersSnapshot = agg;
    } catch {
      // First-run / schema-missing: leave snapshot empty. Will retry next tick.
    }
  }
}
