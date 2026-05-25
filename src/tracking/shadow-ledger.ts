/**
 * Shadow Ledger Writer — append-only JSONL intent journal.
 *
 * Every MCP tool call that passes through the proxy gets an intent entry appended
 * to `.unerr/ledger/shadow.jsonl`. The in-memory buffer keeps the last 100 entries
 * for correlation lookups (no full-file parse needed).
 *
 * Entry format: one JSON object per line (JSONL / newline-delimited JSON).
 * On startup, the file is validated — partial writes are truncated to the last
 * valid line.
 *
 * Performance: append is O(1) via fs.appendFileSync. Buffer is a fixed-size ring.
 * All logging to stderr.
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
import { redactArgs } from "./redactor.js";
import { type TurnConfidence, TurnSegmenter } from "./turn-segmenter.js";

export interface LedgerEntry {
  /** Unique intent ID (12-char hex) */
  id: string;
  /** ISO timestamp */
  ts: string;
  /** MCP tool name */
  tool: string;
  /** Truncated argument summary (prevent bloat) */
  args_summary: Record<string, unknown>;
  /** Result summary: found/count/source */
  result_summary: Record<string, unknown>;
  /** Git branch */
  branch: string;
  /** Git HEAD SHA */
  head_sha: string;
  /** Session ID (unique per proxy lifecycle) */
  session_id: string;
  /** Correlation ID — null for root intents, root.id for correlated */
  correlation_id: string | null;
  /** Commit SHA if associated (set later by commit watcher) */
  commit_sha?: string;
  /** Flush timestamp (set later by ledger flusher) */
  flushed_at?: string;
  /** Sprint 10.4: Plan summary from agent context */
  plan_summary?: string;
  /** Sprint 10.4: Change type classification */
  change_type?: string;
  /** Sprint 10.4: Feature area tag */
  feature_area?: string;
  /** ST-1: Turn id assigned by TurnSegmenter (one turn per user→agent round-trip). */
  turn_id?: string;
  /** ST-1: How the turn boundary was determined. */
  turn_confidence?: TurnConfidence;
}

const MAX_BUFFER_SIZE = 100;
const CORRELATION_WINDOW_MS = 30_000; // 30 seconds
const MAX_ARG_VALUE_LENGTH = 200;

export interface ShadowLedgerOptions {
  /** Inject a custom TurnSegmenter (for tests or shared instances). */
  turnSegmenter?: TurnSegmenter;
  /** Resume under an existing session id (warm-restart continuity). When
   *  omitted, a fresh 12-hex id is minted. Passed by the proxy boot path when
   *  the previous session ended within SESSION_RESUME_ID_WINDOW_MS so a
   *  mid-conversation restart keeps one logical session id. */
  sessionId?: string;
}

export class ShadowLedger {
  private ledgerDir: string;
  private filePath: string;
  private sessionId: string;
  private buffer: LedgerEntry[] = [];
  private lastEntryTime = 0;
  private currentRootId: string | null = null;
  private turnSegmenter: TurnSegmenter;

  constructor(unerrDir: string, options: ShadowLedgerOptions = {}) {
    this.ledgerDir = join(unerrDir, "ledger");
    this.filePath = join(this.ledgerDir, "shadow.jsonl");
    this.sessionId = options.sessionId ?? generateId();
    this.turnSegmenter = options.turnSegmenter ?? new TurnSegmenter();

    // Ensure directory exists
    if (!existsSync(this.ledgerDir)) {
      mkdirSync(this.ledgerDir, { recursive: true });
    }

    // Recover from corruption on startup
    this.recoverFile();

    // Load recent entries into buffer
    this.loadRecentEntries();
  }

  /**
   * Subscribers (e.g., the timeline subsystem) get the same segmenter so they
   * can observe turn-close events to roll up turns into timeline.db.
   */
  getTurnSegmenter(): TurnSegmenter {
    return this.turnSegmenter;
  }

  /**
   * Close the current turn for this ledger's session. Called by Stop hooks
   * (Claude Code) or on shutdown. The next recorded entry will open a fresh
   * turn with confidence "first_call".
   */
  closeTurn(reason: "stop_hook" | "session_end" = "stop_hook"): void {
    this.turnSegmenter.closeTurn(this.sessionId, reason);
  }

  /**
   * Record a tool call as a ledger entry.
   */
  record(
    tool: string,
    args: Record<string, unknown>,
    resultSummary: Record<string, unknown>,
    branch: string,
    headSha: string,
    promptContext?: {
      planSummary?: string;
      changeType?: string;
      featureArea?: string;
    }
  ): LedgerEntry {
    const now = Date.now();
    const correlationId = this.computeCorrelation(tool, now);

    const entry: LedgerEntry = {
      id: generateId(),
      ts: new Date(now).toISOString(),
      tool,
      // ST-6: redact known secret patterns BEFORE truncating so the regex
      // catches whole values; then truncate any remaining long strings.
      args_summary: truncateArgs(redactArgs(args)),
      result_summary: resultSummary,
      branch,
      head_sha: headSha,
      session_id: this.sessionId,
      correlation_id: correlationId,
      ...(promptContext?.planSummary
        ? { plan_summary: promptContext.planSummary }
        : {}),
      ...(promptContext?.changeType
        ? { change_type: promptContext.changeType }
        : {}),
      ...(promptContext?.featureArea
        ? { feature_area: promptContext.featureArea }
        : {}),
    };

    // ST-1: stamp turn_id / turn_confidence in place before persist.
    this.turnSegmenter.observe(entry);

    // Append to file
    this.appendEntry(entry);

    // Update in-memory buffer
    this.buffer.push(entry);
    if (this.buffer.length > MAX_BUFFER_SIZE) {
      this.buffer.shift();
    }

    this.lastEntryTime = now;

    return entry;
  }

  /**
   * Get the last N entries from the in-memory buffer.
   */
  getRecentEntries(limit = 20): LedgerEntry[] {
    return this.buffer.slice(-limit);
  }

  /**
   * Get the current root intent ID for correlation.
   */
  getCurrentRootId(): string | null {
    return this.currentRootId;
  }

  /**
   * Get the session ID.
   */
  getSessionId(): string {
    return this.sessionId;
  }

  /**
   * Get the timestamp (ms) of the last sync_local_diff call.
   * Used by AI attribution heuristic to determine change origin.
   * Returns 0 if no sync has been recorded this session.
   */
  getLastSyncTimestamp(): number {
    for (let i = this.buffer.length - 1; i >= 0; i--) {
      const entry = this.buffer[i];
      if (entry?.tool === "sync_local_diff") {
        return new Date(entry.ts).getTime();
      }
    }
    return 0;
  }

  /**
   * Get ledger stats for `unerr status`.
   */
  getStats(): {
    totalEntries: number;
    bufferSize: number;
    sessionId: string;
    lastEntryAt: string | null;
  } {
    const lastEntry =
      this.buffer.length > 0 ? this.buffer[this.buffer.length - 1] : null;
    return {
      totalEntries: this.countEntries(),
      bufferSize: this.buffer.length,
      sessionId: this.sessionId,
      lastEntryAt: lastEntry?.ts ?? null,
    };
  }

  /**
   * Get count of entries in the current session.
   */
  getSessionEntryCount(): number {
    return this.buffer.filter((e) => e.session_id === this.sessionId).length;
  }

  /**
   * Get count of pending correlations (entries with correlation_id that are roots).
   */
  getPendingRootCount(): number {
    const roots = new Set<string>();
    for (const entry of this.buffer) {
      if (entry.correlation_id === null) {
        roots.add(entry.id);
      }
    }
    return roots.size;
  }

  /**
   * Flush the in-memory buffer to disk (for graceful shutdown).
   * Since we appendFileSync on each record, this is mostly a no-op
   * but ensures any pending state is consistent.
   */
  flush(): void {
    // Buffer is already synced via appendFileSync — nothing to do
    // This method exists for the shutdown contract
  }

  /**
   * Get all entries (read from file). Used sparingly — prefer buffer.
   */
  readAllEntries(): LedgerEntry[] {
    if (!existsSync(this.filePath)) return [];
    try {
      const content = readFileSync(this.filePath, "utf-8");
      const lines = content.split("\n").filter((l) => l.trim().length > 0);
      return lines.map((line) => JSON.parse(line) as LedgerEntry);
    } catch {
      return [];
    }
  }

  // ── Internal ───────────────────────────────────────────────────

  private computeCorrelation(tool: string, now: number): string | null {
    const gap = now - this.lastEntryTime;

    // sync_local_diff always correlates to active root
    if (tool === "sync_local_diff" && this.currentRootId) {
      return this.currentRootId;
    }

    // If gap > 30s or no previous entry → new root intent
    if (gap > CORRELATION_WINDOW_MS || this.lastEntryTime === 0) {
      this.currentRootId = null; // will be set to this entry's ID after creation
      // Return null — this IS the root
      return null;
    }

    // Within window → correlate to current root
    return this.currentRootId;
  }

  private appendEntry(entry: LedgerEntry): void {
    // If this is a root entry (correlation_id is null), update currentRootId
    if (entry.correlation_id === null) {
      this.currentRootId = entry.id;
    }

    try {
      appendFileSync(this.filePath, `${JSON.stringify(entry)}\n`, "utf-8");
    } catch (err: unknown) {
      process.stderr.write(
        `[unerr:ledger] WARN: Failed to append entry: ${err instanceof Error ? err.message : String(err)}\n`
      );
    }
  }

  /**
   * Recover from file corruption: truncate to last valid JSONL line.
   */
  private recoverFile(): void {
    if (!existsSync(this.filePath)) return;

    try {
      const content = readFileSync(this.filePath, "utf-8");
      const lines = content.split("\n");
      const validLines: string[] = [];

      for (const line of lines) {
        if (line.trim().length === 0) continue;
        try {
          JSON.parse(line);
          validLines.push(line);
        } catch {
          // Invalid line — stop here (truncate from this point)
          process.stderr.write(
            `[unerr:ledger] Recovered: truncated ${lines.length - validLines.length} corrupt line(s)\n`
          );
          break;
        }
      }

      // Rewrite file with only valid lines
      if (validLines.length < lines.filter((l) => l.trim().length > 0).length) {
        writeFileSync(
          this.filePath,
          validLines.join("\n") + (validLines.length > 0 ? "\n" : ""),
          "utf-8"
        );
      }
    } catch {
      // File unreadable — start fresh
      writeFileSync(this.filePath, "", "utf-8");
    }
  }

  /**
   * Load the most recent entries from the file into the buffer.
   */
  private loadRecentEntries(): void {
    if (!existsSync(this.filePath)) return;

    try {
      const content = readFileSync(this.filePath, "utf-8");
      const lines = content.split("\n").filter((l) => l.trim().length > 0);

      // Load last MAX_BUFFER_SIZE entries
      const start = Math.max(0, lines.length - MAX_BUFFER_SIZE);
      for (let i = start; i < lines.length; i++) {
        try {
          const line = lines[i];
          if (!line) continue;
          const entry = JSON.parse(line) as LedgerEntry;
          this.buffer.push(entry);
        } catch {
          // Skip invalid lines
        }
      }

      // Restore correlation state from last root entry
      for (let i = this.buffer.length - 1; i >= 0; i--) {
        const entry = this.buffer[i];
        if (!entry) continue;
        if (entry.correlation_id === null) {
          this.currentRootId = entry.id;
          this.lastEntryTime = new Date(entry.ts).getTime();
          break;
        }
      }
    } catch {
      // Start with empty buffer
    }
  }

  /**
   * Count total entries in the file.
   */
  private countEntries(): number {
    if (!existsSync(this.filePath)) return 0;
    try {
      const content = readFileSync(this.filePath, "utf-8");
      return content.split("\n").filter((l) => l.trim().length > 0).length;
    } catch {
      return 0;
    }
  }
}

/**
 * Generate a 12-char hex ID (6 random bytes).
 */
function generateId(): string {
  return randomBytes(6).toString("hex");
}

/**
 * Truncate argument values to prevent JSONL bloat.
 */
function truncateArgs(args: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    if (typeof value === "string" && value.length > MAX_ARG_VALUE_LENGTH) {
      result[key] = `${value.slice(0, MAX_ARG_VALUE_LENGTH)}...`;
    } else {
      result[key] = value;
    }
  }
  return result;
}
