/**
 * Doc-comment → domain_annotations wiring.
 *
 * Bridges the docstring extractor and the quality gates (annotation-gates)
 * into the two live index write paths:
 *   - full index   (local-indexer.indexLocalProject)
 *   - incremental  (incremental-indexer.indexFilesIncremental)
 *
 * Provenance contract: harvested 0.7 > propagated 0.6 > path 0.4. A higher
 * tier overwrites a lower one, NEVER the reverse — the upsert reads existing
 * rows and drops downgrades before writing.
 *
 * Dual-hash contract: `comment_hash` fingerprints the parsed comment prose so
 * an unchanged comment is a no-write; `content_hash` fingerprints the entity's
 * source slice at annotation time so the drift predicate can detect
 * code-moved-comment-didn't.
 *
 * Every exported write helper is best-effort: a failure downgrades to a
 * missing annotation, it never blocks the index.
 */

import { createHash } from "node:crypto";
import { hashEntityKey } from "../../cloud/drainers/envelope.js";
import { emit } from "../../events/enqueue.js";
import { applyAnnotationGates } from "./annotation-gates.js";
import type { ParsedDocComment } from "./docstring-extractor.js";
import { extractParsedDocComment } from "./docstring-extractor.js";
import { getPrimaryDomain } from "./path-domain-inference.js";

/** Minimal DB surface — matches incremental-indexer's DbLike and graphStore.db. */
export type AnnotationDb = {
  run: (
    q: string,
    p?: Record<string, unknown>
  ) => Promise<{ rows: unknown[][] }>;
};

/** An entity whose leading comment should be checked for an annotation. */
export interface AnnotationTarget {
  key: string;
  name: string;
  startLine: number;
  endLine: number;
}

/** A parsed-but-not-yet-gated annotation, content already released. */
export interface AnnotationCandidate {
  entityKey: string;
  entityName: string;
  parsed: ParsedDocComment;
  /** sha1 of the entity's source slice at parse time (drift baseline). */
  contentHash: string;
}

/** Provenance tiers this module writes (ordering: harvested>propagated>path). */
export type AnnotationSource = "harvested" | "propagated" | "path";

/** A gated row ready for the domain_annotations upsert. */
export interface DomainAnnotationRow {
  entity_key: string;
  summary: string;
  domain: string;
  source: AnnotationSource;
  confidence: number;
  comment_hash: string;
  content_hash: string;
}

/** Prose docstring harvested from the source — the most trusted tier. */
export const HARVESTED_SOURCE_CONFIDENCE = 0.7;
/** path-domain-inference regex — the floor, always available. */
export const PATH_SOURCE_CONFIDENCE = 0.4;

/** Provenance ordering — higher tier overwrites lower, never reverse. */
const SOURCE_TIER: Record<string, number> = {
  path: 0,
  propagated: 1,
  harvested: 2,
};

function sha1(text: string): string {
  return createHash("sha1").update(text).digest("hex");
}

/**
 * Parse the doc comment above each target entity. Pure CPU — call inside the
 * per-file extraction loop while `content` is in scope, keep only the small
 * candidates, and let the file content go.
 */
export function collectAnnotationCandidates(
  content: string,
  targets: readonly AnnotationTarget[]
): AnnotationCandidate[] {
  if (targets.length === 0) return [];
  const lines = content.split("\n");
  const candidates: AnnotationCandidate[] = [];
  for (const target of targets) {
    const parsed = extractParsedDocComment(content, target.startLine);
    if (parsed === null) continue;
    if (parsed.prose === null) continue;
    const slice = lines
      .slice(Math.max(0, target.startLine - 1), target.endLine)
      .join("\n");
    candidates.push({
      entityKey: target.key,
      entityName: target.name,
      parsed,
      contentHash: sha1(slice),
    });
  }
  return candidates;
}

/**
 * Run the quality gates over parsed candidates and shape surviving annotations
 * into rows. A candidate whose prose fails the gates is dropped — a wrong
 * summary is worse than no summary.
 *
 * `knownIdentifiers` (all entity names in the graph) powers the identifier
 * cross-check; omit to skip that gate.
 */
export function gateCandidates(
  candidates: readonly AnnotationCandidate[],
  opts: { knownIdentifiers?: ReadonlySet<string> } = {}
): DomainAnnotationRow[] {
  const rows: DomainAnnotationRow[] = [];
  for (const candidate of candidates) {
    const gated = applyAnnotationGates(candidate.parsed, {
      entityName: candidate.entityName,
      knownIdentifiers: opts.knownIdentifiers,
    });
    if (gated.summary === "") continue;
    rows.push({
      entity_key: candidate.entityKey,
      summary: gated.summary,
      domain: "",
      source: "harvested",
      confidence:
        Math.round(
          HARVESTED_SOURCE_CONFIDENCE * gated.confidenceMultiplier * 1000
        ) / 1000,
      comment_hash: sha1(candidate.parsed.prose ?? ""),
      content_hash: candidate.contentHash,
    });
  }
  return rows;
}

/**
 * Build path-inference floor rows: `source='path'` at 0.4 for every entity
 * whose file path matches a domain pattern. The floor is always available —
 * it gives an uncommented repo a populated domain column on first index.
 * Empty hashes: there is no comment to fingerprint, and the upsert's domain
 * equality check is the change signal. The upsert's tier ordering guarantees
 * these never overwrite harvested/propagated rows — call after the
 * higher-tier upsert.
 */
export function buildPathFloorRows(
  entities: ReadonlyArray<{ key: string; file_path: string }>
): DomainAnnotationRow[] {
  const domainByFile = new Map<string, string | null>();
  const rows: DomainAnnotationRow[] = [];
  for (const entity of entities) {
    let domain = domainByFile.get(entity.file_path);
    if (domain === undefined) {
      domain = getPrimaryDomain(entity.file_path);
      domainByFile.set(entity.file_path, domain);
    }
    if (domain === null) continue;
    rows.push({
      entity_key: entity.key,
      summary: "",
      domain,
      source: "path",
      confidence: PATH_SOURCE_CONFIDENCE,
      comment_hash: "",
      content_hash: "",
    });
  }
  return rows;
}

const UPSERT_BATCH_SIZE = 500;

/**
 * Upsert annotation rows into domain_annotations. Returns rows written.
 *
 * Skip rules, applied against the existing row for each key:
 *   - existing tier above the row's tier → never downgrade (ordering:
 *     harvested > propagated > path)
 *   - same source + same hashes + same domain → byte-identical annotation,
 *     no write (the "unchanged file → no write" contract). Path rows carry
 *     empty hashes, so domain is their only change signal.
 *
 * Per-row status is the comment-drift predicate: a write whose comment is
 * byte-identical to the prior row's but whose entity body moved
 * (`comment_hash` unchanged, `content_hash` changed, comment non-empty) is the
 * "doc predates the code" case — it lands status="stale". Every other write
 * (new annotation, rewritten comment, changed domain) lands status="active",
 * so rewriting the comment re-activates a row a prior edit marked stale.
 */
export async function upsertAnnotations(
  db: AnnotationDb,
  rows: readonly DomainAnnotationRow[]
): Promise<number> {
  if (rows.length === 0) return 0;

  // Batched read of existing rows for the candidate keys.
  const existing = new Map<
    string,
    {
      source: string;
      comment_hash: string;
      content_hash: string;
      domain: string;
    }
  >();
  for (let i = 0; i < rows.length; i += UPSERT_BATCH_SIZE) {
    const chunk = rows.slice(i, i + UPSERT_BATCH_SIZE);
    const keyRows = chunk.map((r) => [r.entity_key]);
    const result = await db.run(
      `candidate[k] <- $keys
       ?[entity_key, source, comment_hash, content_hash, domain] :=
         candidate[entity_key],
         *domain_annotations{entity_key, source, comment_hash, content_hash, domain}`,
      { keys: keyRows }
    );
    for (const row of result.rows) {
      existing.set(row[0] as string, {
        source: row[1] as string,
        comment_hash: row[2] as string,
        content_hash: row[3] as string,
        domain: row[4] as string,
      });
    }
  }

  const toWrite = rows.filter((row) => {
    const prior = existing.get(row.entity_key);
    if (prior === undefined) return true;
    if ((SOURCE_TIER[prior.source] ?? 0) > (SOURCE_TIER[row.source] ?? 0)) {
      return false;
    }
    return !(
      prior.source === row.source &&
      prior.comment_hash === row.comment_hash &&
      prior.content_hash === row.content_hash &&
      prior.domain === row.domain
    );
  });
  if (toWrite.length === 0) return 0;

  const computedAt = new Date().toISOString();
  for (let i = 0; i < toWrite.length; i += UPSERT_BATCH_SIZE) {
    const chunk = toWrite.slice(i, i + UPSERT_BATCH_SIZE);
    const dataRows = chunk.map((r) => {
      const prior = existing.get(r.entity_key);
      // Comment-drift predicate: the entity body moved (content_hash changed)
      // while its comment prose did not (comment_hash unchanged and
      // non-empty) — the doc now predates the code. Land stale so it
      // degrades-never-lies on serve. A changed/empty comment_hash is never
      // drift.
      const isCommentDrift =
        prior !== undefined &&
        r.comment_hash !== "" &&
        r.comment_hash === prior.comment_hash &&
        r.content_hash !== prior.content_hash;
      if (isCommentDrift) {
        // Mirror the comment-drift detection into the unified event store
        // so `unerrd` drains it as a `drift` event. HR-2: the entity key is
        // HASHED into `anchor` (an "e:<entity>" note address; the sanitizer
        // does NOT auto-strip that key name). `client_drift_id` is stable per
        // (entity, new content_hash) so re-detecting the same episode is
        // idempotent. emit() is fire-and-forget (no-op without ambient context).
        const anchor = hashEntityKey(`e:${r.entity_key}`);
        if (anchor !== undefined) {
          emit({
            type: "drift",
            detail: {
              client_drift_id: `comment_drift:${anchor}:${r.content_hash}`,
              anchor,
              drift_kind: "comment_drift",
              detected_at: computedAt,
            },
          });
        }
      }
      return [
        r.entity_key,
        r.summary,
        r.domain,
        r.source,
        r.confidence,
        isCommentDrift ? "stale" : "active",
        r.comment_hash,
        r.content_hash,
        computedAt,
      ];
    });
    await db.run(
      `?[entity_key, summary, domain, source, confidence, status, comment_hash, content_hash, computed_at] <- $rows
       :put domain_annotations {entity_key => summary, domain, source, confidence, status, comment_hash, content_hash, computed_at}`,
      { rows: dataRows }
    );
  }
  return toWrite.length;
}

/** The serveable slice of an annotation — what `search_code`/recon surface. */
export interface ServeableAnnotation {
  domain?: string;
  summary?: string;
  /**
   * True when the row is `status='stale'` — the body moved since the comment
   * was last confirmed. The summary already carries the
   * `STALE_SUMMARY_SUFFIX` so the served text degrades-never-lies; the flag
   * is the structured hook a retrieval ranker uses to downweight a stale
   * summary once annotations become a retrieval signal.
   */
  stale?: boolean;
}

/**
 * The degrade-never-lie marker appended to a stale summary on serve. A stale
 * summary is still shown (the agent gets the gist) but flagged so it is
 * never trusted as current.
 */
export const STALE_SUMMARY_SUFFIX = " (may be outdated — entity edited since)";

/**
 * Batch-read the serveable annotations for a set of entity keys. Active rows
 * serve as-is; stale rows serve with the `STALE_SUMMARY_SUFFIX` appended to
 * the summary and `stale:true` set, so the agent still gets the gist but
 * never trusts it as current. Rows with neither a domain nor summary — and
 * any non-active/non-stale status — are dropped, so an un-annotated key is
 * simply absent from the map.
 */
export async function fetchServeableAnnotations(
  db: AnnotationDb,
  keys: readonly string[]
): Promise<Map<string, ServeableAnnotation>> {
  const out = new Map<string, ServeableAnnotation>();
  if (keys.length === 0) return out;
  for (let i = 0; i < keys.length; i += UPSERT_BATCH_SIZE) {
    const chunk = keys.slice(i, i + UPSERT_BATCH_SIZE);
    const result = await db.run(
      `candidate[k] <- $keys
       ?[entity_key, summary, domain, status] :=
         candidate[entity_key],
         *domain_annotations{entity_key, summary, domain, status}`,
      { keys: chunk.map((k) => [k]) }
    );
    for (const row of result.rows) {
      const status = (row[3] as string) ?? "active";
      // Only active + stale rows are serveable; any future status (e.g. a
      // superseded row kept for audit) is silently skipped.
      if (status !== "active" && status !== "stale") continue;
      let summary = (row[1] as string) ?? "";
      const domain = (row[2] as string) ?? "";
      if (summary === "" && domain === "") continue;
      const stale = status === "stale";
      if (stale && summary !== "")
        summary = `${summary}${STALE_SUMMARY_SUFFIX}`;
      const ann: ServeableAnnotation = {};
      if (domain !== "") ann.domain = domain;
      if (summary !== "") ann.summary = summary;
      if (stale) ann.stale = true;
      out.set(row[0] as string, ann);
    }
  }
  return out;
}

/**
 * Attach serveable annotations onto search-result rows by key. A row with no
 * annotation is returned unchanged (identical to today); a row with one gains
 * `domain`/`summary`. Best-effort: a read failure returns the rows as-is
 * rather than dropping the search result.
 */
export async function attachAnnotations<T extends { key: string }>(
  db: AnnotationDb,
  rows: readonly T[]
): Promise<Array<T & ServeableAnnotation>> {
  // Defensive: serve sites pass whatever searchEntities returned. In production
  // that is always an entity array, but a non-array result (e.g. a raw string
  // a downstream layer compresses) must pass through byte-identical — never
  // throw on `.map`, which would reject the whole tool call.
  if (!Array.isArray(rows))
    return rows as unknown as Array<T & ServeableAnnotation>;
  if (rows.length === 0) return rows.map((r) => ({ ...r }));
  let annotations: Map<string, ServeableAnnotation>;
  try {
    annotations = await fetchServeableAnnotations(
      db,
      rows.map((r) => r.key)
    );
  } catch {
    return rows.map((r) => ({ ...r }));
  }
  return rows.map((r) => {
    const ann = annotations.get(r.key);
    return ann ? { ...r, ...ann } : { ...r };
  });
}

/** Remove annotation rows for deleted entities. Batched, best-effort caller. */
export async function removeAnnotationsForKeys(
  db: AnnotationDb,
  keys: readonly string[]
): Promise<void> {
  if (keys.length === 0) return;
  for (let i = 0; i < keys.length; i += UPSERT_BATCH_SIZE) {
    const chunk = keys.slice(i, i + UPSERT_BATCH_SIZE);
    await db.run(
      `dead[k] <- $keys
       ?[entity_key] := dead[entity_key], *domain_annotations{entity_key}
       :rm domain_annotations {entity_key}`,
      { keys: chunk.map((k) => [k]) }
    );
  }
}

/**
 * Prune annotation rows whose entity vanished from the graph — the
 * domain_annotations mirror of removeOrphanedEntities, run after a full
 * index pass with the same liveKeys set.
 */
export async function removeOrphanedAnnotations(
  db: AnnotationDb,
  liveKeys: ReadonlySet<string>
): Promise<void> {
  const result = await db.run(
    "?[entity_key] := *domain_annotations{entity_key}"
  );
  const orphans = result.rows
    .map((r) => r[0] as string)
    .filter((k) => !liveKeys.has(k));
  await removeAnnotationsForKeys(db, orphans);
}
