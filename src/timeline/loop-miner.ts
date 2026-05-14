/**
 * Loop Miner (ST-3a).
 *
 * Pure functions over shadow-ledger entries. Surfaces two confusion shapes:
 *   1. File-read loops — same file read ≥5 times within a 10-minute window
 *      with no edit in between. Signal that the agent is rereading instead of
 *      progressing.
 *   2. Query-search loops — same `search_code` query issued ≥3 times within
 *      a 20-minute window. Signal of a gap in the agent's mental model (the
 *      function was renamed, the symbol doesn't exist, etc.).
 *
 * Read-only: never writes anything. Callers (the dashboard route, the future
 * insights panel) pass in entries from `ShadowLedger.getRecentEntries()`.
 */

import type { LedgerEntry } from "../tracking/shadow-ledger.js";

export interface LoopReadDetection {
  kind: "file_reread";
  file_path: string;
  count: number;
  first_ts: string;
  last_ts: string;
  session_id: string;
}

export interface LoopQueryDetection {
  kind: "search_repeat";
  query: string;
  count: number;
  first_ts: string;
  last_ts: string;
  session_id: string;
}

export type LoopDetection = LoopReadDetection | LoopQueryDetection;

const READ_TOOLS = new Set([
  "file_read",
  "file_outline",
  "get_file",
  "Read",
]);

const EDIT_TOOLS = new Set([
  "Edit",
  "Write",
  "MultiEdit",
  "NotebookEdit",
  "edit_file",
  "write_file",
]);

const DEFAULT_READ_WINDOW_MS = 10 * 60_000;
const DEFAULT_QUERY_WINDOW_MS = 20 * 60_000;
const DEFAULT_READ_THRESHOLD = 5;
const DEFAULT_QUERY_THRESHOLD = 3;

export interface DetectLoopsOptions {
  /** Sliding window for file-read detection (ms). Default 10 min. */
  readWindowMs?: number;
  /** Min reads (no edit between) to trigger a file-read loop. Default 5. */
  readThreshold?: number;
  /** Sliding window for search-query detection (ms). Default 20 min. */
  queryWindowMs?: number;
  /** Min repeats of the same query to trigger. Default 3. */
  queryThreshold?: number;
  /** Reference "now" timestamp (ms). Default: max ts in entries, else Date.now. */
  nowMs?: number;
}

function entryFilePath(entry: LedgerEntry): string | null {
  const fp =
    (entry.args_summary?.file_path as string | undefined) ??
    (entry.args_summary?.path as string | undefined);
  return typeof fp === "string" && fp.length > 0 ? fp : null;
}

function entryTsMs(entry: LedgerEntry): number {
  return Date.parse(entry.ts);
}

export function detectFileReadLoops(
  entries: LedgerEntry[],
  opts: DetectLoopsOptions = {},
): LoopReadDetection[] {
  const window = opts.readWindowMs ?? DEFAULT_READ_WINDOW_MS;
  const threshold = opts.readThreshold ?? DEFAULT_READ_THRESHOLD;
  const now = opts.nowMs ?? maxTs(entries) ?? Date.now();
  const cutoff = now - window;

  const grouped = new Map<
    string,
    { reads: LedgerEntry[]; lastEditTs: number; session_id: string }
  >();

  for (const e of entries) {
    const ts = entryTsMs(e);
    if (!Number.isFinite(ts) || ts < cutoff) continue;
    const fp = entryFilePath(e);
    if (!fp) continue;

    const key = `${e.session_id}::${fp}`;
    let bucket = grouped.get(key);
    if (!bucket) {
      bucket = { reads: [], lastEditTs: 0, session_id: e.session_id };
      grouped.set(key, bucket);
    }

    if (EDIT_TOOLS.has(e.tool)) {
      // Edit clears the read run — only reads AFTER the last edit count.
      bucket.reads = [];
      bucket.lastEditTs = ts;
      continue;
    }
    if (READ_TOOLS.has(e.tool)) {
      bucket.reads.push(e);
    }
  }

  const out: LoopReadDetection[] = [];
  for (const [key, bucket] of grouped) {
    if (bucket.reads.length < threshold) continue;
    const fp = key.split("::").slice(1).join("::");
    const first = bucket.reads[0]!;
    const last = bucket.reads[bucket.reads.length - 1]!;
    out.push({
      kind: "file_reread",
      file_path: fp,
      count: bucket.reads.length,
      first_ts: first.ts,
      last_ts: last.ts,
      session_id: bucket.session_id,
    });
  }
  return out.sort((a, b) => b.count - a.count);
}

export function detectQueryLoops(
  entries: LedgerEntry[],
  opts: DetectLoopsOptions = {},
): LoopQueryDetection[] {
  const window = opts.queryWindowMs ?? DEFAULT_QUERY_WINDOW_MS;
  const threshold = opts.queryThreshold ?? DEFAULT_QUERY_THRESHOLD;
  const now = opts.nowMs ?? maxTs(entries) ?? Date.now();
  const cutoff = now - window;

  const grouped = new Map<string, LedgerEntry[]>();

  for (const e of entries) {
    if (e.tool !== "search_code") continue;
    const ts = entryTsMs(e);
    if (!Number.isFinite(ts) || ts < cutoff) continue;
    const q = e.args_summary?.query;
    if (typeof q !== "string" || q.length === 0) continue;
    const key = `${e.session_id}::${q}`;
    const bucket = grouped.get(key) ?? [];
    bucket.push(e);
    grouped.set(key, bucket);
  }

  const out: LoopQueryDetection[] = [];
  for (const [key, bucket] of grouped) {
    if (bucket.length < threshold) continue;
    const query = key.split("::").slice(1).join("::");
    const first = bucket[0]!;
    const last = bucket[bucket.length - 1]!;
    out.push({
      kind: "search_repeat",
      query,
      count: bucket.length,
      first_ts: first.ts,
      last_ts: last.ts,
      session_id: first.session_id,
    });
  }
  return out.sort((a, b) => b.count - a.count);
}

/**
 * Convenience aggregator — runs both detectors and returns the union sorted by
 * recency.
 */
export function detectLoops(
  entries: LedgerEntry[],
  opts: DetectLoopsOptions = {},
): LoopDetection[] {
  const all = [
    ...detectFileReadLoops(entries, opts),
    ...detectQueryLoops(entries, opts),
  ];
  return all.sort((a, b) => Date.parse(b.last_ts) - Date.parse(a.last_ts));
}

function maxTs(entries: LedgerEntry[]): number | null {
  let max = -Infinity;
  for (const e of entries) {
    const t = entryTsMs(e);
    if (Number.isFinite(t) && t > max) max = t;
  }
  return Number.isFinite(max) ? max : null;
}
