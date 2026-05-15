/**
 * Persistent CozoDB Factory — SQLite-backed graph storage.
 *
 * CozoDB persistence is the foundation of unerr's intelligence layer.
 * All indexed data (entities, edges, communities, conventions, rules)
 * persists across process restarts in `.unerr/graph.db`.
 *
 * This eliminates redundant work on every boot:
 *   - No snapshot deserialization
 *   - No community re-detection
 *   - No convention re-extraction
 *   - Instant graph availability (<200ms open)
 *
 * The in-memory engine is only used for tests and CI.
 */

import { existsSync, mkdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { CozoDb } from "./cozo-schema.js";

// ── Types ────────────────────────────────────────────────────────

export interface PersistentDbResult {
  /** The CozoDB instance (SQLite-backed) */
  db: CozoDb;
  /** Whether this is a fresh database (no prior data) */
  isNew: boolean;
  /** Absolute path to the .db file */
  dbPath: string;
}

// ── Constants ────────────────────────────────────────────────────

const GRAPH_DB_FILENAME = "graph.db";
const UNERR_DIR = ".unerr";

// ── Public API ─────────────────────��─────────────────────────────

/**
 * Open or create a persistent CozoDB at `{projectRoot}/.unerr/graph.db`.
 *
 * - If the DB file exists: opens it with all data intact (isNew = false)
 * - If the DB file doesn't exist: creates a new one (isNew = true)
 *
 * The caller is responsible for calling `db.close()` on shutdown.
 */
export async function openPersistentDb(
  projectRoot: string
): Promise<PersistentDbResult> {
  const unerrDir = join(projectRoot, UNERR_DIR);
  mkdirSync(unerrDir, { recursive: true });

  const dbPath = join(unerrDir, GRAPH_DB_FILENAME);
  const isNew = !existsSync(dbPath);

  const db = await createSqliteDb(dbPath);

  return { db, isNew, dbPath };
}

/**
 * Get the path where the persistent DB would be stored for a project.
 */
export function getDbPath(projectRoot: string): string {
  return join(projectRoot, UNERR_DIR, GRAPH_DB_FILENAME);
}

/**
 * Check if a persistent DB exists and has data.
 * Uses file size as a proxy — empty SQLite DBs are ~12KB,
 * populated ones are significantly larger.
 */
export function hasPersistedGraph(projectRoot: string): boolean {
  const dbPath = getDbPath(projectRoot);
  if (!existsSync(dbPath)) return false;
  try {
    const stat = statSync(dbPath);
    // A freshly-initialized DB with schema but no data is ~40KB.
    // A populated DB with entities is typically >100KB.
    return stat.size > 50_000;
  } catch {
    return false;
  }
}

/**
 * Get the mtime of the persistent DB file (for freshness checks).
 * Returns 0 if file doesn't exist.
 */
export function getDbMtime(projectRoot: string): number {
  const dbPath = getDbPath(projectRoot);
  try {
    return statSync(dbPath).mtimeMs;
  } catch {
    return 0;
  }
}

// ── Internal ──────────────────���──────────────────────────────────

async function createSqliteDb(dbPath: string): Promise<CozoDb> {
  const cozoModule = await import("cozo-node");
  const CozoDbConstructor = (
    cozoModule as { default?: { CozoDb: unknown }; CozoDb?: unknown }
  ).default
    ? (cozoModule as { default: { CozoDb: unknown } }).default.CozoDb
    : (cozoModule as { CozoDb: unknown }).CozoDb;

  // CozoDb(engine, path) — 'sqlite' for persistent, file-backed storage
  const db = new (CozoDbConstructor as any)("sqlite", dbPath) as CozoDb;

  return db;
}
