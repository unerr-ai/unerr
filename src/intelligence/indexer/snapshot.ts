/**
 * Index Snapshot — save/load the full index state as msgpack for cold start.
 *
 * When the proxy restarts, instead of re-indexing the entire project,
 * it loads the snapshot and only incrementally indexes changed files.
 *
 * Snapshot format: { entities, edges, metadata, version }
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createModuleLogger } from "../../utils/logger.js";
import type { IndexMetadata } from "./metadata.js";
import type {
  ImportInfo,
  IndexedEdge,
  IndexedEntity,
} from "./plugin-interface.js";

const log = createModuleLogger("index-snapshot");

const SNAPSHOT_VERSION = 1;

export interface IndexSnapshot {
  version: number;
  entities: IndexedEntity[];
  edges: IndexedEdge[];
  metadata: IndexMetadata;
  savedAt: string;
}

/**
 * Save index state as a snapshot.
 */
export function saveSnapshot(
  unerrDir: string,
  entities: IndexedEntity[],
  edges: IndexedEdge[],
  metadata: IndexMetadata
): void {
  const indexDir = join(unerrDir, "index");
  if (!existsSync(indexDir)) {
    mkdirSync(indexDir, { recursive: true });
  }

  const snapshot: IndexSnapshot = {
    version: SNAPSHOT_VERSION,
    entities,
    edges,
    metadata,
    savedAt: new Date().toISOString(),
  };

  const snapshotPath = join(indexDir, "snapshot.json");

  try {
    writeFileSync(snapshotPath, JSON.stringify(snapshot), "utf-8");
    log.info(
      `Snapshot saved: ${entities.length} entities, ${edges.length} edges`
    );
  } catch (err) {
    log.warn(
      `Failed to save snapshot: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

/**
 * Load index snapshot from disk.
 * Returns null if no valid snapshot exists.
 */
export function loadSnapshot(unerrDir: string): IndexSnapshot | null {
  const snapshotPath = join(unerrDir, "index", "snapshot.json");

  if (!existsSync(snapshotPath)) return null;

  try {
    const raw = readFileSync(snapshotPath, "utf-8");
    const parsed = JSON.parse(raw) as IndexSnapshot;

    if (parsed.version !== SNAPSHOT_VERSION) {
      log.info("Snapshot version mismatch — full re-index needed");
      return null;
    }

    log.info(
      `Snapshot loaded: ${parsed.entities.length} entities, ${parsed.edges.length} edges (saved ${parsed.savedAt})`
    );

    return parsed;
  } catch (err) {
    log.warn(
      `Failed to load snapshot: ${err instanceof Error ? err.message : String(err)}`
    );
    return null;
  }
}

/**
 * Check if a valid snapshot exists.
 */
export function hasSnapshot(unerrDir: string): boolean {
  return existsSync(join(unerrDir, "index", "snapshot.json"));
}
