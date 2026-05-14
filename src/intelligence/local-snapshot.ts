/**
 * Local Snapshot Persistence — Sprint L2.2
 *
 * Saves and loads locally-indexed graphs as msgpack.gz files at
 * `<projectRoot>/.unerr/snapshots/graph.msgpack.gz`. On subsequent boots,
 * loads from snapshot instead of re-indexing. Re-indexes only when
 * source files have changed (mtime-based freshness check).
 *
 * Snapshot format is compatible with SnapshotEnvelope from local-graph.ts,
 * enabling reuse of CozoGraphStore.loadSnapshot() for the load path.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, relative } from "node:path";
import type {
  CompactEdge,
  CompactEntity,
  SnapshotEnvelope,
} from "./local-graph.js";

// ── Types ────────────────────────────────────────────────────────

export interface LocalSnapshotMeta {
  /** Absolute path to the snapshot file */
  path: string;
  /** Whether the snapshot exists on disk */
  exists: boolean;
}

// ── Constants ────────────────────────────────────────────────────

/** Snapshot file name within the repo's .unerr/snapshots/ directory */
const SNAPSHOT_FILENAME = "graph.msgpack.gz";

/** File extensions to check for freshness (must match local-indexer). */
const SOURCE_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".py",
  ".go",
  ".java",
  ".rs",
  ".c",
  ".h",
  ".cpp",
  ".cc",
  ".cxx",
  ".hpp",
]);

/** Directories to skip during freshness scan. */
const EXCLUDED_DIRS = new Set([
  "node_modules",
  "dist",
  "build",
  "out",
  ".git",
  ".hg",
  ".svn",
  "coverage",
  "__pycache__",
  ".mypy_cache",
  ".pytest_cache",
  "vendor",
  "target",
  ".next",
  ".nuxt",
  ".output",
  ".unerr",
  ".cache",
  ".turbo",
  ".parcel-cache",
]);

/** Path-prefix exclusions (relative to projectRoot). See local-indexer.ts. */
const EXCLUDED_PATH_PREFIXES = [
  ".claude/worktrees",
  ".cursor/worktrees",
  ".idea/worktrees",
];

function isExcludedPath(relPath: string): boolean {
  for (const prefix of EXCLUDED_PATH_PREFIXES) {
    if (relPath === prefix || relPath.startsWith(`${prefix}/`)) return true;
  }
  return false;
}

// ── Public API ───────────────────────────────────────────────────

/**
 * Generate the snapshot file path for a given project root.
 * Stores within the repo's own .unerr/snapshots/ directory.
 */
export function snapshotPath(projectRoot: string): string {
  return join(projectRoot, ".unerr", "snapshots", SNAPSHOT_FILENAME);
}

/**
 * Get snapshot metadata (path + existence).
 */
export function getSnapshotMeta(projectRoot: string): LocalSnapshotMeta {
  const path = snapshotPath(projectRoot);
  return { path, exists: existsSync(path) };
}

/**
 * Determine if the project needs re-indexing.
 *
 * Checks against the persistent DB file mtime first (preferred),
 * falls back to snapshot file mtime for backward compatibility.
 *
 * Returns true if:
 * - Neither persistent DB nor snapshot file exists
 * - Any source file has mtime newer than the reference file
 */
export function shouldReindex(projectRoot: string): boolean {
  // Prefer persistent DB mtime as freshness reference
  const dbPath = join(projectRoot, ".unerr", "graph.db");
  const snPath = snapshotPath(projectRoot);

  let referenceMtime: number | null = null;

  // Check persistent DB first
  if (existsSync(dbPath)) {
    try {
      referenceMtime = statSync(dbPath).mtimeMs;
    } catch {
      // fall through
    }
  }

  // Fall back to snapshot
  if (referenceMtime === null && existsSync(snPath)) {
    try {
      referenceMtime = statSync(snPath).mtimeMs;
    } catch {
      // fall through
    }
  }

  // No reference — definitely needs indexing
  if (referenceMtime === null) return true;

  return hasNewerSource(projectRoot, referenceMtime);
}

/**
 * Save a local snapshot to disk.
 *
 * Creates the snapshots directory if needed. Writes a SnapshotEnvelope
 * as gzipped msgpack.
 */
export async function persistLocalSnapshot(
  projectRoot: string,
  repoId: string,
  entities: CompactEntity[],
  edges: CompactEdge[],
): Promise<string> {
  const snapshotsDir = join(projectRoot, ".unerr", "snapshots");
  mkdirSync(snapshotsDir, { recursive: true });

  const envelope: SnapshotEnvelope = {
    version: 1,
    repoId,
    orgId: "local",
    entities,
    edges,
    generatedAt: new Date().toISOString(),
  };

  const { pack } = await import("msgpackr");
  const { gzipSync } = await import("node:zlib");

  const packed = pack(envelope) as Buffer;
  const compressed = gzipSync(packed);

  const path = snapshotPath(projectRoot);
  writeFileSync(path, compressed);

  return path;
}

/**
 * Load a local snapshot from disk into a CozoGraphStore.
 *
 * Returns true if snapshot was loaded, false if no snapshot exists.
 */
export async function loadLocalSnapshot(
  projectRoot: string,
  graphStore: import("./local-graph.js").CozoGraphStore,
): Promise<boolean> {
  const path = snapshotPath(projectRoot);
  if (!existsSync(path)) return false;

  try {
    const { unpack } = await import("msgpackr");
    const { gunzipSync } = await import("node:zlib");

    const raw = readFileSync(path);
    const buffer = gunzipSync(raw);
    const envelope = unpack(buffer) as SnapshotEnvelope;

    await graphStore.loadSnapshot(envelope);
    return true;
  } catch {
    return false;
  }
}

// ── Internal ─────────────────────────────────────────────────────

/**
 * Scan project directory for any source file newer than the given mtime.
 * Returns true as soon as one is found (short-circuit for performance).
 */
function hasNewerSource(projectRoot: string, snapshotMtime: number): boolean {
  return scanDirForNewer(projectRoot, snapshotMtime);
}

function scanDirForNewer(dir: string, threshold: number): boolean {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return false;
  }

  for (const entry of entries) {
    if (EXCLUDED_DIRS.has(entry)) continue;
    if (entry.startsWith(".") && entry !== ".") continue;

    const fullPath = join(dir, entry);
    let stat: ReturnType<typeof statSync>;
    try {
      stat = statSync(fullPath);
    } catch {
      continue;
    }

    if (stat.isDirectory()) {
      if (scanDirForNewer(fullPath, threshold)) return true;
    } else if (stat.isFile()) {
      const ext = fullPath.slice(fullPath.lastIndexOf(".")).toLowerCase();
      if (SOURCE_EXTENSIONS.has(ext) && stat.mtimeMs > threshold) {
        return true;
      }
    }
  }

  return false;
}
