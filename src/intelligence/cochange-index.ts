/**
 * Cochange flat-file index — hook-readable cache.
 *
 * `co_change_groups` lives in facts.db (CozoDB). Hook subprocesses
 * cannot cheaply open CozoDB on every Edit/Write — boot cost is too
 * high for a hot path. This module maintains a small JSON sidecar at
 * `.unerr/state/cochange-index.json` that the proxy updates on every
 * successful `upsertCoChange` and the hook reads with one `readFileSync`.
 *
 * Format:
 *   { "<file-path>": ["<partner-1>", "<partner-2>", ...], ... }
 *
 * Only `f:<path>` anchors land here; `e:`, `g:`, `p:` anchors are
 * intentionally skipped — the hint targets a single edited file, so
 * file-to-file partners are the only useful pairing.
 *
 * Best-effort: read/write failures are swallowed. The hint is purely
 * advisory; a stale or missing index just means the hint doesn't fire.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const MAX_PARTNERS_PER_FILE = 8;

export interface CoChangeIndex {
  [filePath: string]: string[];
}

/** Resolve the on-disk path for the cochange index. */
export function cochangeIndexPath(unerrDir: string): string {
  return join(unerrDir, "state", "cochange-index.json");
}

/** Read the index. Returns empty object when missing or unreadable. */
export function readCoChangeIndex(unerrDir: string): CoChangeIndex {
  const path = cochangeIndexPath(unerrDir);
  if (!existsSync(path)) return {};
  try {
    const raw = readFileSync(path, "utf-8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as CoChangeIndex;
    }
    return {};
  } catch {
    return {};
  }
}

/**
 * Merge a new co-change group into the on-disk index. Partners list per
 * file is capped at `MAX_PARTNERS_PER_FILE` (most recent wins).
 *
 * Only `f:<path>` anchors contribute; non-file anchors are ignored.
 */
export function recordCoChangeGroup(
  unerrDir: string,
  anchors: readonly string[]
): void {
  const filePaths = anchors
    .filter((a) => a.startsWith("f:"))
    .map((a) => a.slice(2))
    .filter((p) => p.length > 0);
  if (filePaths.length < 2) return;

  const path = cochangeIndexPath(unerrDir);
  try {
    mkdirSync(dirname(path), { recursive: true });
  } catch {
    /* best effort */
  }

  const index = readCoChangeIndex(unerrDir);
  for (const file of filePaths) {
    const partners = filePaths.filter((p) => p !== file);
    const existing = index[file] ?? [];
    const merged: string[] = [];
    for (const p of [...partners, ...existing]) {
      if (!merged.includes(p)) merged.push(p);
      if (merged.length >= MAX_PARTNERS_PER_FILE) break;
    }
    index[file] = merged;
  }

  try {
    writeFileSync(path, JSON.stringify(index), "utf-8");
  } catch {
    /* best effort */
  }
}

/**
 * Look up co-change partners for a single file path. Returns at most
 * `limit` partner paths, in insertion order.
 */
export function lookupCoChangePartners(
  unerrDir: string,
  filePath: string,
  limit = 3
): string[] {
  const index = readCoChangeIndex(unerrDir);
  const partners = index[filePath] ?? [];
  return partners.slice(0, limit);
}
