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
 * Each written chunk is prefixed with `[pid=N sid=xxxxxx]` so the consumer
 * can disambiguate processes inside a shared file. The `sid` is the
 * spawn-lineage correlation ID from `log-paths.ts`.
 *
 * Rotation: when the current file passes `maxBytes`, rename `*.log` →
 * `*.log.1` (shift the rest), keep the last `keep` files, drop the oldest.
 *
 * Independent of `startupLog`: that tool writes structured JSONL events
 * (`events.jsonl`); this one mirrors the raw stderr byte stream (`*.log`).
 */

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  renameSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { dirname } from "node:path";
import { getOrCreateSid } from "./log-paths.js";

export interface FileLoggerOptions {
  filePath: string;
  /** Default 5_000_000 (5 MB). */
  maxBytes?: number;
  /** Default 5. Number of rotated files to retain (`*.log.1` … `*.log.N`). */
  keep?: number;
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

function rotate(filePath: string, keep: number): void {
  for (let i = keep; i >= 1; i--) {
    const cur = i === 1 ? filePath : `${filePath}.${i - 1}`;
    const next = `${filePath}.${i}`;
    if (!existsSync(cur)) continue;
    if (i === keep && existsSync(next)) {
      try {
        unlinkSync(next);
      } catch {
        /* best effort */
      }
    }
    try {
      renameSync(cur, next);
    } catch {
      /* best effort */
    }
  }
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

/**
 * Mirror `process.stderr.write` to `filePath` with ANSI codes stripped.
 * Returns an uninstaller that restores the original `stderr.write`.
 */
export function installFileLogger(opts: FileLoggerOptions): () => void {
  const {
    filePath,
    maxBytes = 5_000_000,
    keep = 5,
    prefix: usePrefix = true,
  } = opts;
  mkdirSync(dirname(filePath), { recursive: true });

  let bytesWritten = 0;
  try {
    bytesWritten = statSync(filePath).size;
  } catch {
    /* file doesn't exist yet */
  }

  const linePrefix = usePrefix
    ? `[pid=${process.pid} sid=${getOrCreateSid()}] `
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
      const out = usePrefix ? prefixLines(clean, linePrefix) : clean;
      appendFileSync(filePath, out);

      bytesWritten += out.length;
      if (bytesWritten >= maxBytes) {
        rotate(filePath, keep);
        bytesWritten = 0;
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
