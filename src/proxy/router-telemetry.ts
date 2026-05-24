/**
 * Router telemetry recorder — append-only JSONL writer for per-call
 * metrics at `.unerr/router/metrics.jsonl`.
 *
 * Every tool call that flows through the gateway records:
 *   - which tool, outcome, was-masked status
 *   - token savings (full_description - delivered_description)
 *   - latency breakdown (classify, forward, total)
 *   - unlocks triggered by this call
 *
 * Design:
 *   - Append-only JSONL, one record per tool call
 *   - Single `appendFile` per record (O_APPEND — atomic on POSIX for <4KB)
 *   - Lazy directory creation on first write
 *   - Daily rotation with 7-day retention + gzip
 *   - Never blocks the tool-call hot path — write errors are logged, not thrown
 *
 * The recorder is a leaf module: no imports from intelligence/, behaviors/,
 * or tracking/. The proxy wires it alongside RouterGateway.
 */

import { promises as fs } from "node:fs";
import {
  createReadStream,
  createWriteStream,
  existsSync,
  readdirSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { pipeline } from "node:stream/promises";
import { createGzip } from "node:zlib";

import { countTokens } from "./tool-budget.js";

// ── Record shape ─────────────────────────────────────────────────

export type TelemetryOutcome =
  | "executed"
  | "soft_refused"
  | "passthrough_degraded"
  | "child_error";

export interface RouterTelemetryRecord {
  readonly v: 1;
  readonly ts: string;
  readonly sessionId: string;
  readonly toolName: string;
  readonly originalToolName: string;
  readonly server: string;
  readonly outcome: TelemetryOutcome;
  readonly wasMasked: boolean;
  readonly wasMaskedReason?: string;
  readonly tokensIn: number;
  readonly tokensSaved: number;
  readonly latencyMs: {
    readonly classify?: number;
    readonly forward?: number;
    readonly total: number;
  };
  readonly unlocks?: readonly string[];
}

// ── Token savings calculator ─────────────────────────────────────

export interface TokenSavingsInput {
  readonly fullDescription: string;
  readonly deliveredDescription: string;
}

export function calculateTokenSavings(input: TokenSavingsInput): {
  tokensIn: number;
  tokensSaved: number;
} {
  const full = countTokens(input.fullDescription);
  const delivered = countTokens(input.deliveredDescription);
  return {
    tokensIn: delivered,
    tokensSaved: Math.max(0, full - delivered),
  };
}

// ── Latency tracker (per-call) ───────────────────────────────────

export class CallLatencyTracker {
  private readonly startMs: number;
  private classifyEndMs: number | null = null;
  private forwardEndMs: number | null = null;

  constructor() {
    this.startMs = performance.now();
  }

  markClassifyDone(): void {
    this.classifyEndMs = performance.now();
  }

  markForwardDone(): void {
    this.forwardEndMs = performance.now();
  }

  finish(): RouterTelemetryRecord["latencyMs"] {
    const now = performance.now();
    return {
      classify:
        this.classifyEndMs !== null
          ? Math.round(this.classifyEndMs - this.startMs)
          : undefined,
      forward:
        this.forwardEndMs !== null
          ? Math.round(this.forwardEndMs - (this.classifyEndMs ?? this.startMs))
          : undefined,
      total: Math.round(now - this.startMs),
    };
  }
}

// ── Recorder ─────────────────────────────────────────────────────

const METRICS_FILE = "metrics.jsonl";
const RETENTION_DAYS = 7;

export class RouterTelemetryRecorder {
  private readonly dir: string;
  private readonly filePath: string;
  private readonly sessionId: string;
  private ensuredDir = false;
  private recordCount = 0;
  private totalTokensSaved = 0;
  private totalTokensIn = 0;
  private softRefuseCount = 0;
  private unlockCount = 0;

  constructor(unerrDir: string, sessionId: string) {
    this.dir = join(unerrDir, "router");
    this.filePath = join(this.dir, METRICS_FILE);
    this.sessionId = sessionId;
  }

  /**
   * Append one telemetry record. Non-blocking — write errors are
   * swallowed and passed to the optional error callback. The caller
   * must never await this in the tool-response critical path.
   */
  async append(
    record: Omit<RouterTelemetryRecord, "v" | "ts" | "sessionId">,
    onError?: (err: unknown) => void
  ): Promise<void> {
    const full: RouterTelemetryRecord = {
      v: 1,
      ts: new Date().toISOString(),
      sessionId: this.sessionId,
      ...record,
    };

    this.recordCount++;
    this.totalTokensSaved += record.tokensSaved;
    this.totalTokensIn += record.tokensIn;
    if (record.outcome === "soft_refused") this.softRefuseCount++;
    if (record.unlocks) this.unlockCount += record.unlocks.length;

    try {
      if (!this.ensuredDir) {
        await fs.mkdir(this.dir, { recursive: true });
        this.ensuredDir = true;
      }
      await fs.appendFile(this.filePath, `${JSON.stringify(full)}\n`, {
        encoding: "utf8",
      });
    } catch (err) {
      onError?.(err);
    }
  }

  /**
   * In-memory session counters — no disk I/O, O(1).
   */
  getSessionSummary(): RouterSessionSummary {
    return {
      sessionId: this.sessionId,
      totalCalls: this.recordCount,
      totalTokensSaved: this.totalTokensSaved,
      totalTokensIn: this.totalTokensIn,
      softRefuseCount: this.softRefuseCount,
      unlockCount: this.unlockCount,
      efficiency:
        this.totalTokensIn > 0
          ? Math.round(
              (this.totalTokensSaved /
                (this.totalTokensIn + this.totalTokensSaved)) *
                100
            )
          : 0,
    };
  }

  /**
   * Forward-scan reader — returns all records on disk. Used by tests
   * and the dashboard; not on the hot path.
   */
  async readAll(): Promise<readonly RouterTelemetryRecord[]> {
    let body: string;
    try {
      body = await fs.readFile(this.filePath, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }
    const out: RouterTelemetryRecord[] = [];
    for (const line of body.split("\n")) {
      if (line.length === 0) continue;
      try {
        out.push(JSON.parse(line) as RouterTelemetryRecord);
      } catch {
        // Skip malformed lines (partial writes from crash)
      }
    }
    return out;
  }

  /**
   * Daily JSONL rotation with 7-day retention.
   *
   * Call once per session start (or on a timer). Rotates the current
   * metrics.jsonl to metrics-YYYY-MM-DD.jsonl.gz if it's from a
   * previous day. Purges files older than RETENTION_DAYS.
   *
   * Non-blocking, non-throwing — rotation failures are logged, not fatal.
   */
  async rotate(onError?: (err: unknown) => void): Promise<void> {
    try {
      if (!existsSync(this.filePath)) return;

      const stat = statSync(this.filePath);
      const fileDate = stat.mtime;
      const today = new Date();

      if (
        fileDate.getUTCFullYear() === today.getUTCFullYear() &&
        fileDate.getUTCMonth() === today.getUTCMonth() &&
        fileDate.getUTCDate() === today.getUTCDate()
      ) {
        return;
      }

      const dateStr = `${fileDate.getUTCFullYear()}-${String(fileDate.getUTCMonth() + 1).padStart(2, "0")}-${String(fileDate.getUTCDate()).padStart(2, "0")}`;
      const archivePath = join(this.dir, `metrics-${dateStr}.jsonl.gz`);

      if (!existsSync(archivePath)) {
        await pipeline(
          createReadStream(this.filePath),
          createGzip(),
          createWriteStream(archivePath)
        );
      }

      await fs.unlink(this.filePath);

      await this.purgeOldArchives();
    } catch (err) {
      onError?.(err);
    }
  }

  private async purgeOldArchives(): Promise<void> {
    const cutoff = Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000;

    let entries: string[];
    try {
      entries = readdirSync(this.dir);
    } catch {
      return;
    }

    for (const entry of entries) {
      if (!entry.startsWith("metrics-") || !entry.endsWith(".jsonl.gz"))
        continue;
      const match = entry.match(/^metrics-(\d{4}-\d{2}-\d{2})\.jsonl\.gz$/);
      if (!match) continue;
      const fileDate = new Date(match[1]!);
      if (fileDate.getTime() < cutoff) {
        try {
          unlinkSync(join(this.dir, entry));
        } catch {
          // Best effort
        }
      }
    }
  }
}

// ── Session summary type ─────────────────────────────────────────

export interface RouterSessionSummary {
  readonly sessionId: string;
  readonly totalCalls: number;
  readonly totalTokensSaved: number;
  readonly totalTokensIn: number;
  readonly softRefuseCount: number;
  readonly unlockCount: number;
  readonly efficiency: number;
}
