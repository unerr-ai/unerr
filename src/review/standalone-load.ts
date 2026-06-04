/**
 * Standalone review context loading (.internal/reviewer-architecture.md §5.2, §5.3).
 *
 * The commit gate (`check-commit`) and the on-demand command (`unerr review`)
 * both run in short-lived CLI processes with no warm proxy attached, so they
 * must load the CozoDB graph + anchored-notes store themselves. This is the
 * single place that does it, so both surfaces degrade identically:
 *   - no `.unerr/config.json` repoId, or no snapshot → graph `null`
 *     (entity-bound checkers stay silent; file-level checkers still run)
 *   - no `.unerr/facts.db` → notes `null` (memory-drift stays silent; never
 *     creates facts.db just to read)
 *
 * Never throws — a missing or corrupt store yields `null`, per the §9
 * false-positive discipline (a missing store produces silence, not a guess).
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { CozoGraphStore } from "../intelligence/local-graph.js";
import { loadLocalSnapshot } from "../intelligence/local-snapshot.js";
import { reviewNotesFromStore } from "./git-review.js";
import type { ReviewNotes } from "./types.js";

/**
 * Load the CozoDB graph for a standalone review (proxy may not be running).
 * Confirms the repo is unerr-indexed via `.unerr/config.json`'s `repoId`, then
 * loads the canonical on-disk snapshot. Returns `null` (review degrades to
 * file-level checkers only) when config, repoId, or snapshot is absent /
 * unreadable.
 *
 * The snapshot is the single fixed file the indexer/proxy write —
 * `.unerr/snapshots/graph.msgpack.gz` (see {@link snapshotPath}). It is NOT
 * repoId-named and there is no separate manifest; `repoId` lives inside the
 * envelope. We load it into a FRESH in-memory CozoDB rather than opening
 * `.unerr/graph.db`, which the running proxy holds under a single-writer
 * rocksdb lock.
 */
export async function loadStandaloneGraph(
  cwd: string
): Promise<CozoGraphStore | null> {
  const configPath = join(cwd, ".unerr", "config.json");
  if (!existsSync(configPath)) return null;

  try {
    const config = JSON.parse(readFileSync(configPath, "utf-8")) as {
      repoId?: string;
    };
    if (!config.repoId) return null;
  } catch {
    return null;
  }

  try {
    const cozoModule = await import("cozo-node");
    const { CozoGraphStore } = await import("../intelligence/local-graph.js");

    // cozo-node's CozoDb constructor lives under `.default.CozoDb` once esbuild
    // wraps the CJS module, but under raw ESM / vitest it's the named `.CozoDb`
    // export. Resolve both shapes — the bare `.default` destructure used to hand
    // back the `{ CozoDb }` namespace object, so `new` threw and got swallowed
    // (graph silently null). Same idiom as persistent-db.ts.
    const CozoDbConstructor = (
      cozoModule as { default?: { CozoDb: unknown }; CozoDb?: unknown }
    ).default
      ? (cozoModule as { default: { CozoDb: unknown } }).default.CozoDb
      : (cozoModule as { CozoDb: unknown }).CozoDb;

    const db = new (CozoDbConstructor as any)();
    const graph = await CozoGraphStore.create(db);

    const loaded = await loadLocalSnapshot(cwd, graph);
    return loaded ? graph : null;
  } catch {
    return null;
  }
}

/**
 * Open the anchored-notes store from `.unerr/facts.db` (the memory-drift
 * checker's evidence) when it already exists. Returns `null` (checker silent)
 * when facts.db is absent or unreadable — never creates facts.db to read it.
 */
export async function loadStandaloneNotes(
  cwd: string,
  sessionId = "review"
): Promise<ReviewNotes | null> {
  const factsDbPath = join(cwd, ".unerr", "facts.db");
  if (!existsSync(factsDbPath)) return null;
  try {
    const { TemporalFactStore } = await import(
      "../intelligence/temporal-facts.js"
    );
    const { NotesStore } = await import("../intelligence/notes-store.js");
    const factStore = await TemporalFactStore.create(cwd);
    return reviewNotesFromStore(new NotesStore(factStore.getDb()), sessionId);
  } catch {
    return null;
  }
}
