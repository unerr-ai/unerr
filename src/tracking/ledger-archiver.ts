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
  renameSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";

const DEFAULT_RETAIN_MS = 7 * 24 * 60 * 60_000;

export interface ArchiveOptions {
  /** Retain entries newer than this (ms). Default 7 days. */
  retainMs?: number;
  /** Reference "now" timestamp (ms). Defaults to Date.now. */
  nowMs?: number;
}

export interface ArchiveResult {
  archived: number;
  kept: number;
  archivePath: string | null;
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

  if (!existsSync(filePath)) {
    return { archived: 0, kept: 0, archivePath: null };
  }

  const retainMs = opts.retainMs ?? DEFAULT_RETAIN_MS;
  const now = opts.nowMs ?? Date.now();
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
    return { archived: 0, kept: keep.length, archivePath: null };
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
  };
}
