/**
 * CozoDB Bulk Ingestion — batch inserts entities + edges into the graph store.
 *
 * Designed for initial indexing and full re-index scenarios.
 * Uses CozoDB's `:put` (upsert) to handle re-indexing gracefully.
 * Batch size is configurable to respect memory limits.
 *
 * File-as-L0: Every file gets a `file:<path>` entity (kind="module") and every
 * entity gets a `contains` edge from its parent file entity. This guarantees
 * zero orphans in the graph — every entity is reachable via its file node.
 */

import { basename } from "node:path";
import { createModuleLogger } from "../../utils/logger.js";
import type { CozoDb } from "../cozo-schema.js";
import type { IndexedEdge, IndexedEntity } from "./plugin-interface.js";
import { isTestFile } from "./test-detector.js";

const log = createModuleLogger("ingest");

const ENTITY_BATCH_SIZE = 500;
const EDGE_BATCH_SIZE = 1000;

export interface IngestResult {
  entitiesIngested: number;
  edgesIngested: number;
  durationMs: number;
}

/**
 * Collect unique file paths and create file-level entities.
 * Each file gets a `file:<path>` entity with kind="module".
 */
function ingestFileEntities(db: CozoDb, entities: IndexedEntity[]): number {
  const filePaths = new Set<string>();
  for (const e of entities) {
    if (e.file_path) filePaths.add(e.file_path);
  }

  if (filePaths.size === 0) return 0;

  const rows = Array.from(filePaths, (fp) => [
    `file:${fp}`,
    "module",
    basename(fp),
    fp,
    0,
    "",
    "",
    0,
    0,
    "normal",
    -1,
  ]);

  let ingested = 0;
  for (let i = 0; i < rows.length; i += ENTITY_BATCH_SIZE) {
    const batch = rows.slice(i, i + ENTITY_BATCH_SIZE);
    try {
      db.run(
        `?[key, kind, name, file_path, start_line, signature, body, fan_in, fan_out, risk_level, community] <- $rows
         :put entities { key => kind, name, file_path, start_line, signature, body, fan_in, fan_out, risk_level, community }`,
        { rows: batch },
      );
      ingested += batch.length;
    } catch (err) {
      log.warn(
        `File entity batch failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  return ingested;
}

/**
 * Create `contains` edges from file entities to their child entities.
 * This guarantees every entity is reachable via its parent file node.
 */
function ingestContainsEdges(db: CozoDb, entities: IndexedEntity[]): number {
  const rows = entities
    .filter((e) => e.file_path)
    .map((e) => [`file:${e.file_path}`, e.key, "contains"]);

  let ingested = 0;
  for (let i = 0; i < rows.length; i += EDGE_BATCH_SIZE) {
    const batch = rows.slice(i, i + EDGE_BATCH_SIZE);
    try {
      db.run(
        `?[from_key, to_key, type] <- $rows
         :put edges { from_key, to_key, type }`,
        { rows: batch },
      );
      ingested += batch.length;
    } catch (err) {
      log.warn(
        `Contains edge batch failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  return ingested;
}

/**
 * Bulk ingest entities into CozoDB.
 * Also populates file_index for fast file→entity lookups.
 */
function ingestEntities(db: CozoDb, entities: IndexedEntity[]): number {
  let ingested = 0;

  for (let i = 0; i < entities.length; i += ENTITY_BATCH_SIZE) {
    const batch = entities.slice(i, i + ENTITY_BATCH_SIZE);
    const rows = batch.map((e) => [
      e.key,
      e.kind,
      e.name,
      e.file_path,
      e.start_line,
      e.signature,
      e.body_hash,
      0,
      0,
      "normal",
      -1,
      e.is_test ?? isTestFile(e.file_path),
    ]);

    try {
      db.run(
        `?[key, kind, name, file_path, start_line, signature, body, fan_in, fan_out, risk_level, community, is_test] <- $rows
         :put entities { key => kind, name, file_path, start_line, signature, body, fan_in, fan_out, risk_level, community, is_test }`,
        { rows },
      );

      const fileIndexRows = batch.map((e) => [e.file_path, e.key]);
      db.run(
        `?[file_path, entity_key] <- $rows
         :put file_index { file_path, entity_key }`,
        { rows: fileIndexRows },
      );

      ingested += batch.length;
    } catch (err) {
      log.warn(
        `Entity batch ingest failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  return ingested;
}

/**
 * Bulk ingest edges into CozoDB.
 */
function ingestEdges(db: CozoDb, edges: IndexedEdge[]): number {
  let ingested = 0;

  const validEdges = edges.filter((e) => !e.to_key.startsWith("unresolved:"));

  for (let i = 0; i < validEdges.length; i += EDGE_BATCH_SIZE) {
    const batch = validEdges.slice(i, i + EDGE_BATCH_SIZE);
    const rows = batch.map((e) => [e.from_key, e.to_key, e.type]);

    try {
      db.run(
        `?[from_key, to_key, type] <- $rows
         :put edges { from_key, to_key, type }`,
        { rows },
      );
      ingested += batch.length;
    } catch (err) {
      log.warn(
        `Edge batch ingest failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  return ingested;
}

export interface IngestStats {
  fileEntities: number;
  containsEdges: number;
}

/**
 * Ingest a full index result into CozoDB.
 *
 * Order: file entities → code entities → contains edges → code edges.
 * File entities must exist before contains edges reference them.
 */
export function ingestIndexResult(
  db: CozoDb,
  entities: IndexedEntity[],
  edges: IndexedEdge[],
): IngestResult & IngestStats {
  const start = performance.now();

  // R.1: Create file-level entities (file:<path> with kind="module")
  const fileEntities = ingestFileEntities(db, entities);

  // Ingest code-level entities
  const entitiesIngested = ingestEntities(db, entities);

  // R.2: Create contains edges (file → entity)
  const containsEdges = ingestContainsEdges(db, entities);

  // Ingest code-level edges (calls, imports, extends, etc.)
  const edgesIngested = ingestEdges(db, edges);

  const durationMs = performance.now() - start;
  log.info(
    `Ingested ${fileEntities} files + ${entitiesIngested} entities + ${containsEdges + edgesIngested} edges in ${Math.round(durationMs)}ms`,
  );

  return {
    entitiesIngested,
    edgesIngested,
    fileEntities,
    containsEdges,
    durationMs,
  };
}
