/**
 * Sprint 10.1: Working Snapshot Management.
 *
 * Manages "known-good" state snapshots. The developer (or agent) marks
 * "this works" after tests pass, before risky changes, or at session start.
 * These snapshots become rewind targets for deterministic rewind (Task 10.2).
 *
 * Storage: `.unerr/snapshots/{id}.json`
 * Processing: deferred to ledger flush.
 *
 * Design authority: Phase 5.5 Flow 2 (State Validated → Working Snapshot Created)
 */

import { randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

/** stderr logger */
const _log = {
  info: (msg: string) => process.stderr.write(`[unerr:snapshot] ${msg}\n`),
  warn: (msg: string) =>
    process.stderr.write(`[unerr:snapshot] WARN: ${msg}\n`),
};

export interface WorkingSnapshot {
  /** Unique snapshot ID (snap_ + 12-char hex) */
  id: string;
  /** Git commit SHA at time of snapshot */
  commitSha: string;
  /** Human-readable reason for the snapshot */
  reason: string;
  /** ISO timestamp */
  timestamp: string;
  /** Git branch at time of snapshot */
  branch: string;
  /** Timeline branch counter (from branch_context.json) */
  timelineBranch: number;
  /** Session ID that created this snapshot */
  sessionId: string;
  /** Whether this snapshot has been marked as processed */
  processed: boolean;
}

/** Maximum snapshots retained locally (oldest evicted). */
const MAX_SNAPSHOTS = 50;

/** Auto-snapshot cooldown: don't auto-snapshot within 1 hour of last. */
const AUTO_SNAPSHOT_COOLDOWN_MS = 60 * 60 * 1000;

export class WorkingSnapshotStore {
  private snapshotDir: string;
  private unerrDir: string;

  constructor(unerrDir: string) {
    this.unerrDir = unerrDir;
    this.snapshotDir = join(unerrDir, "snapshots");
    if (!existsSync(this.snapshotDir)) {
      mkdirSync(this.snapshotDir, { recursive: true });
    }
  }

  /**
   * Create a new working snapshot.
   */
  create(opts: {
    commitSha: string;
    reason: string;
    branch: string;
    timelineBranch: number;
    sessionId: string;
  }): WorkingSnapshot {
    const id = `snap_${randomBytes(6).toString("hex")}`;

    const snapshot: WorkingSnapshot = {
      id,
      commitSha: opts.commitSha,
      reason: opts.reason,
      timestamp: new Date().toISOString(),
      branch: opts.branch,
      timelineBranch: opts.timelineBranch,
      sessionId: opts.sessionId,
      processed: false,
    };

    writeFileSync(
      join(this.snapshotDir, `${id}.json`),
      JSON.stringify(snapshot, null, 2),
      "utf-8"
    );

    _log.info(
      `Created snapshot ${id} at ${opts.commitSha.slice(0, 8)} (${opts.reason})`
    );

    // Enforce cap
    this.enforceCap();

    return snapshot;
  }

  /**
   * Get a snapshot by ID.
   */
  get(snapshotId: string): WorkingSnapshot | null {
    const filePath = join(this.snapshotDir, `${snapshotId}.json`);
    if (!existsSync(filePath)) return null;

    try {
      return JSON.parse(readFileSync(filePath, "utf-8")) as WorkingSnapshot;
    } catch {
      return null;
    }
  }

  /**
   * List all snapshots, most recent first.
   */
  list(): WorkingSnapshot[] {
    if (!existsSync(this.snapshotDir)) return [];

    const files = readdirSync(this.snapshotDir).filter((f) =>
      f.endsWith(".json")
    );

    const snapshots: WorkingSnapshot[] = [];
    for (const file of files) {
      try {
        const raw = readFileSync(join(this.snapshotDir, file), "utf-8");
        snapshots.push(JSON.parse(raw) as WorkingSnapshot);
      } catch {
        // Skip corrupted files
      }
    }

    // Sort by timestamp descending
    snapshots.sort(
      (a, b) =>
        new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
    );

    return snapshots;
  }

  /**
   * Get the most recent snapshot (rewind target).
   */
  getLatest(): WorkingSnapshot | null {
    const snapshots = this.list();
    return snapshots[0] ?? null;
  }

  /**
   * Get the most recent snapshot for a specific branch.
   */
  getLatestForBranch(branch: string): WorkingSnapshot | null {
    const snapshots = this.list();
    return snapshots.find((s) => s.branch === branch) ?? null;
  }

  /**
   * Check if auto-snapshot should be created (no recent snapshot within cooldown).
   */
  shouldAutoSnapshot(): boolean {
    const latest = this.getLatest();
    if (!latest) return true;

    const age = Date.now() - new Date(latest.timestamp).getTime();
    return age > AUTO_SNAPSHOT_COOLDOWN_MS;
  }

  /**
   * Mark a snapshot as processed.
   */
  markProcessed(snapshotId: string): void {
    const snapshot = this.get(snapshotId);
    if (!snapshot) return;

    snapshot.processed = true;
    writeFileSync(
      join(this.snapshotDir, `${snapshotId}.json`),
      JSON.stringify(snapshot, null, 2),
      "utf-8"
    );
  }

  /**
   * Get all unprocessed snapshots (for ledger flush).
   */
  getUnprocessed(): WorkingSnapshot[] {
    return this.list().filter((s) => !s.processed);
  }

  /**
   * Delete a snapshot.
   */
  delete(snapshotId: string): boolean {
    const filePath = join(this.snapshotDir, `${snapshotId}.json`);
    if (!existsSync(filePath)) return false;

    rmSync(filePath);
    return true;
  }

  /**
   * Get the timeline branch counter from branch_context.json.
   */
  getTimelineBranch(): number {
    const contextPath = join(this.unerrDir, "branch_context.json");
    if (!existsSync(contextPath)) return 0;

    try {
      const ctx = JSON.parse(readFileSync(contextPath, "utf-8")) as {
        timelineBranch?: number;
      };
      return ctx.timelineBranch ?? 0;
    } catch {
      return 0;
    }
  }

  /**
   * Increment the timeline branch counter. Returns the new value.
   */
  incrementTimelineBranch(): number {
    const contextPath = join(this.unerrDir, "branch_context.json");
    let ctx: Record<string, unknown> = {};

    if (existsSync(contextPath)) {
      try {
        ctx = JSON.parse(readFileSync(contextPath, "utf-8")) as Record<
          string,
          unknown
        >;
      } catch {
        ctx = {};
      }
    }

    const current = (ctx.timelineBranch as number) ?? 0;
    ctx.timelineBranch = current + 1;

    writeFileSync(contextPath, JSON.stringify(ctx, null, 2), "utf-8");
    return current + 1;
  }

  /**
   * Enforce max snapshot cap — evict oldest beyond limit.
   */
  private enforceCap(): void {
    const snapshots = this.list();
    if (snapshots.length <= MAX_SNAPSHOTS) return;

    const toRemove = snapshots.slice(MAX_SNAPSHOTS);
    for (const snapshot of toRemove) {
      this.delete(snapshot.id);
      _log.info(`Evicted old snapshot: ${snapshot.id}`);
    }
  }
}
