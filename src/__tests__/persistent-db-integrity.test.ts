/**
 * Boot integrity gate: corrupt graph.db is detected via PRAGMA quick_check
 * and rebuilt clean instead of looping failed inserts (SQLITE_CORRUPT error-11).
 *
 * Two cases:
 *   (a) corrupt file → wasRebuilt=true, fresh empty DB after open
 *   (b) healthy file → wasRebuilt=false, existing data preserved
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openPersistentDb } from "../intelligence/persistent-db.js";

describe("persistent-db integrity gate", () => {
  let projectRoot: string;

  beforeEach(() => {
    projectRoot = mkdtempSync(join(tmpdir(), "unerr-integrity-"));
  });

  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true });
  });

  it("wasRebuilt=true on corrupt graph.db and db is recreated healthy", async () => {
    // Plant a corrupt file — random bytes, not a valid SQLite header.
    const unerrDir = join(projectRoot, ".unerr");
    mkdirSync(unerrDir, { recursive: true });
    const dbPath = join(unerrDir, "graph.db");
    writeFileSync(
      dbPath,
      Buffer.from("this is definitely not a valid sqlite database file!!")
    );

    const { db, isNew, wasRebuilt } = await openPersistentDb(projectRoot);
    db.close?.();

    // isNew reflects the original file existence (the file was there).
    expect(isNew).toBe(false);
    // Integrity gate must have detected corruption and rebuilt.
    expect(wasRebuilt).toBe(true);

    // The recreated db must itself pass a quick_check (i.e. is a valid SQLite db).
    const probe = new DatabaseSync(dbPath);
    try {
      const row = probe.prepare("PRAGMA quick_check").get() as
        | Record<string, unknown>
        | undefined;
      const result = row ? Object.values(row)[0] : null;
      expect(String(result ?? "").toLowerCase()).toBe("ok");
    } finally {
      probe.close();
    }
  });

  it("wasRebuilt=false on healthy graph.db and existing data is preserved", async () => {
    // First open: creates a valid graph.db.
    const { db: firstDb, dbPath } = await openPersistentDb(projectRoot);
    firstDb.close?.();

    // Write a marker table via node:sqlite so we can verify data survived.
    const seeder = new DatabaseSync(dbPath);
    try {
      seeder.exec(
        "CREATE TABLE IF NOT EXISTS _integrity_test (id INTEGER PRIMARY KEY, val TEXT)"
      );
      seeder.exec("INSERT INTO _integrity_test (val) VALUES ('preserved')");
    } finally {
      seeder.close();
    }

    // Second open on the same healthy db.
    const { db: secondDb, wasRebuilt } = await openPersistentDb(projectRoot);
    secondDb.close?.();

    // Must NOT rebuild a healthy db.
    expect(wasRebuilt).toBe(false);

    // Marker data must survive.
    const probe = new DatabaseSync(dbPath);
    try {
      const row = probe
        .prepare("SELECT val FROM _integrity_test WHERE id=1")
        .get() as { val?: string } | undefined;
      expect(row?.val).toBe("preserved");
    } finally {
      probe.close();
    }
  });
});
