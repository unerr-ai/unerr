/**
 * Standalone review context loading (docs/reviewer-architecture.md §5.2, §5.3).
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
import { gunzipSync } from "node:zlib";
import type { CozoGraphStore } from "../intelligence/local-graph.js";
import { reviewNotesFromStore } from "./git-review.js";
import type { ReviewNotes } from "./types.js";

/**
 * Load the CozoDB graph for a standalone review (proxy may not be running).
 * Reads `repoId` from `.unerr/config.json`, then loads the snapshot. Returns
 * `null` (review degrades to file-level checkers only) when config, manifest,
 * or snapshot is absent / unreadable.
 */
export async function loadStandaloneGraph(
  cwd: string
): Promise<CozoGraphStore | null> {
  const configPath = join(cwd, ".unerr", "config.json");
  if (!existsSync(configPath)) return null;

  let repoId: string;
  try {
    const config = JSON.parse(readFileSync(configPath, "utf-8")) as {
      repoId?: string;
    };
    if (!config.repoId) return null;
    repoId = config.repoId;
  } catch {
    return null;
  }

  const snapshotsDir = join(cwd, ".unerr", "snapshots");
  const manifestsDir = join(cwd, ".unerr", "manifests");
  const manifestPath = join(manifestsDir, `${repoId}.json`);
  if (!existsSync(manifestPath)) return null;

  let snapshotPath = join(snapshotsDir, `${repoId}.msgpack.gz`);
  if (!existsSync(snapshotPath)) {
    snapshotPath = join(snapshotsDir, `${repoId}.msgpack`);
  }
  if (!existsSync(snapshotPath)) return null;

  try {
    const { default: CozoDbConstructor } = await import("cozo-node");
    const { CozoGraphStore } = await import("../intelligence/local-graph.js");
    const { unpack } = await import("msgpackr");

    // cozo-node ctor + msgpack envelope are untyped (mirrors check-commit's loader).
    const db = new (CozoDbConstructor as any)();
    const graph = await CozoGraphStore.create(db);

    const raw = readFileSync(snapshotPath);
    const buffer = snapshotPath.endsWith(".gz") ? gunzipSync(raw) : raw;
    const envelope = unpack(buffer) as any;
    await graph.loadSnapshot(envelope);

    return graph;
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
