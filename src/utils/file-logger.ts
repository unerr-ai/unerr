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
 * Rotation: rolls on either a UTC date change or `maxBytes` (whichever
 * fires first). Rolled files are gzipped to `*.log.YYYY-MM-DD.gz`. Files
 * older than `retentionDays` are swept on each roll and at boot. See
 * `log-rotation.ts` for the policy.
 *
 * Independent of `startupLog`: that tool writes structured JSONL events
 * (`events.jsonl`); this one mirrors the raw stderr byte stream (`*.log`).
 */

import { appendFileSync, mkdirSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { getOrCreateSid } from "./log-paths.js";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_RETENTION_DAYS,
  rotateLogIfNeeded,
} from "./log-rotation.js";

export interface FileLoggerOptions {
  filePath: string;
  /** Default 5_000_000 (5 MB). */
  maxBytes?: number;
  /** Days of rolled-file history to keep. Default 7. */
  retentionDays?: number;
  /**
   * If true (default), prefix each line with `[pid=N sid=xxxxxx]`. The
   * prefix is what makes a shared file readable across processes.
   *
   * Disable only for tests, or for streams that are already structured.
   */
  prefix?: boolean;
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

function utcDay(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Mirror `process.stderr.write` to `filePath` with ANSI codes stripped.
 * Returns an uninstaller that restores the original `stderr.write`.
 */
export function installFileLogger(opts: FileLoggerOptions): () => void {
  const {
    filePath,
    maxBytes = DEFAULT_MAX_BYTES,
    retentionDays = DEFAULT_RETENTION_DAYS,
    prefix: usePrefix = true,
  } = opts;
  mkdirSync(dirname(filePath), { recursive: true });

  let bytesWritten = 0;
  let currentDay = utcDay();
  try {
    bytesWritten = statSync(filePath).size;
  } catch {
    /* file doesn't exist yet */
  }

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

      bytesWritten += out.length;
      const today = utcDay();
      if (today !== currentDay || bytesWritten >= maxBytes) {
        if (rotateLogIfNeeded(filePath, { maxBytes, retentionDays })) {
          bytesWritten = 0;
        }
        currentDay = today;
      }
    } catch {
      /* file logging is best-effort — never block stderr */
    }

    return result;
  }) as typeof process.stderr.write;

  process.stderr.write = wrapped;

  return () => {
    process.stderr.write = original;
  };
}
