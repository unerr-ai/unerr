/**
 * Graph Patch Operations — surgical updates to the CozoDB graph.
 *
 * Instead of full re-ingestion, patches apply targeted:
 *   - Delete entity + all edges to/from it
 *   - Update entity in place (body_hash changed)
 *   - Insert new entities + edges
 *
 * This is the write-side of incremental indexing.
 */

import { createModuleLogger } from "../../utils/logger.js";
import type { CozoDb } from "../cozo-schema.js";
import type { EntityDiff } from "./incremental.js";
import type { IndexedEdge, IndexedEntity } from "./plugin-interface.js";

const log = createModuleLogger("graph-patch");

export interface PatchResult {
  entitiesDeleted: number;
  entitiesUpdated: number;
  entitiesAdded: number;
  edgesDeleted: number;
  edgesAdded: number;
  durationMs: number;
}

/**
 * Delete an entity and all its edges from the graph.
 */
async function deleteEntity(db: CozoDb, entityKey: string): Promise<void> {
  try {
    await db.run("?[key] <- [[$key]] :rm entities { key }", { key: entityKey });
  } catch {
    /* entity may not exist — safe to ignore */
  }

  try {
    await db.run(
      `?[from_key, to_key, type] := *edges{ from_key, to_key, type }, from_key = $key
       :rm edges { from_key, to_key, type }`,
      { key: entityKey },
    );
  } catch {
    /* no outgoing edges — safe */
  }

  try {
    await db.run(
      `?[from_key, to_key, type] := *edges{ from_key, to_key, type }, to_key = $key
       :rm edges { from_key, to_key, type }`,
      { key: entityKey },
    );
  } catch {
    /* no incoming edges — safe */
  }

  try {
    await db.run(
      `?[file_path, entity_key] := *file_index{ file_path, entity_key }, entity_key = $key
       :rm file_index { file_path, entity_key }`,
      { key: entityKey },
    );
  } catch {
    /* not in file_index — safe */
  }
}

/**
 * Upsert an entity into the graph.
 */
async function upsertEntity(db: CozoDb, entity: IndexedEntity): Promise<void> {
  try {
    await db.run(
      `?[key, kind, name, file_path, start_line, end_line, signature, body, fan_in, fan_out, risk_level, community] <-
         [[$key, $kind, $name, $fp, $sl, $el, $sig, $body, 0, 0, "normal", -1]]
       :put entities { key => kind, name, file_path, start_line, end_line, signature, body, fan_in, fan_out, risk_level, community }`,
      {
        key: entity.key,
        kind: entity.kind,
        name: entity.name,
        fp: entity.file_path,
        sl: entity.start_line,
        sig: entity.signature,
        el: entity.end_line,
        body: entity.body_hash,
      },
    );
    await db.run(
      `?[file_path, entity_key] <- [[$fp, $ek]]
       :put file_index { file_path, entity_key }`,
      { fp: entity.file_path, ek: entity.key },
    );
  } catch (err) {
    log.debug(
      `Upsert entity failed for ${entity.key}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * Insert edges into the graph (skipping unresolved).
 */
async function insertEdges(db: CozoDb, edges: IndexedEdge[]): Promise<number> {
  const valid = edges.filter((e) => !e.to_key.startsWith("unresolved:"));
  if (valid.length === 0) return 0;

  let count = 0;
  for (const edge of valid) {
    try {
      await db.run(
        `?[from_key, to_key, type] <- [[$fk, $tk, $type]]
         :put edges { from_key, to_key, type }`,
        { fk: edge.from_key, tk: edge.to_key, type: edge.type },
      );
      count++;
    } catch {
      /* edge may conflict — safe to skip */
    }
  }
  return count;
}

/**
 * Apply an entity diff as graph patches.
 */
export async function applyGraphPatch(
  db: CozoDb,
  diff: EntityDiff,
  newEdges: IndexedEdge[],
  oldEdgeKeys?: Set<string>,
): Promise<PatchResult> {
  const start = performance.now();

  for (const entity of diff.deleted) {
    await deleteEntity(db, entity.key);
  }

  for (const entity of diff.updated) {
    await deleteEntity(db, entity.key);
    await upsertEntity(db, entity);
  }

  for (const entity of diff.added) {
    await upsertEntity(db, entity);
  }

  if (oldEdgeKeys) {
    for (const edgeKey of oldEdgeKeys) {
      const [fromKey, toKey, type] = edgeKey.split("::");
      if (fromKey && toKey && type) {
        try {
          await db.run(
            `?[from_key, to_key, type] <- [[$fk, $tk, $type]]
             :rm edges { from_key, to_key, type }`,
            { fk: fromKey, tk: toKey, type },
          );
        } catch {
          /* safe */
        }
      }
    }
  }

  const edgesAdded = await insertEdges(db, newEdges);

  const durationMs = performance.now() - start;

  log.debug(
    `Patch: +${diff.added.length} ~${diff.updated.length} -${diff.deleted.length} entities, +${edgesAdded} edges (${Math.round(durationMs)}ms)`,
  );

  return {
    entitiesDeleted: diff.deleted.length,
    entitiesUpdated: diff.updated.length,
    entitiesAdded: diff.added.length,
    edgesDeleted: oldEdgeKeys?.size ?? 0,
    edgesAdded,
    durationMs,
  };
}

/**
 * Delete all entities and edges for a specific file.
 */
export async function deleteFileFromGraph(
  db: CozoDb,
  filePath: string,
): Promise<number> {
  let deleted = 0;

  try {
    const result = await db.run(
      "?[entity_key] := *file_index{ file_path: $fp, entity_key }",
      { fp: filePath },
    );
    const keys = result.rows.map((r: unknown[]) => r[0] as string);

    for (const key of keys) {
      await deleteEntity(db, key);
      deleted++;
    }
  } catch {
    /* file not in index — safe */
  }

  return deleted;
}
