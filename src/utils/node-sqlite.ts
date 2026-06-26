import { createRequire } from "node:module";

/**
 * Load Node's built-in `node:sqlite` (DatabaseSync) in a way that survives
 * bundling.
 *
 * `node:sqlite` shipped in Node 22 and is NOT in esbuild's hardcoded list of
 * recognized Node builtins. So a dynamic `await import("node:sqlite")` is
 * rewritten by tsup/esbuild to a bare `import("sqlite")` — its `node:` prefix
 * stripped — which throws `Cannot find package 'sqlite'` at runtime. That
 * silently disabled every WAL checkpoint (`enableWalMode` / `checkpointWal`)
 * and let `graph.db-wal` grow without bound (observed 177MB).
 *
 * A `createRequire(...)(...)` call is opaque to the bundler: it never sees the
 * `"node:sqlite"` string as an import specifier, so the value passes through
 * verbatim and resolves to the real builtin at runtime. Every `node:sqlite`
 * load MUST go through here — never `import("node:sqlite")` directly.
 *
 * @sem domain=infrastructure role=loader
 */
export function loadNodeSqlite(): typeof import("node:sqlite") {
  const req = createRequire(import.meta.url);
  return req("node:sqlite") as typeof import("node:sqlite");
}
