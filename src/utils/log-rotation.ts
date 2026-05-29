/**
 * Log rotation + retention — shared by `file-logger`, `session-logger`,
 * and the boot-time sweep wired in `cli.ts` / `daemon.ts`.
 *
 * Policy: one gzipped archive per logfile per **local** day.
 *   - On the first observation that the live file's mtime is on a
 *     previous local day, the live file is renamed → gzipped to
 *     `<base>.log.YYYY-MM-DD.gz` (the date comes from the file's
 *     mtime, i.e. the day the bytes were actually written), then
 *     truncated so the day starts fresh.
 *   - Rolled archives older than `retentionDays` (default 7) are
 *     deleted on every roll and at boot. Net steady state: ≤ 7
 *     `.gz` archives + 1 live file per logfile.
 *
 * No size-based rotation. The previous size cap produced dozens of
 * `<base>.log.<date>.N.gz` files per heavy day, which is exactly
 * what this policy fixes.
 *
 * Race-safe: rotation renames the live file into a per-pid temp slot
 * before gzipping, so two processes colliding produce at most one roll.
 * If a `.YYYY-MM-DD.gz` already exists (e.g. a partial rotation crashed
 * then a peer raced in), a numeric collision suffix (`.1.gz`, `.2.gz`)
 * is appended as defensive insurance. In normal operation this path
 * never fires.
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

export const DEFAULT_RETENTION_DAYS = 7;

export interface LogRotationOptions {
  /** Days of rolled-file history to keep. Default 7. */
  retentionDays?: number;
}

const ROTATED_GZ_RE = /\.(?:log|jsonl)\.\d{4}-\d{2}-\d{2}(?:\.\d+)?\.gz$/;
const LEGACY_NUMBERED_RE = /\.(?:log|jsonl)\.\d+$/;
/** The per-pid temp slot a roll renames the live file into before gzipping. */
const ROTATING_TEMP_RE = /\.rotating-\d+-\d+$/;

/**
 * Upper bound on the bytes we will read into memory to gzip a rolled file.
 * `gzipSync` buffers the whole input, so a runaway log day (we have seen an
 * 8.8 GB single-file roll) would OOM here — and the failed roll used to leak
 * its `.rotating-*` temp permanently. Rolls larger than this are dropped
 * instead of compressed: pathological debug logs are not worth an OOM.
 */
const MAX_GZIP_BYTES = 256 * 1024 * 1024;

/**
 * A real roll (rename → gzip → unlink) completes in seconds. A `.rotating-*`
 * temp older than this was orphaned by a crash/OOM and is safe to reclaim.
 */
const ROTATING_TEMP_MAX_AGE_MS = 3_600_000;

/** True if `name` is a rotated log artefact (new gz form or legacy `.N`). */
export function isRotatedLog(name: string): boolean {
  return ROTATED_GZ_RE.test(name) || LEGACY_NUMBERED_RE.test(name);
}

/**
 * `YYYY-MM-DD` in the host's local timezone. Local — not UTC — so the
 * rotation boundary matches the user's wall-clock day (the user's stated
 * requirement: rotate "post local day start time").
 */
function localDateString(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/**
 * Roll `filePath` if its mtime is on a previous local day.
 * On roll: rename → gzip → write to `<filePath>.YYYY-MM-DD.gz`, then
 * sweep stale rolls in the same directory. Returns true if a roll
 * happened, false if the file is fresh, missing, empty, or another
 * process beat us to the rename.
 */
export function rotateLogIfNeeded(
  filePath: string,
  opts: LogRotationOptions = {}
): boolean {
  const retentionDays = opts.retentionDays ?? DEFAULT_RETENTION_DAYS;

  let st: ReturnType<typeof statSync>;
  try {
    st = statSync(filePath);
  } catch {
    return false;
  }
  if (st.size === 0) return false;

  const today = localDateString(new Date());
  const fileDay = localDateString(st.mtime);
  if (fileDay >= today) return false;

  // Roll naming uses the source file's local day — the date the bytes
  // were actually written, not the wall clock at rotation time. Lets you
  // find "yesterday's logs" by name even if the daemon noticed the date
  // change hours into today.
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
    const tempSize = statSync(temp).size;
    if (tempSize > MAX_GZIP_BYTES) {
      // Pathological oversized roll. Compressing it would buffer the whole
      // file in memory and OOM — exactly how an 8.8 GB `.rotating-*` orphan
      // was leaked. Drop it rather than risk the crash.
      unlinkSync(temp);
    } else {
      writeFileSync(target, gzipSync(readFileSync(temp)));
      unlinkSync(temp);
    }
  } catch {
    // Compression failed (OOM, disk full, …). NEVER leak the temp slot —
    // reclaim it now so it can't accumulate as an orphan. If even the
    // unlink fails, the stale-temp sweep below is the backstop.
    try {
      unlinkSync(temp);
    } catch {
      /* temp already gone or unremovable */
    }
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
 * whose mtime is older than `retentionDays`, plus orphaned `.rotating-*`
 * temp slots older than an hour (left behind by a crashed/OOM'd roll).
 * Best-effort; never throws. Returns the number of files removed.
 */
export function sweepRotatedLogs(
  dir: string,
  retentionDays: number = DEFAULT_RETENTION_DAYS
): number {
  if (!existsSync(dir)) return 0;
  const cutoff = Date.now() - retentionDays * 86_400_000;
  const tempCutoff = Date.now() - ROTATING_TEMP_MAX_AGE_MS;
  let removed = 0;
  try {
    for (const name of readdirSync(dir)) {
      const isRotated = isRotatedLog(name);
      const isStaleTemp = ROTATING_TEMP_RE.test(name);
      if (!isRotated && !isStaleTemp) continue;
      const full = join(dir, name);
      try {
        const st = statSync(full);
        if (!st.isFile()) continue;
        const limit = isStaleTemp ? tempCutoff : cutoff;
        if (st.mtimeMs < limit) {
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
export const _internal = {
  ROTATED_GZ_RE,
  LEGACY_NUMBERED_RE,
  ROTATING_TEMP_RE,
  MAX_GZIP_BYTES,
  ROTATING_TEMP_MAX_AGE_MS,
  localDateString,
};
