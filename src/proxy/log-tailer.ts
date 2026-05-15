/**
 * Log Tailer — relays new metric/log events from child processes to the
 * proxy console via startupLog.
 *
 * Three streams (compression, token_flow, file_read) live in `.unerr/metrics.db`
 * and are polled by `id > lastSeen` every `pollIntervalMs` (default 500ms).
 * One stream (`logs/unerr.jsonl`) stays JSONL and is tailed via `fs.watch`.
 *
 * Why this shape: SQLite gives ordered-by-id polling for free, so we no
 * longer have to track byte offsets or worry about partial writes. The
 * remaining JSONL file is structured log output that doesn't need indexed
 * aggregation, so leaving it as a flat file keeps `tail -f .../unerr.jsonl`
 * useful for debugging.
 */

import {
  closeSync,
  existsSync,
  openSync,
  readSync,
  statSync,
  watch,
} from "node:fs";
import { join } from "node:path";
import {
  type CompressionEventRow,
  type FileReadEventRow,
  type TokenFlowEventRow,
  openMetricsStore,
} from "../tracking/metrics-store.js";
import { startupLog } from "../utils/startup-log.js";

interface TailState {
  path: string;
  offset: number;
  watcher: ReturnType<typeof watch> | null;
}

function formatSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${bytes}B`;
}

/** Read new lines from a file starting at the given byte offset. */
function readNewLines(
  filePath: string,
  fromOffset: number
): { lines: string[]; newOffset: number } {
  try {
    const stat = statSync(filePath);
    if (stat.size <= fromOffset) return { lines: [], newOffset: fromOffset };

    const bytesToRead = stat.size - fromOffset;
    const buf = Buffer.alloc(bytesToRead);
    const fd = openSync(filePath, "r");
    try {
      readSync(fd, buf, 0, bytesToRead, fromOffset);
    } finally {
      closeSync(fd);
    }

    const text = buf.toString("utf-8");
    const rawLines = text.split("\n").filter((l) => l.trim());
    return { lines: rawLines, newOffset: stat.size };
  } catch {
    return { lines: [], newOffset: fromOffset };
  }
}

/** Format and print a compression log entry. */
function printCompressionEntry(entry: Record<string, unknown>): void {
  const cmd = String(entry.command ?? "");
  const cmdSlug = cmd.length > 40 ? `${cmd.slice(0, 37)}...` : cmd;
  const category = String(entry.category ?? "unknown");
  const savedPct = Number(entry.savedPct ?? 0);
  const rawBytes = Number(entry.rawBytes ?? 0);
  const compressedBytes = Number(entry.compressedBytes ?? 0);
  const omniFallback = Boolean(entry.omniFallback);
  const strategy = omniFallback ? `omni(${category})` : category;

  if (savedPct === 0) return; // skip no-op compressions on console

  startupLog.step(
    `${startupLog.fmt.muted("[exec]")} ${startupLog.fmt.dim(`"${cmdSlug}"`)} ${startupLog.fmt.muted("→")} ${startupLog.fmt.cyan(strategy)} ${startupLog.fmt.muted(`(${formatSize(rawBytes)} → ${formatSize(compressedBytes)}, ${savedPct}% saved)`)}`
  );
}

/** Format and print a token-flow.jsonl entry from child processes. */
function printTokenFlowEntry(entry: Record<string, unknown>): void {
  const pid = Number(entry.pid ?? 0);
  if (pid === process.pid) return;

  const tokensSaved = Number(entry.tokens_saved ?? 0);
  if (tokensSaved <= 0) return;

  startupLog.tokenFlow({
    turn: Number(entry.turn ?? 0),
    tool: entry.tool != null ? String(entry.tool) : null,
    mechanism: String(entry.mechanism ?? "unknown"),
    tokensSaved,
    tokensDelivered: Number(entry.tokens_with ?? 0),
    sessionTotal: 0,
    pid,
  });
}

/** Format and print a file-reads.jsonl entry from child processes. */
function printFileReadEntry(entry: Record<string, unknown>): void {
  const savedPct = Number(entry.savedPct ?? 0);
  if (savedPct === 0) return; // skip full reads with no savings

  const file = String(entry.file ?? "");
  const fileSlug = file.length > 40 ? `...${file.slice(-37)}` : file;
  const mode = String(entry.mode ?? "full");
  const totalLines = Number(entry.totalLines ?? 0);
  const returnedLines = Number(entry.returnedLines ?? 0);

  startupLog.step(
    `${startupLog.fmt.muted("[mcp]")} ${startupLog.fmt.dim(fileSlug)} ${startupLog.fmt.muted("→")} ${startupLog.fmt.cyan(mode)} ${startupLog.fmt.muted(`(${totalLines} → ${returnedLines} lines, ${savedPct}% saved)`)}`
  );
}

/** Format and print a general unerr.jsonl entry from child processes. */
function printGeneralEntry(entry: Record<string, unknown>): void {
  const pid = Number(entry.pid ?? 0);
  // Only relay entries from OTHER processes (not our own PID)
  if (pid === process.pid) return;

  const level = String(entry.level ?? "");
  const msg = String(entry.msg ?? "");

  // Skip noisy low-value entries
  if (!msg || level === "step" || level === "ready") return;

  const prefix = startupLog.fmt.muted(`[pid:${pid}]`);

  switch (level) {
    case "error":
      startupLog.error(`${prefix} ${msg}`);
      break;
    case "warn":
      startupLog.warn(`${prefix} ${msg}`);
      break;
    case "done":
      startupLog.done(
        `${prefix} ${msg}`,
        typeof entry.ms === "number" ? entry.ms : undefined
      );
      break;
    case "metric":
      startupLog.step(
        `${prefix} ${startupLog.fmt.cyan(msg)}: ${startupLog.fmt.bold(String(entry.value))} ${startupLog.fmt.muted(String(entry.unit ?? ""))}`
      );
      break;
    default:
      startupLog.step(`${prefix} ${msg}`);
  }
}

function tailFile(
  state: TailState,
  handler: (entry: Record<string, unknown>) => void
): void {
  const { lines, newOffset } = readNewLines(state.path, state.offset);
  state.offset = newOffset;

  for (const line of lines) {
    try {
      const entry = JSON.parse(line) as Record<string, unknown>;
      handler(entry);
    } catch {
      // malformed line — skip
    }
  }
}

export interface LogTailerHandle {
  close(): void;
}

export interface LogTailerOptions {
  /** Callback for token-flow events — used to ingest into proxy's TokenFlowWriter for SSE */
  onTokenFlowEvent?: (entry: Record<string, unknown>) => void;
  /** Override the SQLite poll cadence (default 500 ms). Tests use shorter intervals. */
  pollIntervalMs?: number;
}

// ── Row → wire-shape adapters ────────────────────────────────────────
// The console printers expect the old JSONL field names (camelCase).
// These keep the printers untouched while the storage backend swaps.

function compressionRowToEntry(
  r: CompressionEventRow
): Record<string, unknown> {
  return {
    ts: r.ts_iso,
    command: r.command,
    category: r.category,
    confidence: r.confidence,
    rawBytes: r.raw_bytes,
    compressedBytes: r.compressed_bytes,
    savedPct: r.saved_pct,
    omniFallback: r.omni_fallback === 1,
    teeFile: r.tee_file,
  };
}

function fileReadRowToEntry(r: FileReadEventRow): Record<string, unknown> {
  return {
    ts: r.ts_iso,
    file: r.file,
    mode: r.mode,
    totalLines: r.total_lines,
    returnedLines: r.returned_lines,
    savedPct: r.saved_pct,
    entity: r.entity,
    tokenEstimate: r.token_estimate,
  };
}

function tokenFlowRowToEntry(r: TokenFlowEventRow): Record<string, unknown> {
  return {
    id: r.id,
    ts: r.ts_iso,
    session_id: r.session_id,
    pid: r.pid,
    turn: r.turn,
    mechanism: r.mechanism,
    tool: r.tool,
    tokens_without: r.tokens_without,
    tokens_with: r.tokens_with,
    tokens_saved: r.tokens_saved,
    detail: r.detail ? JSON.parse(r.detail) : undefined,
  };
}

/**
 * Start tailing the proxy's child-process activity.
 *
 *   - compression / token_flow / file_read: polled from `.unerr/metrics.db`
 *     via `id > lastSeen` (no offsets, no partial-read races).
 *   - unerr.jsonl: still `fs.watch`-tailed — it's a flat structured log,
 *     not a metric stream.
 */
export function startLogTailer(
  cwd: string,
  options?: LogTailerOptions
): LogTailerHandle {
  const unerrDir = join(cwd, ".unerr");
  const logsDir = join(unerrDir, "logs");
  const generalPath = join(logsDir, "unerr.jsonl");
  const pollIntervalMs = options?.pollIntervalMs ?? 500;

  // ── JSONL path: unerr.jsonl via fs.watch + offset ────────────────
  const generalState: TailState = {
    path: generalPath,
    offset: existsSync(generalPath) ? statSync(generalPath).size : 0,
    watcher: null,
  };

  function setupWatcher(
    state: TailState,
    handler: (entry: Record<string, unknown>) => void
  ): void {
    try {
      state.watcher = watch(state.path, () => {
        tailFile(state, handler);
      });
      state.watcher.unref();
    } catch {
      /* file may not exist yet — handled by the JSONL poll fallback below */
    }
  }

  setupWatcher(generalState, printGeneralEntry);

  // ── SQLite path: compression / token_flow / file_read ────────────
  // Initialize lastSeen to the current max id so we only relay *new* events.
  const store = openMetricsStore(unerrDir);
  const initial = store.lastIds();
  let lastCompressionId = initial.compression;
  let lastFileReadId = initial.fileRead;
  let lastTokenFlowId = initial.tokenFlow;

  const sqlPoll = setInterval(() => {
    try {
      const cRows = store.compressionSince(lastCompressionId);
      for (const r of cRows) {
        printCompressionEntry(compressionRowToEntry(r));
        lastCompressionId = r.id;
      }
      const fRows = store.fileReadsSince(lastFileReadId);
      for (const r of fRows) {
        printFileReadEntry(fileReadRowToEntry(r));
        lastFileReadId = r.id;
      }
      const tRows = store.tokenFlowSince(lastTokenFlowId);
      for (const r of tRows) {
        const entry = tokenFlowRowToEntry(r);
        printTokenFlowEntry(entry);
        options?.onTokenFlowEvent?.(entry);
        lastTokenFlowId = r.id;
      }
    } catch {
      /* poll round failed — try again next tick */
    }
  }, pollIntervalMs);
  sqlPoll.unref();

  // ── JSONL poll fallback (unerr.jsonl appears after startup) ──────
  const jsonlPoll = setInterval(() => {
    if (!generalState.watcher && existsSync(generalState.path)) {
      try {
        generalState.offset = 0;
        generalState.watcher = watch(generalState.path, () => {
          tailFile(generalState, printGeneralEntry);
        });
        generalState.watcher.unref();
      } catch {
        /* retry next poll */
      }
    }
    tailFile(generalState, printGeneralEntry);
  }, 3000);
  jsonlPoll.unref();

  return {
    close() {
      clearInterval(sqlPoll);
      clearInterval(jsonlPoll);
      generalState.watcher?.close();
    },
  };
}
