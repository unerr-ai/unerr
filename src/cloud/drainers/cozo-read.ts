/**
 * unerr cloud — a read-only second connection to a per-repo CozoDB store (C2).
 *
 * facts.db / timeline.db are open read-write by the per-repo proxy in another
 * process. A drainer opens a SECOND connection here to read rows for the
 * relational sync streams. Two safety steps keep that read from contending with
 * the proxy's writes:
 *
 *   1. WAL — `journal_mode = WAL` is set out-of-band via better-sqlite3 (the
 *      same approach as `persistent-db.ts:enableWalMode`, which is private so it
 *      is mirrored here) BEFORE cozo opens the file. WAL lets one writer and
 *      many readers proceed concurrently; the default DELETE mode would block
 *      this reader behind the proxy's EXCLUSIVE write lock. WAL is a persistent
 *      file property, so the proxy's pooled connections inherit it.
 *   2. Read-only intent — cozo-node's NodeJS artefact exposes no `immutable`
 *      run flag (its `run(script, params)` takes no third arg; the documented
 *      `immutable` option is the Rust/Python API only). The drainers issue
 *      query-only Datalog (`?[...] := ...`), never `:put`/`:rm`, so this
 *      connection never mutates the store. WAL is what makes the concurrent
 *      read safe.
 *
 * A read failure (locked/busy/missing) is surfaced by throwing from the
 * drainer's `read()`; `drainRepo` treats a read-throw as a retryable failure
 * and holds the cursor, which is correct.
 */

import type { CozoDb } from "../../intelligence/cozo-schema.js";

/** Put `dbPath` into WAL journal mode, mirroring persistent-db.ts (private). */
async function enableWal(dbPath: string): Promise<void> {
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
      `[unerr] WARN: could not set WAL on ${dbPath} (${
        err instanceof Error ? err.message : String(err)
      }); continuing in default journal mode\n`
    );
  }
}

/**
 * Open a second, read-only-intent CozoDB connection at `dbPath` (SQLite engine),
 * with WAL enabled first. The caller closes the handle via `db.close()`.
 *
 * // @sem domain=cloud role=drainer
 */
export async function openCozoRead(dbPath: string): Promise<CozoDb> {
  await enableWal(dbPath);

  const cozoModule = await import("cozo-node");
  const CozoDbConstructor = (
    cozoModule as { default?: { CozoDb: unknown }; CozoDb?: unknown }
  ).default
    ? (cozoModule as { default: { CozoDb: unknown } }).default.CozoDb
    : (cozoModule as { CozoDb: unknown }).CozoDb;

  return new (
    CozoDbConstructor as new (
      engine: string,
      path: string
    ) => CozoDb
  )("sqlite", dbPath);
}
