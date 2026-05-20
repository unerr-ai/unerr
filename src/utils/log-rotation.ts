/**
 * Log rotation + retention — shared by `file-logger`, `session-logger`,
 * and the boot-time sweep wired in `cli.ts` / `daemon.ts`.
 *
 * Two policies, layered:
 *   1. Roll on UTC date change, OR on byte cap (whichever fires first).
 *      Rolled files are gzipped: `<base>.log.YYYY-MM-DD.gz`.
 *      Same-day repeat rolls (size-triggered after a daily roll) get a
 *      numeric suffix: `<base>.log.YYYY-MM-DD.1.gz`, `.2.gz`, …
 *   2. Delete rolled files (new gzip form + legacy `.log.N` form) whose
 *      mtime is older than `retentionDays` (default 7).
 *
 * Race-safe: rotation renames the live file into a per-pid temp slot
 * before gzipping, so two processes colliding produce at most one roll.
 *
 * Best-effort: every fs call is guarded; failures never throw.
 */

import {
  existsSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { gzipSync } from "node:zlib";

export const DEFAULT_MAX_BYTES = 5_000_000;
export const DEFAULT_RETENTION_DAYS = 7;

export interface LogRotationOptions {
  /** Size cap; rolls when the live file passes this. Default 5 MB. */
  maxBytes?: number;
  /** Days of rolled-file history to keep. Default 7. */
  retentionDays?: number;
}

const ROTATED_GZ_RE = /\.(?:log|jsonl)\.\d{4}-\d{2}-\d{2}(?:\.\d+)?\.gz$/;
const LEGACY_NUMBERED_RE = /\.(?:log|jsonl)\.\d+$/;

/** True if `name` is a rotated log artefact (new gz form or legacy `.N`). */
export function isRotatedLog(name: string): boolean {
  return ROTATED_GZ_RE.test(name) || LEGACY_NUMBERED_RE.test(name);
}

function utcDateString(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * Roll `filePath` if it has crossed a UTC date boundary or `maxBytes`.
 * On roll: rename → gzip → write to `<filePath>.YYYY-MM-DD[.N].gz`,
 * then sweep stale rolls in the same directory. Returns true if a roll
 * happened, false if the file is fresh, missing, or another process beat
 * us to the rename.
 */
export function rotateLogIfNeeded(
  filePath: string,
  opts: LogRotationOptions = {}
): boolean {
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  const retentionDays = opts.retentionDays ?? DEFAULT_RETENTION_DAYS;

  let st: ReturnType<typeof statSync>;
  try {
    st = statSync(filePath);
  } catch {
    return false;
  }
  if (st.size === 0) return false;

  const today = utcDateString(new Date());
  const fileDay = utcDateString(st.mtime);
  if (st.size < maxBytes && fileDay >= today) return false;

  // Roll naming uses the source file's UTC day — the date the bytes were
  // actually written, not the wall clock at rotation time. Lets you find
  // "yesterday's logs" by name even if the daemon noticed the date change
  // hours into today.
  let target = `${filePath}.${fileDay}.gz`;
  let n = 1;
  while (existsSync(target)) {
    target = `${filePath}.${fileDay}.${n}.gz`;
    n++;
  }

  const temp = `${filePath}.rotating-${process.pid}-${Date.now()}`;
  try {
    renameSync(filePath, temp);
  } catch {
    return false;
  }

  try {
    const buf = readFileSync(temp);
    writeFileSync(target, gzipSync(buf));
    unlinkSync(temp);
  } catch {
    /* best effort — temp left behind is fine; sweep won't touch it */
  }

  try {
    sweepRotatedLogs(dirname(filePath), retentionDays);
  } catch {
    /* best effort */
  }
  return true;
}

/**
 * Delete rotated log files (gz form + legacy numbered form) in `dir`
 * whose mtime is older than `retentionDays`. Best-effort; never throws.
 * Returns the number of files removed.
 */
export function sweepRotatedLogs(
  dir: string,
  retentionDays: number = DEFAULT_RETENTION_DAYS
): number {
  if (!existsSync(dir)) return 0;
  const cutoff = Date.now() - retentionDays * 86_400_000;
  let removed = 0;
  try {
    for (const name of readdirSync(dir)) {
      if (!isRotatedLog(name)) continue;
      const full = join(dir, name);
      try {
        const st = statSync(full);
        if (!st.isFile()) continue;
        if (st.mtimeMs < cutoff) {
          unlinkSync(full);
          removed++;
        }
      } catch {
        /* best effort */
      }
    }
  } catch {
    /* dir disappeared mid-sweep */
  }
  return removed;
}

/** Exposed for tests. */
export const _internal = { ROTATED_GZ_RE, LEGACY_NUMBERED_RE, utcDateString };
