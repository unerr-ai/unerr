/**
 * Regression: graph.db must open in WAL journal mode.
 *
 * The default DELETE journal mode takes an EXCLUSIVE writer lock that blocks
 * every reader. Because cozo's SQLite backend is a connection pool (reads and
 * writes use separate connections), a long drift/orphan write under DELETE mode
 * starved warm MCP reads until they timed out. WAL lets the single writer and
 * many readers proceed concurrently (sqlite.org/wal.html). `enableWalMode`
 * (persistent-db.ts) sets it out-of-band before cozo opens the file; this test
 * locks that behaviour in.
 */

import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  checkpointWal,
  checkpointWalDetached,
  openPersistentDb,
} from "../intelligence/persistent-db.js";

describe("persistent-db WAL journal mode", () => {
  let projectRoot: string;

  beforeEach(() => {
    projectRoot = mkdtempSync(join(tmpdir(), "unerr-wal-"));
  });

  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true });
  });

  it("opens graph.db in WAL journal mode", async () => {
    const { db, dbPath } = await openPersistentDb(projectRoot);
    db.close?.();

    // Read the persisted journal_mode back through an independent connection.
    const probe = new Database(dbPath);
    try {
      const mode = probe.pragma("journal_mode", { simple: true });
      expect(String(mode).toLowerCase()).toBe("wal");
    } finally {
      probe.close();
    }
  });

  it("checkpointWal folds and truncates a populated -wal file to zero bytes", async () => {
    const dbPath = join(projectRoot, "wal-probe.db");
    // A second connection stays open with autocheckpoint disabled so the
    // inserts accumulate in the -wal sidecar instead of folding on commit —
    // this reproduces the un-checkpointed WAL we see under the live proxy.
    const writer = new Database(dbPath);
    try {
      writer.pragma("journal_mode = WAL");
      writer.pragma("wal_autocheckpoint = 0");
      writer.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, blob TEXT)");
      const insert = writer.prepare("INSERT INTO t (blob) VALUES (?)");
      const payload = "x".repeat(4096);
      for (let i = 0; i < 500; i++) insert.run(payload);

      const walPath = `${dbPath}-wal`;
      expect(statSync(walPath).size).toBeGreaterThan(0);

      // Idle writer (no open read txn) → TRUNCATE can fully reset the WAL file.
      await checkpointWal(dbPath);

      expect(statSync(walPath).size).toBe(0);
      // Data survived the fold into the main db.
      expect(
        (writer.prepare("SELECT count(*) AS n FROM t").get() as { n: number }).n
      ).toBe(500);
    } finally {
      writer.close();
    }
  });

  it("checkpointWal is a no-op (never throws) on a db with no WAL", async () => {
    const dbPath = join(projectRoot, "no-wal.db");
    const seed = new Database(dbPath);
    seed.exec("CREATE TABLE t (id INTEGER PRIMARY KEY)");
    seed.close();
    await expect(checkpointWal(dbPath)).resolves.toBeUndefined();
  });

  // Regression: the LIVE-session checkpoint must run in a separate PROCESS.
  // An in-process better-sqlite3 checkpoint on a db cozo also holds is the
  // sqlite.org/howtocorrupt.html §2.3 hazard — its close() cancels cozo's
  // POSIX advisory locks (two separately-linked SQLite copies don't share an
  // in-process lock table), letting WAL truncation run under live readers.
  // Observed as SIGBUS in sqlite3WalFindFrame / SIGABRT (rayon panic) killing
  // the proxy mid-session. checkpointWalDetached spawns a child instead —
  // SQLite's standard multi-process WAL scenario.
  it("checkpointWalDetached truncates the -wal from a child process", async () => {
    const dbPath = join(projectRoot, "wal-detached.db");
    const writer = new Database(dbPath);
    try {
      writer.pragma("journal_mode = WAL");
      writer.pragma("wal_autocheckpoint = 0");
      writer.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, blob TEXT)");
      const insert = writer.prepare("INSERT INTO t (blob) VALUES (?)");
      const payload = "x".repeat(4096);
      for (let i = 0; i < 500; i++) insert.run(payload);

      const walPath = `${dbPath}-wal`;
      expect(statSync(walPath).size).toBeGreaterThan(0);

      checkpointWalDetached(dbPath);

      // Fire-and-forget child — poll for the truncate (child startup is the
      // dominant cost; well under the deadline in practice).
      const deadline = Date.now() + 15_000;
      while (Date.now() < deadline && statSync(walPath).size > 0) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      expect(statSync(walPath).size).toBe(0);
      expect(
        (writer.prepare("SELECT count(*) AS n FROM t").get() as { n: number }).n
      ).toBe(500);
    } finally {
      writer.close();
    }
  });

  it("checkpointWalDetached never throws on a missing db file", () => {
    expect(() =>
      checkpointWalDetached(join(projectRoot, "does-not-exist.db"))
    ).not.toThrow();
  });
});
