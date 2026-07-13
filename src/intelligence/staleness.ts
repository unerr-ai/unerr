/**
 * Startup staleness planner (Bug A).
 *
 * A persistent CozoDB graph already holds every entity, edge, community,
 * convention and rule across restarts. Re-indexing the whole project on every
 * boot — the historical behaviour — starves the event loop for tens of seconds
 * and, when `unerrd` warm-starts several repos, the overlapping full reindexes
 * race the MCP client's per-request timeout (the -32001 storm).
 *
 * This planner replaces "always reindex" with "reindex only what changed". It
 * compares each on-disk source file against the content hash recorded by the
 * last index pass (`file_content_hashes`, seeded by both the full and the
 * incremental indexers) and returns one of three plans:
 *
 *   - `skip`        — no file changed since the last pass; the graph is current.
 *   - `incremental` — a bounded set of files changed; re-index only those.
 *   - `full`        — no baseline hashes (first run after a schema change), or
 *                     the change set is large enough that a full rebuild
 *                     (communities, conventions, search index) is warranted.
 *
 * The hash algorithm and input (readFileSync utf-8 → sha1) match
 * `incremental-indexer.ts:hashContent` and `local-indexer.ts` Phase 6.4 exactly,
 * so a hash computed here is directly comparable to a stored one.
 */

import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { relative } from "node:path";
import { EXTRACTOR_VERSION } from "./ast-extractor.js";
import type { CozoGraphStore } from "./local-graph.js";

// ── Tunables ─────────────────────────────────────────────────────

/**
 * Absolute and proportional caps on the change set before a full reindex is
 * preferred over an incremental pass. Incremental skips community / convention /
 * search-index rebuilds (deferred to a later full pass), so a large change set
 * is better served by the full pipeline. Below BOTH caps → incremental.
 */
const INCREMENTAL_MAX_FILES = 50;
const INCREMENTAL_MAX_FRACTION = 0.3;

/** Files hashed between event-loop yields, so the scan never starves MCP. */
const HASH_BATCH = 64;

// ── Types ────────────────────────────────────────────────────────

export type IndexPlanMode = "skip" | "incremental" | "full";

export interface IndexPlan {
  mode: IndexPlanMode;
  /** Relative paths to re-index (changed + deleted). Empty for `skip`/`full`. */
  changedFiles: string[];
  /** Relative paths present on disk but absent from / differing in the graph. */
  changed: string[];
  /** Relative paths recorded last pass but no longer on disk. */
  deleted: string[];
  /** Source files discovered on disk this pass. */
  totalFiles: number;
  /** Rows in `file_content_hashes` (0 ⇒ no baseline ⇒ full). */
  storedHashCount: number;
  /** Single-line, human-readable justification for the chosen mode. */
  reason: string;
}

// ── Internal ─────────────────────────────────────────────────────

function hashContent(content: string): string {
  return createHash("sha1").update(content).digest("hex");
}

interface StoredHash {
  hash: string;
  indexedAt: number;
}

async function readStoredHashes(
  graphStore: CozoGraphStore
): Promise<Map<string, StoredHash>> {
  const map = new Map<string, StoredHash>();
  try {
    const result = await graphStore.db.run(
      "?[file_path, content_hash, indexed_at] := *file_content_hashes{file_path, content_hash, indexed_at}"
    );
    for (const row of result.rows) {
      map.set(row[0] as string, {
        hash: row[1] as string,
        indexedAt: Number(row[2] ?? 0),
      });
    }
  } catch {
    /* relation absent / unreadable → treated as no baseline by caller */
  }
  return map;
}

async function yieldToLoop(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

/**
 * Read the extractor-logic version stamped by the last full index pass.
 * Returns null when absent (graph predates version stamping) or unreadable.
 */
async function readStoredExtractorVersion(
  graphStore: CozoGraphStore
): Promise<string | null> {
  try {
    const result = await graphStore.db.run(
      '?[value] := *index_meta{key: "extractor_version", value}'
    );
    const row = result.rows[0];
    return row ? (row[0] as string) : null;
  } catch {
    return null; // relation absent / unreadable → treated as mismatch by caller
  }
}

// ── Entry ────────────────────────────────────────────────────────

/**
 * Decide whether — and how — to re-index a populated persistent graph on boot.
 * Pure read: never mutates the graph. Yields to the event loop while hashing so
 * the MCP server stays responsive during the scan.
 */
export async function computeIndexPlan(
  projectRoot: string,
  graphStore: CozoGraphStore
): Promise<IndexPlan> {
  const { discoverSourceFiles } = await import("./local-indexer.js");
  const absFiles = discoverSourceFiles(projectRoot);
  const stored = await readStoredHashes(graphStore);

  // Extractor-version gate. When the entity-extraction logic changes, source
  // files are byte-identical (hashes match) but their stored entities are stale
  // — a content-hash diff would `skip` and the graph would never refresh. If
  // the stored extractor version differs from the current one (or is absent on
  // an older graph), force a full reindex so every file is re-extracted.
  if (stored.size > 0) {
    const storedVersion = await readStoredExtractorVersion(graphStore);
    if (storedVersion !== EXTRACTOR_VERSION) {
      return {
        mode: "full",
        changedFiles: [],
        changed: [],
        deleted: [],
        totalFiles: absFiles.length,
        storedHashCount: stored.size,
        reason: `extractor version changed (${storedVersion ?? "none"} → ${EXTRACTOR_VERSION}) — full reindex to refresh entities`,
      };
    }
  }

  // No baseline hashes (graph predates content-hash seeding, e.g. a schema
  // change before the first hashed index) — a full pass establishes the
  // baseline and refreshes any column the older graph lacks.
  if (stored.size === 0) {
    return {
      mode: "full",
      changedFiles: [],
      changed: [],
      deleted: [],
      totalFiles: absFiles.length,
      storedHashCount: 0,
      reason: "no baseline content hashes — full index to seed staleness table",
    };
  }

  const changed: string[] = [];
  const seen = new Set<string>();

  let i = 0;
  for (const absPath of absFiles) {
    const relPath = relative(projectRoot, absPath);
    seen.add(relPath);
    const prior = stored.get(relPath);

    // New file (no recorded hash) → always changed.
    if (!prior) {
      changed.push(relPath);
    } else {
      // mtime fast-path: a file last written at or before its recorded index
      // time cannot have drifted, so skip the read+hash. Only files touched
      // after indexing (or with no usable mtime) are hashed to confirm.
      let mustHash = true;
      try {
        const mtimeMs = statSync(absPath).mtimeMs;
        if (mtimeMs <= prior.indexedAt) mustHash = false;
      } catch {
        /* stat failed → fall through to hash */
      }
      if (mustHash) {
        try {
          const content = readFileSync(absPath, "utf-8");
          if (hashContent(content) !== prior.hash) changed.push(relPath);
        } catch {
          /* unreadable now → let the indexer handle it as changed */
          changed.push(relPath);
        }
      }
    }

    if (++i % HASH_BATCH === 0) await yieldToLoop();
  }

  // Files recorded last pass but gone from disk → deletions to reconcile.
  const deleted: string[] = [];
  for (const relPath of stored.keys()) {
    if (!seen.has(relPath)) deleted.push(relPath);
  }

  const changeCount = changed.length + deleted.length;

  if (changeCount === 0) {
    return {
      mode: "skip",
      changedFiles: [],
      changed,
      deleted,
      totalFiles: absFiles.length,
      storedHashCount: stored.size,
      reason: `no files changed since last index (${absFiles.length} scanned)`,
    };
  }

  const fractionCap = Math.max(
    INCREMENTAL_MAX_FILES,
    Math.floor(absFiles.length * INCREMENTAL_MAX_FRACTION)
  );
  const withinIncrementalBudget =
    changeCount <= INCREMENTAL_MAX_FILES && changeCount <= fractionCap;

  if (withinIncrementalBudget) {
    return {
      mode: "incremental",
      changedFiles: [...changed, ...deleted],
      changed,
      deleted,
      totalFiles: absFiles.length,
      storedHashCount: stored.size,
      reason: `${changed.length} changed + ${deleted.length} deleted ≤ incremental cap (${INCREMENTAL_MAX_FILES})`,
    };
  }

  return {
    mode: "full",
    changedFiles: [],
    changed,
    deleted,
    totalFiles: absFiles.length,
    storedHashCount: stored.size,
    reason: `${changed.length} changed + ${deleted.length} deleted (> incremental cap ${INCREMENTAL_MAX_FILES}) — full reindex`,
  };
}
