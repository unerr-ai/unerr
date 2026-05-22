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
export const _internal = { ROTATED_GZ_RE, LEGACY_NUMBERED_RE, localDateString };
