/**
 * Append-only JSONL store for unlock events.
 *
 * Every time `unlock-evaluator.ts` emits a non-empty event list, the proxy
 * calls `ToolExposureStore.append(events)` with that list. Records are
 * written one-per-line to `<unerrDir>/router/exposure-events.jsonl`.
 *
 * Why JSONL, not SQLite:
 *   - The write rate is bounded — a session produces at most one event
 *     per tier-2/3 tool (14 total) before saturation. SQLite open/close
 *     overhead would dominate.
 *   - The reader (dashboard, debug commands) needs only forward-scan
 *     semantics. JSONL is line-greppable and `tail -f`-friendly.
 *   - Crash safety: each `append()` is a single `fs.appendFile()` call
 *     under O_APPEND. Partial writes are impossible for sub-block records
 *     on POSIX and Win32 (a single line is < 256 bytes here).
 *
 * Retention: `prune()` drops records older than the retention window and
 * caps the total, rewriting the file atomically. It is fired once per
 * process from `RouterGateway`'s constructor. (Previously this module
 * claimed `archiveShadowLedger` swept it "in the same sweep" — that routine
 * only touches `<unerrDir>/ledger/`, never `router/`, so the file actually
 * grew unbounded.)
 */

import { promises as fs } from "node:fs";
import { dirname, join } from "node:path";

import type { UnlockEvent } from "./unlock-evaluator.js";

/** Records older than this are dropped by `prune()`. */
export const EXPOSURE_RETENTION_DAYS = 7;
/** Hard backstop on retained records, regardless of age. Newest kept. */
export const EXPOSURE_MAX_RECORDS = 10_000;

/** On-disk representation. Stable across versions — additive only. */
export interface ExposureEventRecord {
  /** Schema version. Bumped only on breaking field changes. */
  readonly v: 1;
  /** Stable session identifier — matches proxy's session_id. */
  readonly session_id: string;
  /** Tool whose exposure just toggled to true. */
  readonly tool: string;
  /** Human-readable condition that fired. */
  readonly reason: string;
  /** Turn count at the moment of firing. */
  readonly turn: number;
  /** Wall-clock ms (UTC) at firing. */
  readonly ts: number;
}

/**
 * Persist-once-per-process store. Construct with the per-repo `.unerr/`
 * absolute path and a session id. The store creates `<unerrDir>/router/`
 * lazily on first append; idle sessions write zero bytes.
 */
export class ToolExposureStore {
  private readonly filePath: string;
  private readonly sessionId: string;
  private ensuredDir = false;

  constructor(unerrDir: string, sessionId: string) {
    this.filePath = join(unerrDir, "router", "exposure-events.jsonl");
    this.sessionId = sessionId;
  }

  /**
   * Append one record per event. Returns the number of bytes written
   * (useful for tests and telemetry). Calls with an empty array are
   * cheap no-ops — no fs syscall is issued.
   *
   * Errors are surfaced to the caller; the proxy's wrapper logs and
   * continues. Persistence failure must not block tool exposure: the
   * in-memory `SessionState.expose()` has already mutated by this point.
   */
  async append(events: readonly UnlockEvent[]): Promise<number> {
    if (events.length === 0) return 0;

    if (!this.ensuredDir) {
      await fs.mkdir(dirname(this.filePath), { recursive: true });
      this.ensuredDir = true;
    }

    const lines = events.map((e) => {
      const rec: ExposureEventRecord = {
        v: 1,
        session_id: this.sessionId,
        tool: e.toolName,
        reason: e.reasonText,
        turn: e.firedAtTurn,
        ts: e.timestampMs,
      };
      return `${JSON.stringify(rec)}\n`;
    });
    const payload = lines.join("");
    await fs.appendFile(this.filePath, payload, { encoding: "utf8" });
    return Buffer.byteLength(payload, "utf8");
  }

  /**
   * Forward-scan reader. Returns every record currently on disk in
   * write order. Used by tests and the dashboard timeline; not on the
   * hot path. A missing file is treated as an empty stream.
   */
  async readAll(): Promise<readonly ExposureEventRecord[]> {
    let body: string;
    try {
      body = await fs.readFile(this.filePath, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }
    const out: ExposureEventRecord[] = [];
    for (const line of body.split("\n")) {
      if (line.length === 0) continue;
      out.push(JSON.parse(line) as ExposureEventRecord);
    }
    return out;
  }

  /**
   * Drop records older than `retentionDays`, then cap the survivors at
   * `maxRecords` (newest kept), rewriting the file atomically via a temp +
   * rename. A missing file is a no-op (idle sessions never materialise the
   * file). Best-effort: any IO error is swallowed so pruning never blocks
   * the proxy. Returns the number of records removed.
   */
  async prune(
    retentionDays: number = EXPOSURE_RETENTION_DAYS,
    maxRecords: number = EXPOSURE_MAX_RECORDS
  ): Promise<number> {
    let records: readonly ExposureEventRecord[];
    try {
      records = await this.readAll();
    } catch {
      return 0; // unreadable/corrupt — leave it for a human, don't crash
    }
    if (records.length === 0) return 0;

    const cutoff = Date.now() - retentionDays * 86_400_000;
    let kept = records.filter((r) => r.ts >= cutoff);
    if (kept.length > maxRecords) {
      kept = [...kept]
        .sort((a, b) => a.ts - b.ts)
        .slice(kept.length - maxRecords);
    }

    const removed = records.length - kept.length;
    if (removed === 0) return 0;

    try {
      const tmp = `${this.filePath}.tmp-${process.pid}`;
      await fs.writeFile(
        tmp,
        kept.map((r) => `${JSON.stringify(r)}\n`).join(""),
        {
          encoding: "utf8",
        }
      );
      await fs.rename(tmp, this.filePath);
    } catch {
      return 0; // rewrite failed — original file is intact
    }
    return removed;
  }
}
