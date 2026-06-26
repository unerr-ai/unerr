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

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { loadNodeSqlite } from "../utils/node-sqlite.js";
import { isCompiledBinary } from "../utils/self-spawn.js";
import type { CozoDb } from "./cozo-schema.js";
import { getCozoDbCtor } from "./native-cozo.js";

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

  // Fold + truncate any WAL the previous session left behind, NOW — the cozo
  // constructor below is the first cozo touch of this file, so no cozo reader
  // pool is open yet and this is a guaranteed reader gap where TRUNCATE fully
  // resets the WAL to zero. Without it, a graph.db-wal that grew large in a
  // prior session (observed 177MB while node:sqlite checkpointing was broken)
  // would persist until the next reindex or shutdown — an idle repo, edited by
  // no one, would never reclaim it. Mirrors the boot truncate facts.db /
  // timeline.db already get in proxy.ts. Best-effort: an absent WAL is a no-op
  // and any failure is swallowed so it can never block graph open.
  await checkpointWal(dbPath);

  // Resolves to the `cozo-node` package under Node, or the addon embedded in
  // the compiled binary — see native-cozo.ts. Either way a CozoDb constructor.
  const CozoDbConstructor = await getCozoDbCtor();

  // CozoDb(engine, path) — 'sqlite' for persistent, file-backed storage
  const db = new CozoDbConstructor("sqlite", dbPath) as CozoDb;

  return db;
}

/**
 * Set `journal_mode = WAL` on the graph.db SQLite file out-of-band, using
 * Node's built-in `node:sqlite` (DatabaseSync). Opened and closed before cozo
 * touches the file, so the two drivers never hold the connection at once. WAL
 * is a persistent file property, so cozo's pooled connections pick it up.
 * Idempotent (re-running on an already-WAL db is a no-op) and best-effort —
 * any failure is logged and swallowed so a driver error can never block graph
 * startup.
 */
async function enableWalMode(dbPath: string): Promise<void> {
  try {
    const { DatabaseSync } = loadNodeSqlite();
    const sqlite = new DatabaseSync(dbPath);
    try {
      // Only journal_mode is set here. It is a PERSISTENT file-header property,
      // so cozo's own pooled connections inherit WAL when they open the file.
      // wal_autocheckpoint / synchronous are deliberately NOT set: they are
      // PER-CONNECTION and cannot persist onto cozo's connection (cozo-node
      // exposes no pragma API), so setting them on this throwaway handle is a
      // proven no-op for cozo's actual writer. WAL truncation is handled out of
      // band by checkpointWal/checkpointWalDetached in reader gaps.
      sqlite.exec("PRAGMA journal_mode=WAL");
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
 * Called out-of-band on a short-lived `node:sqlite` DatabaseSync connection —
 * the same driver and pattern as `enableWalMode`.
 *
 * SAFETY — only call this when cozo does NOT have dbPath open in THIS process.
 * node:sqlite and cozo are two separately-linked SQLite copies; each keeps
 * its own in-process lock table, so SQLite's posix-lock workaround does not
 * span them. When this function's `sqlite.close()` closes its file descriptor,
 * POSIX semantics drop EVERY advisory lock this process holds on dbPath —
 * including the read locks cozo's pooled readers believe they hold
 * (sqlite.org/howtocorrupt.html §2.3). A later truncating checkpoint then runs
 * under a live reader's feet: the reader follows a stale WAL-index frame
 * offset into a truncated WAL → SIGBUS in sqlite3WalFindFrame, or reads a
 * corrupt page → cozo panics on a rayon worker → SIGABRT. Both crash modes
 * were observed killing the per-repo proxy mid-session. Safe call sites are
 * boot (before cozo opens the file) and shutdown (after `db.close()`). For a
 * live-session checkpoint use `checkpointWalDetached` — a separate PROCESS is
 * SQLite's standard multi-process WAL scenario and coordinates correctly with
 * cozo's readers through the -shm file.
 *
 * Best-effort: `TRUNCATE` returns SQLITE_BUSY (and falls back to a partial
 * PASSIVE fold) if a reader is mid-snapshot; the `busy_timeout` gives it a
 * brief window and any residual failure is swallowed so a checkpoint can never
 * block a reindex or shutdown. Idempotent — checkpointing an empty/absent WAL
 * is a no-op.
 */
export async function checkpointWal(dbPath: string): Promise<void> {
  try {
    const { DatabaseSync } = loadNodeSqlite();
    const sqlite = new DatabaseSync(dbPath);
    try {
      sqlite.exec("PRAGMA busy_timeout=2000");
      // `wal_checkpoint(TRUNCATE)` returns `{ busy, log, checkpointed }`.
      // `busy === 1` means a reader held a snapshot, so reclaimable frames were
      // folded into the main db (the PASSIVE part) but the WAL file could NOT be
      // truncated — it stays at its high-water mark. Ignoring this return (the
      // prior behavior) silently left the WAL bloated whenever any MCP read was
      // in flight. The proxy's readers are short-lived, so retry with a short
      // backoff to catch a reader-free window; bounded so a checkpoint can never
      // block a reindex/shutdown for long.
      const MAX_ATTEMPTS = 6;
      const stmt = sqlite.prepare("PRAGMA wal_checkpoint(TRUNCATE)");
      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        const res = stmt.get() as { busy?: number } | undefined;
        const busy = res?.busy ?? 0;
        if (busy === 0) return; // WAL fully reset to zero
        if (attempt < MAX_ATTEMPTS) {
          // 50, 100, 200, 400, 800 ms — ~1.55s total worst case.
          await new Promise<void>((resolve) =>
            setTimeout(resolve, 50 * 2 ** (attempt - 1))
          );
        }
      }
      process.stderr.write(
        `[unerr] WARN: WAL checkpoint on ${dbPath} could not truncate after ${MAX_ATTEMPTS} attempts (reader pinned); frames folded into the main db, WAL file left for the next checkpoint\n`
      );
    } finally {
      sqlite.close();
    }
  } catch (err) {
    process.stderr.write(
      `[unerr] WARN: WAL checkpoint failed on ${dbPath} (${err instanceof Error ? err.message : String(err)}); WAL left for the next checkpoint\n`
    );
  }
}

/**
 * Child-process body for `checkpointWalDetached`, run via `node -e`.
 * Mirrors `checkpointWal`'s busy-retry loop (6 attempts, 50ms→800ms backoff,
 * ~1.55s worst case) but synchronously — `Atomics.wait` is a plain blocking
 * sleep, fine in a single-purpose child. argv layout under `-e`:
 * argv[1] = dbPath. Uses Node's built-in `node:sqlite` (no module resolution
 * needed). Everything is best-effort and silent: stdio is ignored and any
 * failure just leaves the WAL for the next boot/shutdown checkpoint.
 */
const CHECKPOINT_CHILD_SCRIPT = `
try {
  const { DatabaseSync } = require("node:sqlite");
  const sqlite = new DatabaseSync(process.argv[1]);
  try {
    sqlite.exec("PRAGMA busy_timeout=2000");
    const stmt = sqlite.prepare("PRAGMA wal_checkpoint(TRUNCATE)");
    for (let attempt = 1; attempt <= 6; attempt++) {
      const res = stmt.get();
      if (((res && res.busy) || 0) === 0) break;
      if (attempt < 6) {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50 * 2 ** (attempt - 1));
      }
    }
  } finally {
    sqlite.close();
  }
} catch {}
`;

/**
 * Compiled-binary equivalent of CHECKPOINT_CHILD_SCRIPT. The CLI runs this when
 * launched with `UNERR_WAL_CHECKPOINT=<db>` set (see checkpointWalDetached),
 * then exits. Runs in its OWN process, so it carries the same lock-safety
 * property as the `node -e` child. Synchronous + best-effort; any failure just
 * leaves the WAL for the next boot/shutdown checkpoint.
 */
export function runDetachedWalCheckpoint(dbPath: string): void {
  try {
    const { DatabaseSync } = loadNodeSqlite();
    const sqlite = new DatabaseSync(dbPath);
    try {
      sqlite.exec("PRAGMA busy_timeout=2000");
      const stmt = sqlite.prepare("PRAGMA wal_checkpoint(TRUNCATE)");
      for (let attempt = 1; attempt <= 6; attempt++) {
        const res = stmt.get() as { busy?: number } | undefined;
        if ((res?.busy || 0) === 0) break;
        if (attempt < 6) {
          Atomics.wait(
            new Int32Array(new SharedArrayBuffer(4)),
            0,
            0,
            50 * 2 ** (attempt - 1)
          );
        }
      }
    } finally {
      sqlite.close();
    }
  } catch {
    /* best-effort */
  }
}

/**
 * Fold + truncate the WAL from a SEPARATE process, safe to call while cozo
 * has dbPath open in this one.
 *
 * Why a child process: an in-process `node:sqlite` connection on a db cozo
 * also holds is the sqlite.org/howtocorrupt.html §2.3 hazard — its `close()`
 * cancels cozo's POSIX advisory locks (two separately-linked SQLite copies
 * don't share an in-process lock table), which let a truncating checkpoint
 * run under live cozo readers and crashed the proxy with SIGBUS/SIGABRT. A
 * separate process is SQLite's standard multi-process WAL scenario: its locks
 * are its own, and the checkpoint coordinates with cozo's readers through the
 * -shm read marks (returns busy instead of truncating pinned frames).
 *
 * Fire-and-forget: detached, stdio ignored, unref'd — never delays a graph
 * swap or holds the event loop. Failure to spawn is logged and swallowed;
 * the boot/shutdown in-process checkpoints remain the backstop.
 */
export function checkpointWalDetached(dbPath: string): void {
  try {
    // A compiled binary has no `node` to run `-e <script>`; re-exec the binary
    // with an env flag the CLI intercepts early (runDetachedWalCheckpoint) and
    // exits. Either way this is a SEPARATE process — the lock-safety property
    // the comment above depends on holds.
    const child = isCompiledBinary()
      ? spawn(process.execPath, [], {
          detached: true,
          stdio: "ignore",
          env: { ...process.env, UNERR_WAL_CHECKPOINT: dbPath },
        })
      : spawn(process.execPath, ["-e", CHECKPOINT_CHILD_SCRIPT, dbPath], {
          detached: true,
          stdio: "ignore",
        });
    child.unref();
  } catch (err) {
    process.stderr.write(
      `[unerr] WARN: could not spawn detached WAL checkpoint for ${dbPath} (${err instanceof Error ? err.message : String(err)}); WAL left for the next checkpoint\n`
    );
  }
}
