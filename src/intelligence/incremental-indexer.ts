/**
 * Incremental Indexer — processes only changed files instead of full project reindex.
 *
 * Pipeline per changed file:
 *   1. Handle deletes (file removed from disk)
 *   2. Read + extract entities and edges
 *   3. Query graph for old entities of this file
 *   4. Diff old vs new entities
 *   5. Apply graph patch (batched add/update/delete)
 *   6. Resolve cross-file edges using existing graph (batched)
 *   7. Update fan_in/fan_out for affected entities (batched)
 *   8. Incremental search index update (changed keys only)
 *
 * Skipped (deferred to periodic full reindex):
 *   - Community detection (Louvain) — O(n+e), only meaningful on bulk changes
 *   - Convention detection — pattern scanning all entities
 *   - SCIP enrichment — requires full project compilation
 *   - Co-change edges — requires git history scan
 *   - L1 edge materialization — full rollup
 *   - Snapshot persistence
 *
 * Falls back to full reindex on any failure.
 */

import { existsSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import {
  type ExtractedEntity,
  entityKey,
  extractEdgesAsync,
  extractEntitiesAsync,
} from "./ast-extractor.js";
import { isTestFile } from "./indexer/test-detector.js";
import type {
  CompactEdge,
  CompactEntity,
  CozoGraphStore,
} from "./local-graph.js";
import { updateSearchIndexIncremental } from "./search-index.js";

// ── Types ────────────────────────────────────────────────────────

export interface IncrementalResult {
  filesProcessed: number;
  filesDeleted: number;
  entitiesAdded: number;
  entitiesUpdated: number;
  entitiesDeleted: number;
  edgesAdded: number;
  edgesDeleted: number;
  elapsedMs: number;
}

type DbLike = {
  run: (
    q: string,
    p?: Record<string, unknown>,
  ) => Promise<{ rows: unknown[][] }>;
  write: (
    q: string,
    p?: Record<string, unknown>,
  ) => Promise<{ rows: unknown[][] }>;
};

// ── Main Entry ───────────────────────────────────────────────────

/**
 * Incrementally index only the specified changed files.
 * Does NOT touch any file not in changedFiles.
 * Throws on unrecoverable failure (caller should fallback to full reindex).
 */
export async function indexFilesIncremental(
  projectRoot: string,
  changedFiles: string[],
  graphStore: CozoGraphStore,
  repoId: string,
): Promise<IncrementalResult> {
  const startMs = Date.now();
  const db: DbLike = {
    run: (q, p) => graphStore.db.run(q, p),
    write: (q, p) => graphStore.write(q, p),
  };

  let filesProcessed = 0;
  let filesDeleted = 0;
  let totalEntitiesAdded = 0;
  let totalEntitiesUpdated = 0;
  let totalEntitiesDeleted = 0;
  let totalEdgesAdded = 0;
  let totalEdgesDeleted = 0;

  // Collect all entity keys that had edges modified (for fan count recalc)
  const affectedEntityKeys = new Set<string>();
  // Track keys for incremental search index update
  const changedEntityKeys = new Set<string>();
  const deletedEntityKeys = new Set<string>();

  for (const filePath of changedFiles) {
    const absPath = filePath.startsWith("/")
      ? filePath
      : join(projectRoot, filePath);
    const relPath = filePath.startsWith("/")
      ? relative(projectRoot, filePath)
      : filePath;

    // ── Step 1: Handle deleted files ─────────────────────────────
    if (!existsSync(absPath)) {
      const deleted = await deleteFileFromGraph(db, relPath);
      filesDeleted++;
      totalEntitiesDeleted += deleted.entitiesDeleted;
      totalEdgesDeleted += deleted.edgesDeleted;
      for (const k of deleted.affectedKeys) {
        affectedEntityKeys.add(k);
        deletedEntityKeys.add(k);
      }
      continue;
    }

    // ── Step 2: Read + extract ───────────────────────────────────
    let content: string;
    try {
      content = readFileSync(absPath, "utf-8");
    } catch {
      continue;
    }

    const newExtracted = await extractEntitiesAsync(content, relPath);
    const newRawEdges = await extractEdgesAsync(content, relPath, newExtracted);
    const fileIsTest = isTestFile(relPath);

    // Build new CompactEntities
    const newEntities: CompactEntity[] = newExtracted.map((e) => ({
      key: entityKey(repoId, relPath, e.kind, e.name, e.signature),
      kind: e.kind,
      name: e.name,
      file_path: relPath,
      start_line: e.line_start,
      signature: e.signature,
      body: "",
      fan_in: 0,
      fan_out: 0,
      risk_level: "normal",
      community: -1,
      is_test: e.is_test ?? fileIsTest,
      parent_class: e.parent_class,
    }));

    // ── Step 3: Query old entities from graph ────────────────────
    const oldEntities = await getFileEntities(db, relPath);
    const oldEdgeKeys = await getFileEdgeKeysBatched(db, relPath, oldEntities);

    // ── Step 4: Diff ─────────────────────────────────────────────
    const oldMap = new Map(oldEntities.map((e) => [e.key, e]));
    const newMap = new Map(newEntities.map((e) => [e.key, e]));

    const added: CompactEntity[] = [];
    const updated: CompactEntity[] = [];
    const deleted: CompactEntity[] = [];

    for (const [key, entity] of newMap) {
      const old = oldMap.get(key);
      if (!old) {
        added.push(entity);
      } else if (
        old.start_line !== entity.start_line ||
        old.signature !== entity.signature
      ) {
        updated.push(entity);
      }
    }
    for (const [key, entity] of oldMap) {
      if (!newMap.has(key)) {
        deleted.push(entity);
      }
    }

    // If nothing changed in this file, skip
    if (added.length === 0 && updated.length === 0 && deleted.length === 0) {
      filesProcessed++;
      continue;
    }

    // ── Step 5: Apply graph patches (batched) ────────────────────

    // Delete removed entities + their edges (batched)
    if (deleted.length > 0) {
      const deletedKeys = deleted.map((e) => e.key);
      await removeEntitiesAndEdgesBatched(db, deletedKeys);
      for (const entity of deleted) {
        affectedEntityKeys.add(entity.key);
        deletedEntityKeys.add(entity.key);
        totalEntitiesDeleted++;
      }
    }

    // Delete edges for updated entities (batched)
    if (updated.length > 0) {
      const updatedKeys = updated.map((e) => e.key);
      await removeEdgesForKeysBatched(db, updatedKeys);
      for (const entity of updated) {
        affectedEntityKeys.add(entity.key);
      }
    }

    // Upsert added + updated entities (batched)
    const toUpsert = [...added, ...updated];
    if (toUpsert.length > 0) {
      await upsertEntitiesBatched(db, toUpsert);
      for (const entity of toUpsert) {
        affectedEntityKeys.add(entity.key);
        changedEntityKeys.add(entity.key);
      }
      totalEntitiesAdded += added.length;
      totalEntitiesUpdated += updated.length;
    }

    // Remove old edges originating from this file (batched)
    if (oldEdgeKeys.size > 0) {
      const edgeTuples: Array<[string, string, string]> = [];
      for (const edgeKey of oldEdgeKeys) {
        const [fromKey, toKey, type] = edgeKey.split("::");
        if (fromKey && toKey && type) {
          edgeTuples.push([fromKey, toKey, type]);
          affectedEntityKeys.add(fromKey);
          affectedEntityKeys.add(toKey);
        }
      }
      if (edgeTuples.length > 0) {
        await removeEdgesBatched(db, edgeTuples);
        totalEdgesDeleted += edgeTuples.length;
      }
    }

    // ── Step 6: Resolve cross-file edges (batched) ───────────────
    // Collect all unique to_names that need global resolution
    const toResolve = new Set<string>();
    const localResolved = new Map<string, string | null>();

    for (const edge of newRawEdges) {
      const fromKey = resolveLocalEntityName(
        edge.from_name,
        relPath,
        repoId,
        newExtracted,
      );
      if (!fromKey) continue;
      localResolved.set(edge.from_name, fromKey);

      if (edge.to_name !== "__file__") {
        // Check local first
        const localKey = resolveLocalEntityName(
          edge.to_name,
          relPath,
          repoId,
          newExtracted,
        );
        if (localKey) {
          localResolved.set(edge.to_name, localKey);
        } else {
          toResolve.add(edge.to_name);
        }
      }
    }

    // Batch resolve all global names in a single query
    const globalResolved =
      toResolve.size > 0
        ? await resolveEntityNamesGlobal([...toResolve], db)
        : new Map<string, string>();

    // Now insert all edges in batch
    const edgesToInsert: Array<[string, string, string]> = [];
    for (const edge of newRawEdges) {
      const fromKey =
        edge.from_name === "__file__"
          ? `file:${relPath}`
          : (localResolved.get(edge.from_name) ?? null);
      if (!fromKey) continue;

      let toKey: string | null = null;
      if (edge.to_name === "__file__") {
        toKey = `file:${relPath}`;
      } else {
        toKey =
          localResolved.get(edge.to_name) ??
          globalResolved.get(edge.to_name) ??
          null;
      }
      if (!toKey) continue;

      edgesToInsert.push([fromKey, toKey, edge.type]);
      affectedEntityKeys.add(fromKey);
      affectedEntityKeys.add(toKey);
    }

    if (edgesToInsert.length > 0) {
      const inserted = await insertEdgesBatched(db, edgesToInsert);
      totalEdgesAdded += inserted;
    }

    // Update file_index + contains edges (batched)
    if (toUpsert.length > 0) {
      await updateFileIndexBatched(db, relPath, toUpsert);
    }

    filesProcessed++;
  }

  // ── Step 7: Update fan_in/fan_out for affected entities (batched) ──
  await updateFanCountsBatched(db, affectedEntityKeys);

  // ── Step 8: Incremental search index update ────────────────────
  await updateSearchIndexIncremental(db, changedEntityKeys, deletedEntityKeys);

  return {
    filesProcessed,
    filesDeleted,
    entitiesAdded: totalEntitiesAdded,
    entitiesUpdated: totalEntitiesUpdated,
    entitiesDeleted: totalEntitiesDeleted,
    edgesAdded: totalEdgesAdded,
    edgesDeleted: totalEdgesDeleted,
    elapsedMs: Date.now() - startMs,
  };
}

// ── Batched Helpers ─────────────────────────────────────────────

async function getFileEntities(
  db: DbLike,
  relPath: string,
): Promise<CompactEntity[]> {
  try {
    const result = await db.run(
      `?[key, kind, name, file_path, start_line, signature, body, fan_in, fan_out, risk_level, is_test] :=
        *file_index{file_path: $fp, entity_key: key},
        *entities{key, kind, name, file_path, start_line, signature, body, fan_in, fan_out, risk_level, is_test}`,
      { fp: relPath },
    );
    return result.rows.map((row) => ({
      key: row[0] as string,
      kind: row[1] as string,
      name: row[2] as string,
      file_path: row[3] as string,
      start_line: row[4] as number,
      signature: row[5] as string,
      body: row[6] as string,
      fan_in: row[7] as number,
      fan_out: row[8] as number,
      risk_level: row[9] as string,
      community: -1,
      is_test: row[10] as boolean | undefined,
    })) as CompactEntity[];
  } catch {
    return [];
  }
}

/**
 * Get all edges originating from any entity in this file — single query.
 * Replaces the old N+1 pattern that ran one query per entity key.
 */
async function getFileEdgeKeysBatched(
  db: DbLike,
  relPath: string,
  entities: CompactEntity[],
): Promise<Set<string>> {
  const keys = new Set<string>();

  if (entities.length > 0) {
    // Single query: get all outgoing edges for all file entities at once
    try {
      const result = await db.run(
        `?[from_key, to_key, type] :=
          *file_index{file_path: $fp, entity_key: ek},
          *edges{from_key: ek, to_key, type}`,
        { fp: relPath },
      );
      for (const row of result.rows) {
        keys.add(`${row[0]}::${row[1]}::${row[2]}`);
      }
    } catch {
      /* safe */
    }
  }

  // Also get edges from file entity
  try {
    const result = await db.run(
      `?[from_key, to_key, type] := *edges{from_key: $key, to_key, type}`,
      { key: `file:${relPath}` },
    );
    for (const row of result.rows) {
      keys.add(`${row[0]}::${row[1]}::${row[2]}`);
    }
  } catch {
    /* safe */
  }

  return keys;
}

async function deleteFileFromGraph(
  db: DbLike,
  relPath: string,
): Promise<{
  entitiesDeleted: number;
  edgesDeleted: number;
  affectedKeys: Set<string>;
}> {
  const affectedKeys = new Set<string>();
  let entitiesDeleted = 0;
  let edgesDeleted = 0;

  try {
    const result = await db.run(
      "?[entity_key] := *file_index{file_path: $fp, entity_key}",
      { fp: relPath },
    );
    const entityKeys = result.rows.map((r) => r[0] as string);

    if (entityKeys.length > 0) {
      edgesDeleted += await removeEntitiesAndEdgesBatched(db, entityKeys);
      entitiesDeleted += entityKeys.length;
      for (const key of entityKeys) affectedKeys.add(key);
    }
  } catch {
    /* file not in index */
  }

  // Remove file_index entries
  try {
    await db.write(
      `?[file_path, entity_key] := *file_index{file_path: $fp, entity_key} :rm file_index { file_path, entity_key }`,
      { fp: relPath },
    );
  } catch {
    /* safe */
  }

  // Remove file entity itself
  try {
    await db.write("?[key] <- [[$key]] :rm entities { key }", {
      key: `file:${relPath}`,
    });
  } catch {
    /* safe */
  }

  return { entitiesDeleted, edgesDeleted, affectedKeys };
}

/**
 * Remove multiple entities and all their edges in batched queries.
 * Replaces per-entity sequential removeEntityAndEdges calls.
 */
async function removeEntitiesAndEdgesBatched(
  db: DbLike,
  entityKeys: string[],
): Promise<number> {
  let edgesRemoved = 0;

  for (const key of entityKeys) {
    // Remove outgoing edges
    try {
      const result = await db.write(
        `?[from_key, to_key, type] := *edges{from_key: $key, to_key, type} :rm edges { from_key, to_key, type }`,
        { key },
      );
      edgesRemoved += result.rows?.length ?? 0;
    } catch {
      /* safe */
    }

    // Remove incoming edges
    try {
      const result = await db.write(
        `?[from_key, to_key, type] := *edges{from_key, to_key: $key, type} :rm edges { from_key, to_key, type }`,
        { key },
      );
      edgesRemoved += result.rows?.length ?? 0;
    } catch {
      /* safe */
    }
  }

  // Batch remove entities
  if (entityKeys.length > 0) {
    const rows = entityKeys
      .map((k) => `["${k.replace(/"/g, '\\"')}"]`)
      .join(", ");
    try {
      await db.write(`?[key] <- [${rows}] :rm entities { key }`);
    } catch {
      /* safe */
    }

    // Batch remove file_index entries
    for (const key of entityKeys) {
      try {
        await db.write(
          `?[file_path, entity_key] := *file_index{file_path, entity_key}, entity_key = $key :rm file_index { file_path, entity_key }`,
          { key },
        );
      } catch {
        /* safe */
      }
    }
  }

  return edgesRemoved;
}

/**
 * Remove all edges (in + out) for multiple entity keys.
 */
async function removeEdgesForKeysBatched(
  db: DbLike,
  entityKeys: string[],
): Promise<void> {
  for (const key of entityKeys) {
    try {
      await db.write(
        `?[from_key, to_key, type] := *edges{from_key: $key, to_key, type} :rm edges { from_key, to_key, type }`,
        { key },
      );
    } catch {
      /* safe */
    }
    try {
      await db.write(
        `?[from_key, to_key, type] := *edges{from_key, to_key: $key, type} :rm edges { from_key, to_key, type }`,
        { key },
      );
    } catch {
      /* safe */
    }
  }
}

/**
 * Upsert multiple entities in a single CozoDB :put operation.
 */
async function upsertEntitiesBatched(
  db: DbLike,
  entities: CompactEntity[],
): Promise<void> {
  if (entities.length === 0) return;

  // CozoDB supports multi-row :put — build the data rows
  const rows = entities.map((e) => [
    e.key,
    e.kind,
    e.name,
    e.file_path,
    e.start_line ?? 0,
    (e as any).end_line ?? 0,
    e.signature ?? "",
    e.body ?? "",
    e.fan_in ?? 0,
    e.fan_out ?? 0,
    e.risk_level ?? "normal",
    e.is_test ?? false,
  ]);

  // Build inline data: ?[...] <- [[...], [...], ...]
  const rowStrs = rows.map((r) => {
    const vals = r.map((v) => {
      if (typeof v === "string")
        return `"${v.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
      if (typeof v === "boolean") return v ? "true" : "false";
      return String(v);
    });
    return `[${vals.join(", ")}]`;
  });

  try {
    await db.write(
      `?[key, kind, name, file_path, start_line, end_line, signature, body, fan_in, fan_out, risk_level, is_test] <- [${rowStrs.join(", ")}]
       :put entities { key => kind, name, file_path, start_line, end_line, signature, body, fan_in, fan_out, risk_level, is_test }`,
    );
  } catch {
    // Fallback: try one-by-one if batch fails (e.g., encoding issues)
    for (const entity of entities) {
      try {
        await db.write(
          `?[key, kind, name, file_path, start_line, end_line, signature, body, fan_in, fan_out, risk_level, is_test] <- [[$key, $kind, $name, $fp, $sl, $el, $sig, $body, $fi, $fo, $rl, $is_test]]
           :put entities { key => kind, name, file_path, start_line, end_line, signature, body, fan_in, fan_out, risk_level, is_test }`,
          {
            key: entity.key,
            kind: entity.kind,
            name: entity.name,
            fp: entity.file_path,
            sl: entity.start_line ?? 0,
            el: (entity as any).end_line ?? 0,
            sig: entity.signature ?? "",
            body: entity.body ?? "",
            fi: entity.fan_in ?? 0,
            fo: entity.fan_out ?? 0,
            rl: entity.risk_level ?? "normal",
            is_test: entity.is_test ?? false,
          },
        );
      } catch {
        /* safe */
      }
    }
  }
}

/**
 * Remove edges by exact (from_key, to_key, type) tuples — batched.
 */
async function removeEdgesBatched(
  db: DbLike,
  edges: Array<[string, string, string]>,
): Promise<void> {
  if (edges.length === 0) return;

  const rowStrs = edges.map(
    ([fk, tk, t]) =>
      `["${fk.replace(/"/g, '\\"')}", "${tk.replace(/"/g, '\\"')}", "${t.replace(/"/g, '\\"')}"]`,
  );

  try {
    await db.write(
      `?[from_key, to_key, type] <- [${rowStrs.join(", ")}] :rm edges { from_key, to_key, type }`,
    );
  } catch {
    // Fallback one-by-one
    for (const [fk, tk, type] of edges) {
      try {
        await db.write(
          `?[from_key, to_key, type] <- [[$fk, $tk, $type]] :rm edges { from_key, to_key, type }`,
          { fk, tk, type },
        );
      } catch {
        /* safe */
      }
    }
  }
}

/**
 * Insert edges in batch — single :put with all edge rows.
 */
async function insertEdgesBatched(
  db: DbLike,
  edges: Array<[string, string, string]>,
): Promise<number> {
  if (edges.length === 0) return 0;

  const rowStrs = edges.map(([fk, tk, t]) => {
    const eFk = fk.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    const eTk = tk.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    const eT = t.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    return `["${eFk}", "${eTk}", "${eT}", -1, "", "", false, "", 0, false, false, "", ""]`;
  });

  try {
    await db.write(
      `?[from_key, to_key, type, sequence_order, condition, branch_kind, is_loop, loop_kind, nesting_depth, is_try_guarded, is_error_handler, mutation_target, mutation_mode] <- [${rowStrs.join(", ")}]
       :put edges { from_key, to_key, type => sequence_order, condition, branch_kind, is_loop, loop_kind, nesting_depth, is_try_guarded, is_error_handler, mutation_target, mutation_mode }`,
    );
    return edges.length;
  } catch {
    // Fallback one-by-one
    let inserted = 0;
    for (const [fk, tk, type] of edges) {
      try {
        await db.write(
          `?[from_key, to_key, type, sequence_order, condition, branch_kind, is_loop, loop_kind, nesting_depth, is_try_guarded, is_error_handler, mutation_target, mutation_mode] <- [[$fk, $tk, $type, -1, "", "", false, "", 0, false, false, "", ""]]
           :put edges { from_key, to_key, type => sequence_order, condition, branch_kind, is_loop, loop_kind, nesting_depth, is_try_guarded, is_error_handler, mutation_target, mutation_mode }`,
          { fk, tk, type },
        );
        inserted++;
      } catch {
        /* edge conflict — safe */
      }
    }
    return inserted;
  }
}

/**
 * Update file_index and contains edges for upserted entities — batched.
 */
async function updateFileIndexBatched(
  db: DbLike,
  relPath: string,
  entities: CompactEntity[],
): Promise<void> {
  if (entities.length === 0) return;

  // Batch file_index :put
  const indexRows = entities.map((e) => {
    const ek = e.key.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    const fp = relPath.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    return `["${fp}", "${ek}"]`;
  });

  try {
    await db.write(
      `?[file_path, entity_key] <- [${indexRows.join(", ")}] :put file_index { file_path, entity_key }`,
    );
  } catch {
    /* safe */
  }

  // Batch contains edges :put
  const containsRows = entities.map((e) => {
    const from = `file:${relPath}`.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    const to = e.key.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    return `["${from}", "${to}", "contains", -1, "", "", false, "", 0, false, false, "", ""]`;
  });

  try {
    await db.write(
      `?[from_key, to_key, type, sequence_order, condition, branch_kind, is_loop, loop_kind, nesting_depth, is_try_guarded, is_error_handler, mutation_target, mutation_mode] <- [${containsRows.join(", ")}]
       :put edges { from_key, to_key, type => sequence_order, condition, branch_kind, is_loop, loop_kind, nesting_depth, is_try_guarded, is_error_handler, mutation_target, mutation_mode }`,
    );
  } catch {
    /* safe */
  }
}

/**
 * Resolve multiple entity names to keys in a single query.
 * Replaces the old per-name sequential resolveEntityNameGlobal calls.
 */
async function resolveEntityNamesGlobal(
  names: string[],
  db: DbLike,
): Promise<Map<string, string>> {
  const resolved = new Map<string, string>();
  if (names.length === 0) return resolved;

  // Build inline data for name lookup
  const nameRows = names
    .map((n) => `["${n.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"]`)
    .join(", ");

  try {
    const result = await db.run(`
      lookup[n] <- [${nameRows}]
      ?[n, key] := lookup[n], *entities{key, name}, name = n
    `);
    for (const row of result.rows) {
      const [name, key] = row as [string, string];
      // Only take first match per name (equivalent to old :limit 1)
      if (!resolved.has(name)) {
        resolved.set(name, key);
      }
    }
  } catch {
    /* safe — caller handles missing resolutions */
  }

  return resolved;
}

function resolveLocalEntityName(
  name: string,
  filePath: string,
  repoId: string,
  entities: ExtractedEntity[],
): string | null {
  if (name === "__file__") return `file:${filePath}`;
  const match = entities.find((e) => e.name === name);
  if (match) {
    return entityKey(repoId, filePath, match.kind, match.name, match.signature);
  }
  return null;
}

/**
 * Update fan_in/fan_out for all affected entities in batched queries.
 * Replaces the old 3-queries-per-entity pattern with 2 aggregate queries + 1 batch update.
 */
async function updateFanCountsBatched(
  db: DbLike,
  affectedKeys: Set<string>,
): Promise<void> {
  // Filter to real entity keys
  const keys = [...affectedKeys].filter(
    (k) => !k.startsWith("file:") && !k.startsWith("unresolved:"),
  );
  if (keys.length === 0) return;

  // Build lookup data for all affected keys
  const keyRows = keys
    .map((k) => `["${k.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"]`)
    .join(", ");

  const fanOutMap = new Map<string, number>();
  const fanInMap = new Map<string, number>();

  // Single query: fan_out for all affected keys
  try {
    const outResult = await db.run(`
      targets[k] <- [${keyRows}]
      ?[k, count(to_key)] := targets[k], *edges{from_key: k, to_key, type}, type != "contains"
    `);
    for (const row of outResult.rows) {
      fanOutMap.set(row[0] as string, row[1] as number);
    }
  } catch {
    /* safe */
  }

  // Single query: fan_in for all affected keys
  try {
    const inResult = await db.run(`
      targets[k] <- [${keyRows}]
      ?[k, count(from_key)] := targets[k], *edges{from_key, to_key: k, type}, type != "contains"
    `);
    for (const row of inResult.rows) {
      fanInMap.set(row[0] as string, row[1] as number);
    }
  } catch {
    /* safe */
  }

  // Build batch update rows
  const updateRows = keys.map((k) => {
    const fi = fanInMap.get(k) ?? 0;
    const fo = fanOutMap.get(k) ?? 0;
    return `["${k.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}", ${fi}, ${fo}]`;
  });

  // Single batch update
  try {
    await db.write(
      `?[key, fan_in, fan_out] <- [${updateRows.join(", ")}]
       :update entities { key => fan_in, fan_out }`,
    );
  } catch {
    // Fallback: some keys may no longer exist — try individually
    for (const key of keys) {
      const fi = fanInMap.get(key) ?? 0;
      const fo = fanOutMap.get(key) ?? 0;
      try {
        await db.write(
          `?[key, fan_in, fan_out] <- [[$key, $fi, $fo]] :update entities { key => fan_in, fan_out }`,
          { key, fi, fo },
        );
      } catch {
        /* entity deleted — safe */
      }
    }
  }
}
