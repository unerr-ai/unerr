/**
 * Local search index using CozoDB relations.
 *
 * Tokenizes entity names (camelCase, snake_case, PascalCase) and stores
 * as search_tokens relation for fast local text search.
 *
 * Sprint 6.6: IDF-weighted scoring — rare tokens rank higher than common ones.
 * Pre-computes IDF weights during buildSearchIndex() for O(1) lookup at query time.
 */

import type { CozoDb } from "./cozo-schema.js";

/**
 * Rows-per-`:put` chunk for bulk search-index writes. Each `db.run` is one SQLite
 * commit; the old per-(token,entity) loop issued ~63K commits on a full index,
 * which — under the proxy's long-lived reader snapshot starving SQLite's PASSIVE
 * autocheckpoint — churned the WAL to GB scale (see persistent-db.ts
 * checkpointWal). Batching collapses that to a few hundred commits.
 */
const PUT_CHUNK = 512;

/**
 * Bulk-`:put` `rows` into a relation, one `db.run` per chunk instead of one per
 * row. On a chunk failure, falls back to per-row writes so a single bad row can
 * never drop the rest of the chunk.
 */
async function bulkPut(
  db: CozoDb,
  head: string,
  relationSpec: string,
  rows: unknown[][]
): Promise<void> {
  const script = `?[${head}] <- $rows :put ${relationSpec}`;
  for (let i = 0; i < rows.length; i += PUT_CHUNK) {
    const chunk = rows.slice(i, i + PUT_CHUNK);
    try {
      await db.run(script, { rows: chunk });
    } catch {
      for (const row of chunk) {
        try {
          await db.run(script, { rows: [row] });
        } catch {
          // Duplicate / malformed single row — ignore (matches prior behavior).
        }
      }
    }
  }
}

/**
 * Tokenize an entity name into searchable tokens.
 * Handles camelCase, PascalCase, snake_case, and kebab-case.
 */
export function tokenize(name: string): string[] {
  // Split on non-alphanumeric, then split camelCase
  const parts = name
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .split(/[^a-zA-Z0-9]+/)
    .filter((p) => p.length > 0)
    .map((p) => p.toLowerCase());

  return [...new Set(parts)];
}

/**
 * Build search index from entities already loaded in CozoDB.
 * Reads all entities, tokenizes names, populates search_tokens,
 * and computes IDF weights in token_doc_frequency.
 */
export async function buildSearchIndex(db: CozoDb): Promise<void> {
  // Read all entities
  let result: { rows?: unknown[][] };
  try {
    result = await db.run("?[key, name] := *entities{key, name}");
  } catch (err) {
    process.stderr.write(
      `[unerr:search-index] Failed to read entities: ${err instanceof Error ? err.message : JSON.stringify(err)}\n`
    );
    return; // Cannot build search index without entities
  }
  if (!result?.rows) return;

  const totalEntities = result.rows.length;
  process.stderr.write(
    `[unerr:search-index] Building index for ${totalEntities} entities\n`
  );
  // Track document frequency: how many entities contain each token
  const tokenDocCount = new Map<string, number>();

  // Collect (token, entity_key) rows for one chunked bulk :put instead of one
  // commit per pair — see bulkPut / PUT_CHUNK above for the WAL-bloat rationale.
  const tokenRows: unknown[][] = [];
  for (const row of result.rows) {
    const [key, name] = row as [string, string];
    const tokens = tokenize(name);
    for (const token of tokens) {
      tokenDocCount.set(token, (tokenDocCount.get(token) ?? 0) + 1);
      tokenRows.push([token, key]);
    }
  }
  // Key-sorted insert (token, entity_key). cozo stores the relation key-sorted;
  // feeding rows in key order keeps inserts on the rightmost B-tree leaf instead
  // of scattering page splits across the tree, sharply cutting the dirty pages
  // each commit writes to the (unreclaimed-under-held-reader) WAL.
  tokenRows.sort((a, b) => {
    const ta = a[0] as string;
    const tb = b[0] as string;
    if (ta !== tb) return ta < tb ? -1 : 1;
    return (a[1] as string) < (b[1] as string) ? -1 : 1;
  });
  await bulkPut(
    db,
    "token, entity_key",
    "search_tokens { token, entity_key }",
    tokenRows
  );

  // Store document frequencies + pre-computed IDF weights (chunked bulk :put).
  const idfRows: unknown[][] = [];
  for (const [token, docCount] of tokenDocCount) {
    const idf =
      totalEntities > 0 ? Math.log(totalEntities / Math.max(docCount, 1)) : 0;
    idfRows.push([token, docCount, idf]);
  }
  await bulkPut(
    db,
    "token, doc_count, idf",
    "token_doc_frequency { token => doc_count, idf }",
    idfRows
  );
  process.stderr.write(
    `[unerr:search-index] Done: ${tokenDocCount.size} tokens indexed\n`
  );
}

/**
 * Incrementally update search index for specific entities.
 * Removes old tokens for given keys, re-tokenizes, and updates IDF weights.
 */
export async function updateSearchIndexIncremental(
  db: CozoDb,
  changedKeys: Set<string>,
  deletedKeys: Set<string>
): Promise<void> {
  if (changedKeys.size === 0 && deletedKeys.size === 0) return;

  const allKeys = new Set([...changedKeys, ...deletedKeys]);

  // Remove old tokens for all affected keys
  for (const key of allKeys) {
    try {
      await db.run(
        "?[token, entity_key] := *search_tokens{token, entity_key}, entity_key = $key :rm search_tokens { token, entity_key }",
        { key }
      );
    } catch {
      /* safe */
    }
  }

  // Re-tokenize changed entities (not deleted ones)
  if (changedKeys.size === 0) return;

  // Fetch names for changed keys
  const keyRows = [...changedKeys]
    .map((k) => `["${k.replace(/"/g, '\\"')}"]`)
    .join(", ");
  let result: { rows?: unknown[][] };
  try {
    result = await db.run(`
      keys[k] <- [${keyRows}]
      ?[key, name] := keys[k], *entities{key: k, name}, key = k
    `);
  } catch {
    return;
  }
  if (!result?.rows) return;

  // Insert new tokens (chunked bulk :put).
  const tokenRows: unknown[][] = [];
  for (const row of result.rows) {
    const [key, name] = row as [string, string];
    const tokens = tokenize(name);
    for (const token of tokens) {
      tokenRows.push([token, key]);
    }
  }
  await bulkPut(
    db,
    "token, entity_key",
    "search_tokens { token, entity_key }",
    tokenRows
  );

  // Recompute IDF for all tokens (lightweight — just counts + math)
  try {
    const totalResult = await db.run("?[count(key)] := *entities{key}");
    const totalEntities = (totalResult.rows?.[0]?.[0] as number) ?? 1;

    const tokenResult = await db.run(
      "?[token, count(entity_key)] := *search_tokens{token, entity_key}"
    );
    if (tokenResult.rows) {
      const idfRows: unknown[][] = [];
      for (const row of tokenResult.rows) {
        const [token, docCount] = row as [string, number];
        const idf = Math.log(totalEntities / Math.max(docCount, 1));
        idfRows.push([token, docCount, idf]);
      }
      await bulkPut(
        db,
        "token, doc_count, idf",
        "token_doc_frequency { token => doc_count, idf }",
        idfRows
      );
    }
  } catch {
    /* IDF update failed — search still works, just with stale weights */
  }
}

/**
 * Search local entities by query string.
 * Tokenizes query, finds matching entities via token intersection,
 * ranks by IDF-weighted score (rare tokens contribute more to score).
 */
export async function searchLocal(
  db: CozoDb,
  query: string,
  limit = 20
): Promise<
  Array<{
    key: string;
    name: string;
    kind: string;
    file_path: string;
    score: number;
  }>
> {
  const queryTokens = tokenize(query);
  if (queryTokens.length === 0) return [];

  // Find entities that match ANY token, sum IDF weights per entity
  const tokenRows = queryTokens.map((t) => `["${t}"]`).join(", ");
  let result: { rows?: unknown[][] };
  try {
    result = await db.run(`
      tokens[t] <- [${tokenRows}]
      matched[ek, sum(w)] := tokens[t], *search_tokens[t, ek], *token_doc_frequency[t, _, w]
      ?[ek, score, name, kind, fp] := matched[ek, score],
        *entities{key: ek, kind, name, file_path: fp}
      :order -score
      :limit ${limit}
    `);
  } catch {
    return [];
  }
  if (!result?.rows) return [];

  return result.rows.map((row) => {
    const [key, score, name, kind, file_path] = row as [
      string,
      number,
      string,
      string,
      string,
    ];
    return { key, name, kind, file_path, score };
  });
}
