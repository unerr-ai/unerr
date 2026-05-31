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
  // Put graph.db in WAL journal mode BEFORE cozo opens it. cozo-node exposes no
  // journal_mode option, and cozo's SQLite backend is a connection POOL
  // (cozo-core/src/storage/sqlite.rs: pool of `ConnectionThreadSafe`), so reads
  // and writes run on separate SQLite connections. In the default DELETE
  // journal mode a writer's EXCLUSIVE lock blocks every reader — which is what
  // starved warm MCP reads behind long drift/orphan writes. WAL lets a single
  // writer and many readers proceed concurrently, and journal_mode=WAL is
  // persistent across reopen (sqlite.org/wal.html §3.3), so cozo's later
  // connections inherit it. Best-effort: a failure here must not block graph
  // open — we just fall back to the default journal mode.
  await enableWalMode(dbPath);

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

/**
 * Set `journal_mode = WAL` on the graph.db SQLite file out-of-band, using the
 * better-sqlite3 driver already vendored for metrics.db (see metrics-store.ts).
 * Opened and closed before cozo touches the file, so the two drivers never hold
 * the connection at once. WAL is a persistent file property, so cozo's pooled
 * connections pick it up. Idempotent (re-running on an already-WAL db is a
 * no-op) and best-effort — any failure is logged and swallowed so a missing/
 * locked driver can never block graph startup.
 */
async function enableWalMode(dbPath: string): Promise<void> {
  try {
    const { default: Database } = await import("better-sqlite3");
    const sqlite = new Database(dbPath);
    try {
      sqlite.pragma("journal_mode = WAL");
    } finally {
      sqlite.close();
    }
  } catch (err) {
    process.stderr.write(
      `[unerr] WARN: could not set WAL journal_mode on ${dbPath} (${err instanceof Error ? err.message : String(err)}); continuing in default journal mode\n`
    );
  }
}

/**
 * Fold the WAL back into graph.db and truncate the WAL file to zero bytes.
 *
 * In WAL mode SQLite's only automatic checkpoint is PASSIVE (every ~1000 pages,
 * on COMMIT). A PASSIVE checkpoint can copy committed frames into the main db
 * but CANNOT reset/truncate the WAL file while any connection still holds an
 * older read snapshot — and cozo's SQLite backend keeps a pool of warm reader
 * connections open in the long-lived per-repo proxy, so that reset never
 * happens. Reindex write bursts (a full reindex re-upserts the whole graph via
 * `:put`) then append faster than PASSIVE reclaims, and the WAL file's
 * high-water mark climbs without bound (observed up to ~480MB against a 40MB
 * graph.db). `wal_checkpoint(TRUNCATE)` folds all reclaimable frames and resets
 * the WAL file to zero.
 *
 * Called out-of-band on a short-lived better-sqlite3 connection — the same
 * driver and pattern as `enableWalMode`. WAL mode permits concurrent
 * connections, so this is safe to run while cozo holds the file. Best-effort:
 * `TRUNCATE` returns SQLITE_BUSY (and falls back to a partial PASSIVE fold) if a
 * reader is mid-snapshot; the `busy_timeout` gives it a brief window and any
 * residual failure is swallowed so a checkpoint can never block a reindex or
 * shutdown. Idempotent — checkpointing an empty/absent WAL is a no-op.
 */
export async function checkpointWal(dbPath: string): Promise<void> {
  try {
    const { default: Database } = await import("better-sqlite3");
    const sqlite = new Database(dbPath);
    try {
      sqlite.pragma("busy_timeout = 2000");
      sqlite.pragma("wal_checkpoint(TRUNCATE)");
    } finally {
      sqlite.close();
    }
  } catch (err) {
    process.stderr.write(
      `[unerr] WARN: WAL checkpoint failed on ${dbPath} (${err instanceof Error ? err.message : String(err)}); WAL left for the next checkpoint\n`
    );
  }
}
