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
 * Raw `domain_annotations` ARE synced here (Step 4.5) and inline comment-drift
 * is detected; the Layer 8 domain *derive* (propagation → community vote →
 * domain edges) is NOT run inline — it is O(communities + edges) and wasteful
 * per save. Instead this returns `annotationsChanged`, and the proxy debounces
 * a single `deriveDomainGraph` pass (DomainDeriveScheduler) shortly after the
 * edit settles. Community *membership* still refreshes only at the full reindex
 * (Louvain above), so the debounced derive votes over current annotations +
 * existing communities.
 *
 * Falls back to full reindex on any failure.
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { hashEntityKey } from "../cloud/sync/index.js";
import { loadSettings } from "../config/settings.js";
import { emit } from "../events/enqueue.js";
import { createYieldGate, maybeYield } from "../utils/index-yield.js";
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
import {
  buildPathFloorRows,
  collectAnnotationCandidates,
  gateCandidates,
  removeAnnotationsForKeys,
  upsertAnnotations,
} from "./semantic/annotation-indexer.js";

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
  /**
   * Layer 8: true when this batch wrote or removed at least one
   * `domain_annotations` row (a comment/harvest/path change, or an annotated
   * entity deletion). The caller uses it to debounce a `deriveDomainGraph`
   * re-derive — the community vote / propagation / domain edges refresh shortly
   * after a live edit instead of waiting for the idle full reindex. Stays false
   * when nothing annotation-relevant moved, so a code-only edit schedules no
   * derive.
   */
  annotationsChanged: boolean;
}

type DbLike = {
  run: (
    q: string,
    p?: Record<string, unknown>
  ) => Promise<{ rows: unknown[][] }>;
  write: (
    q: string,
    p?: Record<string, unknown>
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
  repoId: string
): Promise<IncrementalResult> {
  const startMs = Date.now();

  // Apply the whole delta as ONE atomic transaction: the per-file
  // delete-old-edges → reinsert-new-edges sequence becomes invisible to live
  // tool reads until it commits whole. Without this, a `get_references` landing
  // between the delete and the reinsert saw a half-purged edge set and reported
  // file-cohabitants as callers (the P1 false-positive bug). Reads run on
  // `immutable` snapshots (CozoGraphStore.query), so they are not blocked by the
  // open tx — they see the prior consistent graph until commit, then the new one.
  return graphStore.transact(async (db) => {
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
    // Layer 8: flips true once any domain_annotations row is written or removed,
    // so the caller can debounce a deriveDomainGraph re-derive.
    let annotationsChanged = false;

    // Lazily-fetched graph name set for the identifier cross-check gate
    // (queried once per batch, only when a file actually carries a prose
    // doc comment).
    let knownIdentifiers: Set<string> | null = null;
    const getKnownIdentifiers = async (): Promise<Set<string>> => {
      if (knownIdentifiers === null) {
        const result = await db.run("?[name] := *entities{name}");
        knownIdentifiers = new Set(result.rows.map((r) => r[0] as string));
      }
      return knownIdentifiers;
    };

    const yieldGate = createYieldGate();
    for (const filePath of changedFiles) {
      await maybeYield(yieldGate);
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

      // ── Content-hash early cutoff (FIX D Phase 3) ────────────────
      // If the raw content is byte-identical to the last indexed pass AND
      // the graph still holds entities for this file, the extract→diff→patch
      // pipeline below cannot produce any change — skip it outright.
      const fileHash = hashContent(content);
      const storedHash = await getFileHash(db, relPath);
      if (
        storedHash !== null &&
        storedHash === fileHash &&
        (await fileHasEntities(db, relPath))
      ) {
        filesProcessed++;
        continue;
      }

      const newExtracted = await extractEntitiesAsync(content, relPath);
      const newRawEdges = await extractEdgesAsync(
        content,
        relPath,
        newExtracted
      );
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
      const oldEdgeKeys = await getFileEdgeKeysBatched(
        db,
        relPath,
        oldEntities
      );

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

      // ── Step 4.5: Sync domain annotations (Layer 8) ──
      // Runs BEFORE the empty-diff early-continue: a comment-text edit that
      // doesn't shift line numbers changes no entity row, but its annotation
      // must still update. The upsert's comment_hash skip makes unchanged
      // comments a no-write; the path floor (0.4) runs after the higher tiers
      // so provenance ordering skips already-annotated entities. Best-effort —
      // annotations never block indexing.
      try {
        const targets = newExtracted.map((e, i) => ({
          // newEntities maps 1:1 over newExtracted, so [i] is always present
          key: newEntities[i]!.key,
          name: e.name,
          startLine: e.line_start,
          endLine: e.line_end,
        }));
        const candidates = collectAnnotationCandidates(content, targets);
        const annotationRows =
          candidates.length > 0
            ? gateCandidates(candidates, {
                knownIdentifiers: await getKnownIdentifiers(),
              })
            : [];
        // Reconcile stale durable annotations BEFORE the upsert. An in-place
        // comment edit keeps the entity row alive, so it never lands in `deleted`;
        // and upsertAnnotations is tier-guarded (comment 0.95 > harvested 0.7 >
        // path 0.4 — a higher prior tier is never overwritten by a lower-or-equal
        // new durable candidate → only the path floor, which the guard blocks) and
        // guard also blocks). Either way a phantom domain label lingers until the
        // next full reindex. Detect any prior comment/harvested row whose tier now
        // exceeds the best current durable candidate for that entity, delete it so
        // the upsert + path floor below re-apply the current truth, and flip
        // annotationsChanged so the debounced domain re-derive runs.
        if (newEntities.length > 0) {
          const DURABLE_TIER: Record<string, number> = {
            harvested: 2,
            comment: 3,
          };
          const bestCurrentTier = new Map<string, number>();
          for (const r of annotationRows) {
            const t = DURABLE_TIER[r.source] ?? 0;
            bestCurrentTier.set(
              r.entity_key,
              Math.max(bestCurrentTier.get(r.entity_key) ?? 0, t)
            );
          }
          const priorDurable = await db.run(
            `candidate[entity_key] <- $keys
           ?[entity_key, source] :=
             candidate[entity_key],
             *domain_annotations{entity_key, source}`,
            { keys: newEntities.map((e) => [e.key]) }
          );
          const staleDurableKeys = priorDurable.rows
            .filter((r) => {
              const priorTier = DURABLE_TIER[r[1] as string] ?? 0;
              if (priorTier === 0) return false; // only comment/harvested go stale
              return priorTier > (bestCurrentTier.get(r[0] as string) ?? 0);
            })
            .map((r) => r[0] as string);
          if (staleDurableKeys.length > 0) {
            await removeAnnotationsForKeys(db, staleDurableKeys);
            annotationsChanged = true;
          }
        }
        if (annotationRows.length > 0) {
          if ((await upsertAnnotations(db, annotationRows)) > 0) {
            annotationsChanged = true;
          }
        }
        const floored = await upsertAnnotations(
          db,
          buildPathFloorRows(
            newEntities.map((e) => ({ key: e.key, file_path: relPath }))
          )
        );
        if (floored > 0) annotationsChanged = true;
      } catch {
        /* annotation sync is best-effort */
      }

      // If nothing changed in this file, skip — but record the hash so the
      // next cycle takes the early cutoff above instead of re-extracting.
      if (added.length === 0 && updated.length === 0 && deleted.length === 0) {
        await setFileHash(db, relPath, fileHash);
        filesProcessed++;
        continue;
      }

      // ── Step 5: Apply graph patches (batched) ────────────────────

      // Delete removed entities + their edges (batched)
      if (deleted.length > 0) {
        const deletedKeys = deleted.map((e) => e.key);
        await removeEntitiesAndEdgesBatched(db, deletedKeys);
        try {
          await removeAnnotationsForKeys(db, deletedKeys);
          // Conservative: a deleted entity may have carried a domain label, so a
          // re-derive is scheduled. Over-eager only for un-annotated deletes,
          // which the debounce coalesces away — never misses a real removal.
          annotationsChanged = true;
        } catch {
          /* stale rows are pruned by the next full index's orphan sweep */
        }
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
          newExtracted
        );
        if (!fromKey) continue;
        localResolved.set(edge.from_name, fromKey);

        if (edge.to_name !== "__file__") {
          // Check local first
          const localKey = resolveLocalEntityName(
            edge.to_name,
            relPath,
            repoId,
            newExtracted
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

      // Record the content hash so an unchanged next cycle short-circuits.
      await setFileHash(db, relPath, fileHash);
      filesProcessed++;
    }

    // ── Step 7: Update fan_in/fan_out for affected entities (batched) ──
    await updateFanCountsBatched(db, affectedEntityKeys);

    // ── Step 8: Incremental search index update ────────────────────
    await updateSearchIndexIncremental(
      db,
      changedEntityKeys,
      deletedEntityKeys
    );

    return {
      filesProcessed,
      filesDeleted,
      entitiesAdded: totalEntitiesAdded,
      entitiesUpdated: totalEntitiesUpdated,
      entitiesDeleted: totalEntitiesDeleted,
      edgesAdded: totalEdgesAdded,
      edgesDeleted: totalEdgesDeleted,
      elapsedMs: Date.now() - startMs,
      annotationsChanged,
    };
  });
}

// ── Batched Helpers ─────────────────────────────────────────────

async function getFileEntities(
  db: DbLike,
  relPath: string
): Promise<CompactEntity[]> {
  try {
    const result = await db.run(
      `?[key, kind, name, file_path, start_line, signature, body, fan_in, fan_out, risk_level, is_test] :=
        *file_index{file_path: $fp, entity_key: key},
        *entities{key, kind, name, file_path, start_line, signature, body, fan_in, fan_out, risk_level, is_test}`,
      { fp: relPath }
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
  entities: CompactEntity[]
): Promise<Set<string>> {
  const keys = new Set<string>();

  // Scope removal to ONLY the edge types the incremental path re-inserts for
  // the whole file from `extractEdgesAsync` (calls/imports/extends/implements).
  // `contains` (file→entity) is re-inserted by updateFileIndexBatched for
  // added+updated entities only — removing it here would orphan unchanged
  // entities' contains edges. `tests`/`co_changes` are full-index-only and are
  // never re-inserted incrementally. Removing either would silently lose them.
  // The inline `keep` rule binds `type` from *edges, then filters to the set.
  const KEEP_TYPES = `keep[t] <- [["calls"], ["imports"], ["extends"], ["implements"]]`;

  if (entities.length > 0) {
    // Single query: get all re-insertable outgoing edges for all file entities
    // at once. `entity_key: from_key` binds the variable `from_key` directly
    // from file_index, so the head reference is bound; `*edges{from_key, ...}`
    // then unifies on it. (The earlier `entity_key: ek` + `from_key: ek` form
    // left `from_key` unbound in the head — eval::unbound_symb_in_head — so this
    // whole query threw and was swallowed, leaking every file's old out-edges.)
    try {
      const result = await db.run(
        `${KEEP_TYPES}
        ?[from_key, to_key, type] :=
          *file_index{file_path: $fp, entity_key: from_key},
          *edges{from_key, to_key, type}, keep[type]`,
        { fp: relPath }
      );
      for (const row of result.rows) {
        keys.add(`${row[0]}::${row[1]}::${row[2]}`);
      }
    } catch {
      /* safe */
    }
  }

  // Also get re-insertable edges from the file:<path> module entity (file-level
  // imports). Bind `from_key` as a variable and constrain it to $key, so the
  // head symbol is bound (the `from_key: $key` form left it unbound and threw).
  // `keep[type]` excludes the file→entity `contains` edges, which are preserved.
  try {
    const result = await db.run(
      `${KEEP_TYPES}
      ?[from_key, to_key, type] :=
        *edges{from_key, to_key, type}, from_key = $key, keep[type]`,
      { key: `file:${relPath}` }
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
  relPath: string
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
      { fp: relPath }
    );
    const entityKeys = result.rows.map((r) => r[0] as string);

    if (entityKeys.length > 0) {
      edgesDeleted += await removeEntitiesAndEdgesBatched(db, entityKeys);
      entitiesDeleted += entityKeys.length;
      for (const key of entityKeys) affectedKeys.add(key);
      // Layer 8: drop domain annotations for THIS file's entities only —
      // affectedKeys later gains surviving neighbours from other files
      // (for fan-count recalc), whose annotations must stay.
      try {
        await removeAnnotationsForKeys(db, entityKeys);
      } catch {
        /* stale rows are pruned by the next full index's orphan sweep */
      }
    }
  } catch {
    /* file not in index */
  }

  // Remove file_index entries
  try {
    await db.write(
      "?[file_path, entity_key] := *file_index{file_path: $fp, entity_key} :rm file_index { file_path, entity_key }",
      { fp: relPath }
    );
  } catch {
    /* safe */
  }

  // Clean edges incident to the file:<path> module entity (file→file
  // `imports`, file→entity `contains`). The code-entity removal above does
  // NOT cover edges that touch the file entity itself, so without this a
  // deleted file leaves dangling file→file `imports` edges — which would
  // later trip the Phase-4 referential-integrity check and force a needless
  // full reindex. Collect the surviving neighbours first so their fan counts
  // get recomputed by updateFanCountsBatched.
  const fileKey = `file:${relPath}`;
  try {
    const out = await db.run(
      "?[other] := *edges{from_key: $k, to_key: other}",
      { k: fileKey }
    );
    const inc = await db.run(
      "?[other] := *edges:rev{to_key: $k, from_key: other}",
      { k: fileKey }
    );
    for (const r of out.rows) affectedKeys.add(r[0] as string);
    for (const r of inc.rows) affectedKeys.add(r[0] as string);
    edgesDeleted += out.rows.length + inc.rows.length;
  } catch {
    /* best-effort neighbour collection */
  }
  await removeEdgesTouchingKeys(db, [[fileKey]]);

  // Remove file entity itself
  try {
    await db.write("?[key] <- [[$key]] :rm entities { key }", {
      key: fileKey,
    });
  } catch {
    /* safe */
  }

  // Drop the content-hash row so the file is never skipped after deletion.
  await removeFileHash(db, relPath);

  return { entitiesDeleted, edgesDeleted, affectedKeys };
}

// ── Content-hash early cutoff (FIX D Phase 3) ────────────────────
// Per-file sha1 of raw content. A matching hash means the extracted
// entities/edges cannot have changed (extraction is a pure function of
// content), so the whole extract→diff→patch pipeline is skipped. Stored
// additively in file_content_hashes (file_path => content_hash,
// indexed_at) and read by nothing else, so a stale/missing row only ever
// costs one redundant re-index — never correctness.

function hashContent(content: string): string {
  return createHash("sha1").update(content).digest("hex");
}

async function getFileHash(
  db: DbLike,
  relPath: string
): Promise<string | null> {
  try {
    const result = await db.run(
      "?[content_hash] := *file_content_hashes{file_path: $fp, content_hash}",
      { fp: relPath }
    );
    const row = result.rows[0];
    return row ? (row[0] as string) : null;
  } catch {
    return null;
  }
}

async function setFileHash(
  db: DbLike,
  relPath: string,
  hash: string
): Promise<void> {
  try {
    await db.write(
      `?[file_path, content_hash, indexed_at] <- [[$fp, $h, $now]]
       :put file_content_hashes { file_path, content_hash, indexed_at }`,
      { fp: relPath, h: hash, now: Date.now() }
    );
  } catch {
    /* best-effort — a miss only costs one redundant re-index next cycle */
  }

  // L1 — mirror the per-file content-hash observation into the unified event
  // store so `unerrd` drains it as a `state` event. HR-2: the file path is
  // HASHED into `file_id` (the sanitizer does NOT auto-strip that key name);
  // `content_hash` is already a hash, passed through. Co-change membership is
  // not available at this chokepoint, so the optional cochange_* fields are
  // omitted. emit() is fire-and-forget (no-op without ambient context).
  const file_id = hashEntityKey(relPath);
  if (file_id !== undefined) {
    emit({
      type: "state",
      detail: {
        file_id,
        content_hash: hash,
        observed_at: new Date().toISOString(),
      },
    });
  }
}

async function removeFileHash(db: DbLike, relPath: string): Promise<void> {
  try {
    await db.write(
      "?[file_path] <- [[$fp]] :rm file_content_hashes { file_path }",
      { fp: relPath }
    );
  } catch {
    /* safe */
  }
}

/**
 * True iff the graph still holds at least one code entity for this file.
 * Guards the hash skip: a matching hash with no entities present (e.g. a
 * full reindex that cleared the graph but left a stale hash row) must NOT
 * be skipped, or the file would never be re-indexed.
 */
async function fileHasEntities(db: DbLike, relPath: string): Promise<boolean> {
  try {
    const result = await db.run(
      "?[entity_key] := *file_index{file_path: $fp, entity_key}",
      { fp: relPath }
    );
    return result.rows.length > 0;
  } catch {
    return false;
  }
}

/**
 * Set-based rule (shared by the count and the :rm) selecting every edge that
 * touches any key in the `$keys` param — outgoing (from_key matches) or
 * incoming (to_key matches). The incoming arm reads the `edges:rev` index so
 * it range-scans by to_key instead of full-scanning. The two rule bodies union
 * into a deduped `removed` set, so an edge between two removed keys is counted
 * (and removed) exactly once. `$keys` is `[[key], [key], …]`.
 */
const REMOVED_EDGES_RULE = `targets[k] <- $keys
       removed[from_key, to_key, type] := targets[k], *edges{from_key, to_key, type}, from_key = k
       removed[from_key, to_key, type] := targets[k], *edges:rev{from_key, to_key, type}, to_key = k`;

/**
 * Remove every edge touching any of `keyRows` (in + out) in a single :rm.
 * One write regardless of key count — coalesces the old per-key loop
 * (2 writes per key) into one set-based transaction.
 */
async function removeEdgesTouchingKeys(
  db: DbLike,
  keyRows: string[][]
): Promise<void> {
  await db.write(
    `${REMOVED_EDGES_RULE}
       ?[from_key, to_key, type] := removed[from_key, to_key, type] :rm edges { from_key, to_key, type }`,
    { keys: keyRows }
  );
}

/**
 * Remove multiple entities and all their edges in set-based queries.
 * Collapses the old per-entity loop (2 edge writes + 1 file_index write per
 * key) into a fixed handful of writes: count → edge :rm → entity :rm →
 * file_index :rm, each independent of key count.
 */
async function removeEntitiesAndEdgesBatched(
  db: DbLike,
  entityKeys: string[]
): Promise<number> {
  if (entityKeys.length === 0) return 0;
  const keyRows = entityKeys.map((k) => [k]);
  let edgesRemoved = 0;

  // Count the distinct edges that will be removed (deduped union of out + in),
  // for an accurate edgesRemoved metric. One read instead of per-key scans.
  try {
    const result = await db.run(
      `${REMOVED_EDGES_RULE}
       ?[count(from_key)] := removed[from_key, to_key, type]`,
      { keys: keyRows }
    );
    edgesRemoved = Number(result.rows?.[0]?.[0] ?? 0);
  } catch {
    /* safe — metric only */
  }

  // Remove all edges touching any removed key (out + in) in a single :rm.
  try {
    await removeEdgesTouchingKeys(db, keyRows);
  } catch {
    /* safe */
  }

  // Batch remove entities.
  try {
    await db.write("?[key] <- $keys :rm entities { key }", { keys: keyRows });
  } catch {
    /* safe */
  }

  // Batch remove file_index entries in one set-based :rm via the
  // file_index:by_entity index, instead of one write per key.
  try {
    await db.write(
      `targets[k] <- $keys
       ?[file_path, entity_key] := targets[k], *file_index:by_entity{file_path, entity_key}, entity_key = k :rm file_index { file_path, entity_key }`,
      { keys: keyRows }
    );
  } catch {
    /* safe */
  }

  return edgesRemoved;
}

/**
 * Remove all edges (in + out) for multiple entity keys — one set-based :rm.
 */
async function removeEdgesForKeysBatched(
  db: DbLike,
  entityKeys: string[]
): Promise<void> {
  if (entityKeys.length === 0) return;
  const keyRows = entityKeys.map((k) => [k]);
  try {
    await removeEdgesTouchingKeys(db, keyRows);
  } catch {
    /* safe */
  }
}

/**
 * Upsert multiple entities in a single CozoDB :put operation.
 */
async function upsertEntitiesBatched(
  db: DbLike,
  entities: CompactEntity[]
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

  // Single :put driven by a $rows param — a constant query string (cozo can
  // reuse the compiled plan) and no manual escaping of bodies/signatures into
  // Datalog literals (the old inline-string form could mis-encode a body
  // containing backslash-quote sequences).
  try {
    await db.write(
      `?[key, kind, name, file_path, start_line, end_line, signature, body, fan_in, fan_out, risk_level, is_test] <- $rows
       :put entities { key => kind, name, file_path, start_line, end_line, signature, body, fan_in, fan_out, risk_level, is_test }`,
      { rows }
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
          }
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
  edges: Array<[string, string, string]>
): Promise<void> {
  if (edges.length === 0) return;

  try {
    await db.write(
      "?[from_key, to_key, type] <- $rows :rm edges { from_key, to_key, type }",
      { rows: edges }
    );
  } catch {
    // Fallback one-by-one
    for (const [fk, tk, type] of edges) {
      try {
        await db.write(
          "?[from_key, to_key, type] <- [[$fk, $tk, $type]] :rm edges { from_key, to_key, type }",
          { fk, tk, type }
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
  edges: Array<[string, string, string]>
): Promise<number> {
  if (edges.length === 0) return 0;

  // Param-driven :put — fill the non-key edge columns with their defaults.
  const rows = edges.map(([fk, tk, t]) => [
    fk,
    tk,
    t,
    -1,
    "",
    "",
    false,
    "",
    0,
    false,
    false,
    "",
    "",
  ]);

  try {
    await db.write(
      `?[from_key, to_key, type, sequence_order, condition, branch_kind, is_loop, loop_kind, nesting_depth, is_try_guarded, is_error_handler, mutation_target, mutation_mode] <- $rows
       :put edges { from_key, to_key, type => sequence_order, condition, branch_kind, is_loop, loop_kind, nesting_depth, is_try_guarded, is_error_handler, mutation_target, mutation_mode }`,
      { rows }
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
          { fk, tk, type }
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
  entities: CompactEntity[]
): Promise<void> {
  if (entities.length === 0) return;

  // Batch file_index :put (param-driven).
  const indexRows = entities.map((e) => [relPath, e.key]);
  try {
    await db.write(
      "?[file_path, entity_key] <- $rows :put file_index { file_path, entity_key }",
      { rows: indexRows }
    );
  } catch {
    /* safe */
  }

  // Batch contains edges :put (param-driven), file:<path> → each entity.
  const fileKey = `file:${relPath}`;
  const containsRows = entities.map((e) => [
    fileKey,
    e.key,
    "contains",
    -1,
    "",
    "",
    false,
    "",
    0,
    false,
    false,
    "",
    "",
  ]);
  try {
    await db.write(
      `?[from_key, to_key, type, sequence_order, condition, branch_kind, is_loop, loop_kind, nesting_depth, is_try_guarded, is_error_handler, mutation_target, mutation_mode] <- $rows
       :put edges { from_key, to_key, type => sequence_order, condition, branch_kind, is_loop, loop_kind, nesting_depth, is_try_guarded, is_error_handler, mutation_target, mutation_mode }`,
      { rows: containsRows }
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
  db: DbLike
): Promise<Map<string, string>> {
  const resolved = new Map<string, string>();
  if (names.length === 0) return resolved;

  // Build inline data for name lookup
  const nameRows = names
    .map((n) => `["${n.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"]`)
    .join(", ");

  try {
    // Resolve via the `entities:by_name` index: unifying name with the bound
    // `n` drives a range scan on the indexed name column, instead of
    // full-scanning entities once per lookup name.
    const result = await db.run(`
      lookup[n] <- [${nameRows}]
      ?[n, key] := lookup[n], *entities:by_name{name: n, key}
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
  entities: ExtractedEntity[]
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
  affectedKeys: Set<string>
): Promise<void> {
  // Filter to real entity keys
  const keys = [...affectedKeys].filter(
    (k) => !k.startsWith("file:") && !k.startsWith("unresolved:")
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

  // Single query: fan_in for all affected keys. Counts incoming edges via the
  // `edges:rev` index (to_key-first) — unifying to_key with the bound `k`
  // drives a range scan instead of full-scanning edges by the non-leading
  // to_key column for every affected key.
  try {
    const inResult = await db.run(`
      targets[k] <- [${keyRows}]
      ?[k, count(from_key)] := targets[k], *edges:rev{to_key: k, from_key, type}, type != "contains"
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
       :update entities { key => fan_in, fan_out }`
    );
  } catch {
    // Fallback: some keys may no longer exist — try individually
    for (const key of keys) {
      const fi = fanInMap.get(key) ?? 0;
      const fo = fanOutMap.get(key) ?? 0;
      try {
        await db.write(
          "?[key, fan_in, fan_out] <- [[$key, $fi, $fo]] :update entities { key => fan_in, fan_out }",
          { key, fi, fo }
        );
      } catch {
        /* entity deleted — safe */
      }
    }
  }
}
