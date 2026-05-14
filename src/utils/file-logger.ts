/**
 * Layer 12 / DM-0: rotating stderr → file mirror.
 *
 * Tees every `process.stderr.write` call to a `.log` file on disk so the
 * three Layer-12 processes (`unerrd`, `unerr`, `unerr --mcp`) still produce
 * inspectable output when they leave the foreground (auto-spawn from DM-3,
 * stdio-only IDE bridge, etc.).
 *
 * Rotation: when the current file passes `maxBytes`, rename `*.log` →
 * `*.log.1` (shift the rest), keep the last `keep` files, drop the oldest.
 *
 * Independent of `startupLog`: that tool writes structured JSONL events
 * (`unerr.jsonl`); this one mirrors the raw stderr byte stream (`*.log`).
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

export interface FileLoggerOptions {
  filePath: string;
  /** Default 5_000_000 (5 MB). */
  maxBytes?: number;
  /** Default 5. Number of rotated files to retain (`*.log.1` … `*.log.N`). */
  keep?: number;
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
 * Mirror `process.stderr.write` to `filePath` with ANSI codes stripped.
 * Returns an uninstaller that restores the original `stderr.write`.
 *
 * Side effects: ensures `dirname(filePath)` exists, opens the file in append
 * mode, never closes it (process lifetime). Terminal stderr is unchanged —
 * the original colored bytes still reach the TTY.
 */
export function installFileLogger(opts: FileLoggerOptions): () => void {
  const { filePath, maxBytes = 5_000_000, keep = 5 } = opts;
  mkdirSync(dirname(filePath), { recursive: true });

  let bytesWritten = 0;
  try {
    bytesWritten = statSync(filePath).size;
  } catch {
    /* file doesn't exist yet */
  }

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
      appendFileSync(filePath, clean);

      bytesWritten += clean.length;
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
