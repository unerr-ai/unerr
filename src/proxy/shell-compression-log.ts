/**
 * Compression-specific event log — per-command rows written to
 * `.unerr/metrics.db` (`compression_events` and `file_read_events`).
 *
 * Previously this was JSONL (`logs/compression.jsonl`, `logs/file-reads.jsonl`);
 * migrated to SQLite for indexed lookups, monotonic poll-by-id semantics
 * (used by the log-tailer), and cheap aggregations in the dashboard.
 *
 * The wire types (CompressionLogEntry / FileReadLogEntry) are unchanged so
 * callers don't need to know about the storage backend.
 */

import { join } from "node:path";
import { openMetricsStore } from "../tracking/metrics-store.js";

export interface CompressionLogEntry {
  ts: string;
  command: string;
  category: string;
  confidence: number;
  rawBytes: number;
  compressedBytes: number;
  savedPct: number;
  omniFallback: boolean;
  teeFile?: string;
}

export interface FileReadLogEntry {
  ts: string;
  file: string;
  mode: "outline" | "entity" | "slice" | "full" | "log_tail" | "gated";
  totalLines: number;
  returnedLines: number;
  savedPct: number;
  entity?: string;
  tokenEstimate?: number;
}

function parseTs(ts: string): number {
  const n = Date.parse(ts);
  return Number.isNaN(n) ? Date.now() : n;
}

export function appendCompressionLog(
  cwd: string,
  entry: CompressionLogEntry
): void {
  try {
    const store = openMetricsStore(join(cwd, ".unerr"));
    store.insertCompression({
      ts: parseTs(entry.ts),
      ts_iso: entry.ts,
      command: entry.command,
      category: entry.category,
      confidence: entry.confidence,
      raw_bytes: entry.rawBytes,
      compressed_bytes: entry.compressedBytes,
      saved_pct: entry.savedPct,
      omni_fallback: entry.omniFallback ? 1 : 0,
      tee_file: entry.teeFile ?? null,
    });
  } catch {
    /* best effort */
  }
}

export function appendFileReadLog(cwd: string, entry: FileReadLogEntry): void {
  try {
    const store = openMetricsStore(join(cwd, ".unerr"));
    store.insertFileRead({
      ts: parseTs(entry.ts),
      ts_iso: entry.ts,
      file: entry.file,
      mode: entry.mode,
      total_lines: entry.totalLines,
      returned_lines: entry.returnedLines,
      saved_pct: entry.savedPct,
      entity: entry.entity ?? null,
      token_estimate: entry.tokenEstimate ?? null,
    });
  } catch {
    /* best effort */
  }
}

export function readRecentFileReadLogs(
  cwd: string,
  limit = 10
): FileReadLogEntry[] {
  try {
    const store = openMetricsStore(join(cwd, ".unerr"));
    return store.recentFileReads(limit).map((r) => ({
      ts: r.ts_iso,
      file: r.file,
      mode: r.mode as FileReadLogEntry["mode"],
      totalLines: r.total_lines,
      returnedLines: r.returned_lines,
      savedPct: r.saved_pct,
      entity: r.entity ?? undefined,
      tokenEstimate: r.token_estimate ?? undefined,
    }));
  } catch {
    return [];
  }
}

export function readRecentCompressionLogs(
  cwd: string,
  limit = 10
): CompressionLogEntry[] {
  try {
    const store = openMetricsStore(join(cwd, ".unerr"));
    return store.recentCompression(limit).map((r) => ({
      ts: r.ts_iso,
      command: r.command,
      category: r.category,
      confidence: r.confidence,
      rawBytes: r.raw_bytes,
      compressedBytes: r.compressed_bytes,
      savedPct: r.saved_pct,
      omniFallback: r.omni_fallback === 1,
      teeFile: r.tee_file ?? undefined,
    }));
  } catch {
    return [];
  }
}
