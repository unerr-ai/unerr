#!/usr/bin/env node
/**
 * Fails fast if the native database bindings did not get built/installed.
 *
 * Both core databases load a compiled `.node` binary through a dependency
 * INSTALL script: cozo-node via @mapbox/node-pre-gyp (downloads a prebuilt
 * tarball from GitHub releases), better-sqlite3 via prebuild-install (downloads
 * a prebuild, falling back to node-gyp). pnpm v10 blocks those install scripts
 * unless the package is in `pnpm.onlyBuiltDependencies` (and npm v12 will do the
 * same by default). When the script is skipped, the binary never lands and the
 * FIRST thing to open a DB throws "Could not locate the bindings file" — which,
 * in the test suite, surfaces as noise across ~170 files instead of one clear
 * cause. This script turns that into a single, loud, early failure.
 *
 * Run in CI right after `pnpm install`, before lint/typecheck/test. Mirrors how
 * the code actually opens each DB (see persistent-db.ts and metrics-store.ts).
 */

const failures = [];

// better-sqlite3 — exactly how metrics-store.ts opens it: `new Database(path)`.
try {
  const { default: Database } = await import("better-sqlite3");
  const db = new Database(":memory:");
  db.pragma("journal_mode = WAL");
  db.exec("CREATE TABLE t (x INTEGER)");
  db.prepare("INSERT INTO t (x) VALUES (?)").run(1);
  const row = db.prepare("SELECT x FROM t").get();
  if (!row || row.x !== 1)
    throw new Error("better-sqlite3 query returned wrong result");
  db.close();
  console.log("ok: better-sqlite3 native binding loaded");
} catch (err) {
  failures.push(["better-sqlite3", err]);
}

// cozo-node — same dynamic-import + constructor shape as persistent-db.ts,
// using the in-memory engine so no file is touched.
try {
  const cozoModule = await import("cozo-node");
  const CozoDb = cozoModule.default?.CozoDb ?? cozoModule.CozoDb;
  if (!CozoDb) throw new Error("cozo-node module did not export CozoDb");
  const db = new CozoDb("mem");
  const res = await db.run("?[a] := a = 1");
  if (!res?.rows?.length) throw new Error("cozo-node query returned no rows");
  await db.close?.();
  console.log("ok: cozo-node native binding loaded");
} catch (err) {
  failures.push(["cozo-node", err]);
}

if (failures.length > 0) {
  console.error("\n✗ Native database bindings failed to load:\n");
  for (const [name, err] of failures) {
    console.error(
      `  - ${name}: ${err instanceof Error ? err.message : String(err)}`
    );
  }
  console.error(
    "\nThe compiled .node binary is missing. This happens when the dependency's\n" +
      "install script was skipped (pnpm v10 / npm v12 block them by default).\n" +
      "Fix: ensure these are listed in package.json `pnpm.onlyBuiltDependencies`,\n" +
      "then run `pnpm rebuild better-sqlite3 cozo-node` (or reinstall).\n"
  );
  process.exit(1);
}

console.log("\n✓ All native database bindings loaded.");
