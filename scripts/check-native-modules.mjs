#!/usr/bin/env node
/**
 * Fails fast if the SQLite/graph backends are not usable.
 *
 * Two SQLite-backed paths must work:
 *   - `node:sqlite` (built-in, stable since Node 24) — the ONLY SQLite driver
 *     now that `better-sqlite3` was removed. It needs no native install, but it
 *     IS gated on the Node version: on Node < 24 the import throws. Probing it
 *     here turns "wrong Node version" into one loud failure instead of noise
 *     across ~170 test files (see persistent-db.ts / cursor-sqlite.ts).
 *   - `cozo-node` — loads a compiled `.node` binary via @mapbox/node-pre-gyp's
 *     INSTALL script (downloads a prebuilt tarball). pnpm v10 blocks that script
 *     unless cozo-node is in `pnpm.onlyBuiltDependencies` (npm v12 will too).
 *     When skipped, the binary never lands and the first DB open throws
 *     "Could not locate the bindings file".
 *
 * Run in CI right after `pnpm install`, before lint/typecheck/test.
 */

const failures = [];

// node:sqlite — exactly how persistent-db.ts / cursor-sqlite.ts open it:
// `new DatabaseSync(path)`. Built in on Node >= 24; import throws below that.
try {
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA journal_mode=WAL");
  db.exec("CREATE TABLE t (x INTEGER)");
  db.prepare("INSERT INTO t (x) VALUES (?)").run(1);
  const row = db.prepare("SELECT x FROM t").get();
  if (!row || row.x !== 1)
    throw new Error("node:sqlite query returned wrong result");
  db.close();
  console.log(`ok: node:sqlite available (Node ${process.versions.node})`);
} catch (err) {
  failures.push(["node:sqlite", err]);
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
  console.error("\n✗ SQLite/graph backends failed to load:\n");
  for (const [name, err] of failures) {
    console.error(
      `  - ${name}: ${err instanceof Error ? err.message : String(err)}`
    );
  }
  console.error(
    "\nnode:sqlite failing usually means Node < 24 (it is built in from Node 24;\n" +
      "engines.node is >=24.0.0). cozo-node failing means its compiled .node\n" +
      "binary is missing — the dependency's install script was skipped (pnpm v10\n" +
      "/ npm v12 block them by default). Fix: use Node >= 24, ensure cozo-node is\n" +
      "in package.json `pnpm.onlyBuiltDependencies`, then `pnpm rebuild cozo-node`.\n"
  );
  process.exit(1);
}

console.log("\n✓ node:sqlite + cozo-node both load.");
