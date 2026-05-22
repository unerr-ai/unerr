/**
 * Rotating stderr → file mirror.
 *
 * Tees every `process.stderr.write` call to a `.log` file on disk so the
 * three processes (`unerrd`, `unerr`, `unerr --mcp`) still produce
 * inspectable output when they leave the foreground.
 *
 * Filenames are stable (no PID, no timestamp) — multiple processes share
 * one file via O_APPEND. POSIX `appendFileSync` is atomic for chunks
 * smaller than `PIPE_BUF`, which covers every line we write.
 *
 * Each written line is prefixed with `[ISO_TIMESTAMP pid=N sid=xxxxxx]` so
 * the consumer can disambiguate when (and by which process) each line was
 * written inside a shared file. The `sid` is the spawn-lineage correlation
 * ID from `log-paths.ts`. The timestamp is `new Date().toISOString()` —
 * UTC, millisecond-precision (e.g. `2026-05-19T20:11:23.456Z`).
 *
 * Rotation: one gzipped archive per logfile per **local** day. The live
 * file is renamed → gzipped to `*.log.YYYY-MM-DD.gz` on the first write
 * (or periodic check) that observes a previous-day mtime, then truncated
 * so today starts fresh. Archives older than `retentionDays` (default 7)
 * are swept on every roll. No size-based rotation. See `log-rotation.ts`.
 *
 * Three triggers cover all cases:
 *   1. Install-time one-shot — handles "process starts on day N with
 *      day N-1's data still in the live file" (server was offline
 *      across the boundary).
 *   2. Per-write check — handles long-lived processes that write at
 *      least once per day (the common case).
 *   3. Hourly periodic timer (unref'd) — handles long-lived processes
 *      that are silent across the boundary; ensures rotation lands
 *      shortly after midnight even if no log line is written.
 *
 * Independent of `startupLog`: that tool writes structured JSONL events
 * (`events.jsonl`); this one mirrors the raw stderr byte stream (`*.log`).
 */

import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { getOrCreateSid } from "./log-paths.js";
import { DEFAULT_RETENTION_DAYS, rotateLogIfNeeded } from "./log-rotation.js";

export interface FileLoggerOptions {
  filePath: string;
  /** Days of rolled-file history to keep. Default 7. */
  retentionDays?: number;
  /**
   * If true (default), prefix each line with `[pid=N sid=xxxxxx]`. The
   * prefix is what makes a shared file readable across processes.
   *
   * Disable only for tests, or for streams that are already structured.
   */
  prefix?: boolean;
  /**
   * Periodic rotation-check interval (ms). Default 1 hour. The timer
   * is `unref`'d so it never blocks process exit. Set to 0 to disable
   * (tests only — production callers always want the timer).
   */
  rotateCheckMs?: number;
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escape codes are control characters by definition.
const ANSI_RE = /\x1b\[[0-9;?]*[A-Za-z~]|\x1b\][^\x07]*\x07/g;

function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, "");
}

/**
 * Insert the per-process prefix at the start of every line in `text`.
 * A trailing `\n` is preserved verbatim.
 */
function prefixLines(text: string, prefix: string): string {
  if (text.length === 0) return text;
  const endsWithNewline = text.endsWith("\n");
  const body = endsWithNewline ? text.slice(0, -1) : text;
  const prefixed = body
    .split("\n")
    .map((line) => (line.length === 0 ? line : prefix + line))
    .join("\n");
  return endsWithNewline ? `${prefixed}\n` : prefixed;
}

function localDay(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

const DEFAULT_ROTATE_CHECK_MS = 60 * 60 * 1000;

/**
 * Mirror `process.stderr.write` to `filePath` with ANSI codes stripped.
 * Returns an uninstaller that restores the original `stderr.write`
 * (and clears the periodic rotation timer).
 */
export function installFileLogger(opts: FileLoggerOptions): () => void {
  const {
    filePath,
    retentionDays = DEFAULT_RETENTION_DAYS,
    prefix: usePrefix = true,
    rotateCheckMs = DEFAULT_ROTATE_CHECK_MS,
  } = opts;
  mkdirSync(dirname(filePath), { recursive: true });

  // One-shot rotate at install time: if the live file's mtime is on a
  // previous local day (server was offline across the boundary), roll
  // it before any new writes land.
  try {
    rotateLogIfNeeded(filePath, { retentionDays });
  } catch {
    /* best effort */
  }

  let currentDay = localDay();

  // pid + sid are stable for the life of the process; the timestamp is
  // recomputed at write time so a single shared log file is grep-able by date
  // when multiple processes interleave append-writes.
  const idSuffix = usePrefix
    ? ` pid=${process.pid} sid=${getOrCreateSid()}] `
    : "";

  const original = process.stderr.write;
  const bound = original.bind(process.stderr);

  const wrapped = ((
    chunk: string | Uint8Array,
    ...rest: unknown[]
  ): boolean => {
    const result = (bound as (...args: unknown[]) => boolean)(chunk, ...rest);

    try {
      // Rotate BEFORE appending so the live file's mtime still reflects
      // yesterday's last write — that's what `rotateLogIfNeeded` reads to
      // name the gz. Once we append the new chunk, the mtime would shift
      // to today and rotation would label today's bytes as today's, which
      // is correct only if we rotated first.
      const today = localDay();
      if (today !== currentDay) {
        rotateLogIfNeeded(filePath, { retentionDays });
        currentDay = today;
      }

      const text =
        typeof chunk === "string"
          ? chunk
          : Buffer.from(chunk).toString("utf-8");
      const clean = stripAnsi(text);
      const linePrefix = usePrefix
        ? `[${new Date().toISOString()}${idSuffix}`
        : "";
      const out = usePrefix ? prefixLines(clean, linePrefix) : clean;
      appendFileSync(filePath, out);
    } catch {
      /* file logging is best-effort — never block stderr */
    }

    return result;
  }) as typeof process.stderr.write;

  process.stderr.write = wrapped;

  // Periodic check catches the day boundary for silent processes
  // (long-lived daemons with no log writes across midnight).
  let timer: NodeJS.Timeout | null = null;
  if (rotateCheckMs > 0) {
    timer = setInterval(() => {
      try {
        const today = localDay();
        if (today !== currentDay) {
          rotateLogIfNeeded(filePath, { retentionDays });
          currentDay = today;
        }
      } catch {
        /* best effort */
      }
    }, rotateCheckMs);
    timer.unref();
  }

  return () => {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
    process.stderr.write = original;
  };
}
