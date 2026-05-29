/**
 * Shadow Ledger Archiver (ST-6).
 *
 * Splits `.unerr/ledger/shadow.jsonl` into:
 *   - kept  : entries with `ts >= now - retainMs` (rewritten in place)
 *   - archived : older entries gzipped into
 *                `.unerr/ledger/archive/<YYYY-MM-DD>.jsonl.gz`
 *
 * Daily archive keeps recent context fast (small JSONL) without losing
 * history — the gzip files are still grep-able with `zcat`. Derived facts in
 * `timeline.db` / `facts.db` are NOT touched; archival only affects the raw
 * append-only log.
 */

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";

const DEFAULT_RETAIN_MS = 7 * 24 * 60 * 60_000;
/** Gzipped daily archives older than this are deleted on each pass. */
export const DEFAULT_ARCHIVE_RETAIN_DAYS = 90;
const ARCHIVE_GZ_RE = /^\d{4}-\d{2}-\d{2}\.jsonl\.gz$/;

export interface ArchiveOptions {
  /** Retain entries newer than this (ms). Default 7 days. */
  retainMs?: number;
  /** Reference "now" timestamp (ms). Defaults to Date.now. */
  nowMs?: number;
  /** Delete gzipped archives older than this many days. Default 90. */
  archiveRetainDays?: number;
}

export interface ArchiveResult {
  archived: number;
  kept: number;
  archivePath: string | null;
  /** Gzipped daily archives deleted by the retention purge this pass. */
  purged: number;
}

/**
 * Delete `<archiveDir>/<YYYY-MM-DD>.jsonl.gz` files whose mtime is older than
 * `retainDays`. The archive directory previously grew without bound — daily
 * gzips were written but never reclaimed. Best-effort; never throws. Returns
 * the number of files removed.
 */
export function purgeOldArchives(
  archiveDir: string,
  retainDays: number = DEFAULT_ARCHIVE_RETAIN_DAYS,
  nowMs: number = Date.now()
): number {
  if (!existsSync(archiveDir)) return 0;
  const cutoff = nowMs - retainDays * 86_400_000;
  let removed = 0;
  try {
    for (const name of readdirSync(archiveDir)) {
      if (!ARCHIVE_GZ_RE.test(name)) continue;
      const full = join(archiveDir, name);
      try {
        const st = statSync(full);
        if (st.isFile() && st.mtimeMs < cutoff) {
          unlinkSync(full);
          removed++;
        }
      } catch {
        /* best effort */
      }
    }
  } catch {
    /* dir vanished mid-purge */
  }
  return removed;
}

/**
 * Run an archive pass over `<unerrDir>/ledger/shadow.jsonl`. Safe to run while
 * the proxy is appending: we read the snapshot, rewrite atomically via a
 * temp file + rename. Concurrent appends in the small window between read and
 * rename are preserved by reading the *tail* of the file after rewrite and
 * re-appending any new lines.
 */
export function archiveShadowLedger(
  unerrDir: string,
  opts: ArchiveOptions = {}
): ArchiveResult {
  const ledgerDir = join(unerrDir, "ledger");
  const filePath = join(ledgerDir, "shadow.jsonl");
  const archiveDir = join(ledgerDir, "archive");

  const now = opts.nowMs ?? Date.now();
  // Reclaim aged gzipped archives every pass, independent of whether there
  // are new entries to archive this time.
  const purged = purgeOldArchives(
    archiveDir,
    opts.archiveRetainDays ?? DEFAULT_ARCHIVE_RETAIN_DAYS,
    now
  );

  if (!existsSync(filePath)) {
    return { archived: 0, kept: 0, archivePath: null, purged };
  }

  const retainMs = opts.retainMs ?? DEFAULT_RETAIN_MS;
  const cutoff = now - retainMs;

  const raw = readFileSync(filePath, "utf-8");
  const initialBytes = Buffer.byteLength(raw);
  const lines = raw.split("\n").filter((l) => l.trim().length > 0);

  const keep: string[] = [];
  const archive: string[] = [];
  for (const line of lines) {
    let entryTs = Number.NaN;
    try {
      const obj = JSON.parse(line) as { ts?: string };
      if (typeof obj.ts === "string") entryTs = Date.parse(obj.ts);
    } catch {
      // Unparseable lines are kept — recovery code further down the stack
      // already deals with them.
      keep.push(line);
      continue;
    }
    if (Number.isFinite(entryTs) && entryTs < cutoff) {
      archive.push(line);
    } else {
      keep.push(line);
    }
  }

  if (archive.length === 0) {
    return { archived: 0, kept: keep.length, archivePath: null, purged };
  }

  mkdirSync(archiveDir, { recursive: true });
  const dateStamp = new Date(now).toISOString().slice(0, 10);
  const archivePath = join(archiveDir, `${dateStamp}.jsonl.gz`);
  const payload = `${archive.join("\n")}\n`;
  const gz = gzipSync(Buffer.from(payload, "utf-8"));

  if (existsSync(archivePath)) {
    // Same-day archive already exists — concatenate as a separate gzip stream.
    // gzip handles concatenated streams correctly when read with `zcat`.
    appendFileSync(archivePath, gz);
  } else {
    writeFileSync(archivePath, gz);
  }

  // Rewrite shadow.jsonl atomically. We snapshot the file size before write
  // and after, then re-append any bytes that landed between the two.
  const tmpPath = `${filePath}.tmp-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const kept = `${keep.join("\n")}${keep.length > 0 ? "\n" : ""}`;
  writeFileSync(tmpPath, kept, "utf-8");

  // Re-read the original to capture any lines appended during our work.
  const afterRaw = readFileSync(filePath, "utf-8");
  const afterBytes = Buffer.byteLength(afterRaw);
  if (afterBytes > initialBytes) {
    const tail = afterRaw.slice(raw.length);
    appendFileSync(tmpPath, tail);
  }
  renameSync(tmpPath, filePath);

  return {
    archived: archive.length,
    kept: keep.length,
    archivePath,
    purged,
  };
}
