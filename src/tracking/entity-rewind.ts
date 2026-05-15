/**
 * Sprint 7.4: Entity-level rewind — surgically restore a single entity to its base state.
 *
 * Flow:
 *   1. Look up entity in drift_overlay by name (+ optional file_path)
 *   2. Read current file content
 *   3. Replace the entity's current body with previous_body at its line range
 *   4. Write the file back
 *   5. Remove drift_overlay entry
 *
 * For ADDED entities (no previous_body): delete the entity lines from the file.
 * For DELETED entities: restore previous_body at the original line position.
 * For MODIFIED entities: replace current lines with previous_body.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type {
  CozoGraphStore,
  DriftEntity,
} from "../intelligence/local-graph.js";

export interface RevertResult {
  reverted: boolean;
  file: string;
  lines: string;
  drift_status: string;
  error?: string;
}

/**
 * Revert a single entity to its base (pre-drift) state.
 */
export async function revertEntity(
  entityName: string,
  localGraph: CozoGraphStore,
  projectRoot: string,
  filePath?: string
): Promise<RevertResult> {
  // Find the drift entity by name
  const driftEntity = await findDriftEntity(localGraph, entityName, filePath);

  if (!driftEntity) {
    return {
      reverted: false,
      file: filePath ?? "",
      lines: "",
      drift_status: "",
      error: `No drifted entity found: "${entityName}"${filePath ? ` in ${filePath}` : ""}`,
    };
  }

  const absPath = join(projectRoot, driftEntity.file_path);

  if (driftEntity.drift_status === "added") {
    // Entity was added locally — remove it from the file
    return removeAddedEntity(absPath, driftEntity, localGraph);
  }

  if (driftEntity.drift_status === "deleted") {
    // Entity was deleted locally — restore previous_body
    return restoreDeletedEntity(absPath, driftEntity, localGraph);
  }

  if (driftEntity.drift_status === "modified") {
    // Entity was modified — replace current body with previous_body
    return restoreModifiedEntity(absPath, driftEntity, localGraph);
  }

  // dependency_changed — nothing to revert in the file itself
  await localGraph.removeDriftEntity(driftEntity.key);
  return {
    reverted: true,
    file: driftEntity.file_path,
    lines: "",
    drift_status: driftEntity.drift_status,
  };
}

/**
 * Find a drift entity by name, optionally filtered by file path.
 */
async function findDriftEntity(
  localGraph: CozoGraphStore,
  entityName: string,
  filePath?: string
): Promise<DriftEntity | null> {
  // Query drift_overlay for entities matching the name
  const result = await localGraph.db.run(
    filePath
      ? `?[key, name, kind, sig, body, fp, ls, le, ch, ds, iid, ma, origin, pb, ps] :=
          *drift_overlay[key, name, kind, sig, body, fp, ls, le, ch, ds, iid, ma, origin, pb, ps],
          name = $name, fp = $fp`
      : `?[key, name, kind, sig, body, fp, ls, le, ch, ds, iid, ma, origin, pb, ps] :=
          *drift_overlay[key, name, kind, sig, body, fp, ls, le, ch, ds, iid, ma, origin, pb, ps],
          name = $name`,
    filePath ? { name: entityName, fp: filePath } : { name: entityName }
  );

  if (result.rows.length === 0) return null;

  const [
    key,
    name,
    kind,
    signature,
    body,
    file_path,
    line_start,
    line_end,
    content_hash,
    drift_status,
    intent_id,
    modified_at,
    origin,
    previous_body,
    previous_signature,
  ] = result.rows[0] as [
    string,
    string,
    string,
    string,
    string,
    string,
    number,
    number,
    string,
    string,
    string,
    string,
    string,
    string,
    string,
  ];

  return {
    key,
    name,
    kind,
    signature,
    body,
    file_path,
    line_start,
    line_end,
    content_hash,
    drift_status: drift_status as DriftEntity["drift_status"],
    intent_id,
    modified_at,
    origin: origin as DriftEntity["origin"],
    previous_body,
    previous_signature,
  };
}

/**
 * Remove an ADDED entity from the file (it didn't exist in base).
 */
async function removeAddedEntity(
  absPath: string,
  entity: DriftEntity,
  localGraph: CozoGraphStore
): Promise<RevertResult> {
  try {
    const content = readFileSync(absPath, "utf-8");
    const lines = content.split("\n");

    // Remove the entity's lines (1-indexed → 0-indexed)
    const startIdx = entity.line_start - 1;
    const endIdx = entity.line_end;
    lines.splice(startIdx, endIdx - startIdx);

    writeFileSync(absPath, lines.join("\n"), "utf-8");
    await localGraph.removeDriftEntity(entity.key);

    return {
      reverted: true,
      file: entity.file_path,
      lines: `${entity.line_start}-${entity.line_end}`,
      drift_status: "added",
    };
  } catch (err) {
    return {
      reverted: false,
      file: entity.file_path,
      lines: "",
      drift_status: "added",
      error: `Failed to remove added entity: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/**
 * Restore a DELETED entity by inserting previous_body back into the file.
 */
async function restoreDeletedEntity(
  absPath: string,
  entity: DriftEntity,
  localGraph: CozoGraphStore
): Promise<RevertResult> {
  if (!entity.previous_body) {
    // No previous body stored — can't restore
    await localGraph.removeDriftEntity(entity.key);
    return {
      reverted: false,
      file: entity.file_path,
      lines: "",
      drift_status: "deleted",
      error: "No previous body available for restoration",
    };
  }

  try {
    const content = readFileSync(absPath, "utf-8");
    const lines = content.split("\n");
    const previousLines = entity.previous_body.split("\n");

    // Insert at the original line position (or end of file if beyond current length)
    const insertIdx = Math.min(entity.line_start - 1, lines.length);
    lines.splice(insertIdx, 0, ...previousLines);

    writeFileSync(absPath, lines.join("\n"), "utf-8");
    await localGraph.removeDriftEntity(entity.key);

    const endLine = insertIdx + previousLines.length;
    return {
      reverted: true,
      file: entity.file_path,
      lines: `${insertIdx + 1}-${endLine}`,
      drift_status: "deleted",
    };
  } catch (err) {
    return {
      reverted: false,
      file: entity.file_path,
      lines: "",
      drift_status: "deleted",
      error: `Failed to restore deleted entity: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/**
 * Restore a MODIFIED entity by replacing current lines with previous_body.
 */
async function restoreModifiedEntity(
  absPath: string,
  entity: DriftEntity,
  localGraph: CozoGraphStore
): Promise<RevertResult> {
  if (!entity.previous_body) {
    await localGraph.removeDriftEntity(entity.key);
    return {
      reverted: false,
      file: entity.file_path,
      lines: "",
      drift_status: "modified",
      error: "No previous body available for restoration",
    };
  }

  try {
    const content = readFileSync(absPath, "utf-8");
    const lines = content.split("\n");
    const previousLines = entity.previous_body.split("\n");

    // Replace the entity's current lines with the previous body
    const startIdx = entity.line_start - 1;
    const deleteCount = entity.line_end - entity.line_start + 1;
    lines.splice(startIdx, deleteCount, ...previousLines);

    writeFileSync(absPath, lines.join("\n"), "utf-8");
    await localGraph.removeDriftEntity(entity.key);

    const endLine = startIdx + previousLines.length;
    return {
      reverted: true,
      file: entity.file_path,
      lines: `${entity.line_start}-${endLine}`,
      drift_status: "modified",
    };
  } catch (err) {
    return {
      reverted: false,
      file: entity.file_path,
      lines: "",
      drift_status: "modified",
      error: `Failed to restore modified entity: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}
