/**
 * Incremental Indexing — entity diff + cascade invalidation.
 *
 * K.1: Compares old vs new entities for a file. Produces added/updated/deleted sets.
 *       Uses body_hash for efficient change detection (no content comparison needed).
 *
 * K.2: When an entity changes, identifies all edges that reference it
 *       (both incoming and outgoing) for invalidation and re-resolution.
 */

import type {
  ImportInfo,
  IndexedEdge,
  IndexedEntity,
} from "./plugin-interface.js";

export interface EntityDiff {
  added: IndexedEntity[];
  updated: IndexedEntity[];
  deleted: IndexedEntity[];
  unchanged: IndexedEntity[];
}

export interface CascadeResult {
  invalidatedEdges: IndexedEdge[];
  affectedFiles: Set<string>;
  affectedEntityKeys: Set<string>;
}

/**
 * Diff old vs new entities for a single file.
 * Matches by key (deterministic). Detects changes via body_hash.
 */
export function diffEntities(
  oldEntities: IndexedEntity[],
  newEntities: IndexedEntity[]
): EntityDiff {
  const oldMap = new Map(oldEntities.map((e) => [e.key, e]));
  const newMap = new Map(newEntities.map((e) => [e.key, e]));

  const added: IndexedEntity[] = [];
  const updated: IndexedEntity[] = [];
  const unchanged: IndexedEntity[] = [];
  const deleted: IndexedEntity[] = [];

  for (const [key, newEntity] of newMap) {
    const oldEntity = oldMap.get(key);
    if (!oldEntity) {
      added.push(newEntity);
    } else if (oldEntity.body_hash !== newEntity.body_hash) {
      updated.push(newEntity);
    } else {
      unchanged.push(newEntity);
    }
  }

  for (const [key, oldEntity] of oldMap) {
    if (!newMap.has(key)) {
      deleted.push(oldEntity);
    }
  }

  return { added, updated, deleted, unchanged };
}

/**
 * Determine which edges are invalidated by entity changes.
 * An edge is invalidated if either its from_key or to_key was added, updated, or deleted.
 */
export function cascadeInvalidation(
  diff: EntityDiff,
  allEdges: IndexedEdge[]
): CascadeResult {
  const changedKeys = new Set<string>();
  for (const e of diff.added) changedKeys.add(e.key);
  for (const e of diff.updated) changedKeys.add(e.key);
  for (const e of diff.deleted) changedKeys.add(e.key);

  const invalidatedEdges: IndexedEdge[] = [];
  const affectedFiles = new Set<string>();
  const affectedEntityKeys = new Set<string>();

  for (const edge of allEdges) {
    if (changedKeys.has(edge.from_key) || changedKeys.has(edge.to_key)) {
      invalidatedEdges.push(edge);
      affectedFiles.add(edge.file_path);
      affectedEntityKeys.add(edge.from_key);
      affectedEntityKeys.add(edge.to_key);
    }
  }

  return { invalidatedEdges, affectedFiles, affectedEntityKeys };
}

/**
 * Check if a file needs re-indexing by comparing entity hashes.
 * Returns true if any entity has changed (fast short-circuit).
 */
export function fileNeedsReindex(
  oldEntities: IndexedEntity[],
  newEntities: IndexedEntity[]
): boolean {
  if (oldEntities.length !== newEntities.length) return true;

  const oldHashes = new Set(oldEntities.map((e) => `${e.key}:${e.body_hash}`));
  for (const e of newEntities) {
    if (!oldHashes.has(`${e.key}:${e.body_hash}`)) return true;
  }

  return false;
}
