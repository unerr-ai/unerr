/**
 * Layer 8 SC-A.3: comment → domain_annotations wiring.
 *
 * Bridges the sentinel parser (docstring-extractor) and the quality gates
 * (annotation-gates) into the two live index write paths:
 *   - full index   (local-indexer.indexLocalProject, Phase 6.6)
 *   - incremental  (incremental-indexer.indexFilesIncremental, Step 4.5)
 *
 * Provenance contract (§4): comment 0.95 > harvested 0.7 > propagated 0.6 >
 * path 0.4. A higher tier overwrites a lower one, NEVER the reverse — the
 * upsert reads existing rows and drops downgrades before writing.
 *
 * Dual-hash contract (§6): `comment_hash` fingerprints the parsed comment
 * (prose + sentinel pairs) so an unchanged comment is a no-write;
 * `content_hash` fingerprints the entity's source slice at annotation time
 * so the drift predicate (SC-C.1) can detect code-moved-comment-didn't.
 *
 * Every exported write helper is best-effort: a failure downgrades to a
 * missing annotation, it never blocks the index.
 */

import { createHash } from "node:crypto";
import { applyAnnotationGates } from "./annotation-gates.js";
import type { ParsedDocComment } from "./docstring-extractor.js";
import {
  DEFAULT_SENTINEL_TOKENS,
  extractParsedDocComment,
} from "./docstring-extractor.js";
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

/** Provenance tiers this module writes (§5.3 ordering: comment>harvested>propagated>path). */
export type AnnotationSource = "comment" | "harvested" | "propagated" | "path";

/** A gated row ready for the domain_annotations upsert. */
export interface DomainAnnotationRow {
  entity_key: string;
  summary: string;
  domain: string;
  role: string;
  /** JSON-encoded passthrough pairs (everything except domain/role). */
  extras: string;
  source: AnnotationSource;
  confidence: number;
  comment_hash: string;
  content_hash: string;
}

/** Sentinel-bearing comment — agent/human authored the @sem line (§5.3). */
export const COMMENT_SOURCE_CONFIDENCE = 0.95;
/** Pre-existing prose docstring, no sentinel — unvalidated vocabulary (§5.3). */
export const HARVESTED_SOURCE_CONFIDENCE = 0.7;
/** path-domain-inference regex — the floor, always available (§5.3). */
export const PATH_SOURCE_CONFIDENCE = 0.4;

/** Provenance ordering — higher tier overwrites lower, never reverse (§4). */
const SOURCE_TIER: Record<string, number> = {
  path: 0,
  propagated: 1,
  harvested: 2,
  comment: 3,
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
  targets: readonly AnnotationTarget[],
  tokens: readonly string[] = DEFAULT_SENTINEL_TOKENS
): AnnotationCandidate[] {
  if (targets.length === 0) return [];
  const lines = content.split("\n");
  const tokenList = [...tokens];
  const candidates: AnnotationCandidate[] = [];
  for (const target of targets) {
    const parsed = extractParsedDocComment(
      content,
      target.startLine,
      tokenList
    );
    if (parsed === null) continue;
    if (parsed.prose === null && parsed.sentinel === null) continue;
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
 * Run the §5.2 gates over parsed candidates and shape surviving annotations
 * into rows. A candidate where neither prose nor pairs survive is dropped —
 * a wrong summary is worse than no summary.
 *
 * `knownIdentifiers` (all entity names in the graph) powers the identifier
 * cross-check; omit to skip that gate. The annotation-gates vocabulary gate
 * (its `activeDomains` option) stays off by design — SC-C.4 surfaces the
 * candidate/canonical split and sprawl merge hints post-hoc from the persisted
 * rows via {@link fetchVocabularyNudges}, rather than rejecting a new domain at
 * parse time (a never-before-seen tag is kept, then nudged, never dropped).
 *
 * Provenance (§5.3): a sentinel-bearing comment is the contract form —
 * `source='comment'` at 0.95. Prose with no sentinel is a pre-existing
 * docstring harvested as-is — `source='harvested'` at 0.7.
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
    const { domain = "", role = "", ...extraPairs } = gated.pairs;
    if (gated.summary === "" && domain === "" && role === "") continue;
    const harvested = candidate.parsed.sentinel === null;
    const baseConfidence = harvested
      ? HARVESTED_SOURCE_CONFIDENCE
      : COMMENT_SOURCE_CONFIDENCE;
    rows.push({
      entity_key: candidate.entityKey,
      summary: gated.summary,
      domain,
      role,
      extras: JSON.stringify(extraPairs),
      source: harvested ? "harvested" : "comment",
      confidence:
        Math.round(baseConfidence * gated.confidenceMultiplier * 1000) / 1000,
      comment_hash: sha1(
        JSON.stringify({
          prose: candidate.parsed.prose,
          pairs: candidate.parsed.sentinel?.pairs ?? null,
        })
      ),
      content_hash: candidate.contentHash,
    });
  }
  return rows;
}

/**
 * Build path-inference floor rows (§5.3): `source='path'` at 0.4 for every
 * entity whose file path matches a domain pattern. The floor is always
 * available — it gives an uncommented repo a populated domain column on
 * first index. Empty hashes: there is no comment to fingerprint, and the
 * upsert's domain equality check is the change signal. The upsert's tier
 * ordering guarantees these never overwrite comment/harvested/propagated
 * rows — call after the higher-tier upsert.
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
      role: "",
      extras: "{}",
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
 *   - existing tier above the row's tier → never downgrade (§5.3 ordering:
 *     comment > harvested > propagated > path)
 *   - same source + same hashes + same domain → byte-identical annotation,
 *     no write (the "unchanged file → no write" contract). Path rows carry
 *     empty hashes, so domain is their only change signal.
 *
 * Per-row status is the §5.1 comment-drift predicate: a write whose comment
 * is byte-identical to the prior row's but whose entity body moved
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
      // §5.1 comment-drift predicate: the entity body moved (content_hash
      // changed) while its comment (prose + @sem pairs) did not (comment_hash
      // unchanged and non-empty) — the doc now predates the code. Land stale so
      // it degrades-never-lies on serve (C.3) and the nudge fires once per
      // episode (C.2). A changed/empty comment_hash is never drift.
      const isCommentDrift =
        prior !== undefined &&
        r.comment_hash !== "" &&
        r.comment_hash === prior.comment_hash &&
        r.content_hash !== prior.content_hash;
      return [
        r.entity_key,
        r.summary,
        r.domain,
        r.role,
        r.extras,
        r.source,
        r.confidence,
        isCommentDrift ? "stale" : "active",
        r.comment_hash,
        r.content_hash,
        computedAt,
      ];
    });
    await db.run(
      `?[entity_key, summary, domain, role, extras, source, confidence, status, comment_hash, content_hash, computed_at] <- $rows
       :put domain_annotations {entity_key => summary, domain, role, extras, source, confidence, status, comment_hash, content_hash, computed_at}`,
      { rows: dataRows }
    );
  }
  return toWrite.length;
}

/** The serveable slice of an annotation — what `search_code`/recon surface. */
export interface ServeableAnnotation {
  domain?: string;
  role?: string;
  summary?: string;
  /**
   * Layer 8 §5.1 (SC-C.3): true when the row is `status='stale'` — the body
   * moved since the comment was last confirmed. The summary already carries the
   * `STALE_SUMMARY_SUFFIX` so the served text degrades-never-lies; the flag is
   * the structured hook a retrieval ranker uses to downweight a stale summary
   * once annotations become a retrieval signal (SC-D).
   */
  stale?: boolean;
}

/**
 * §5.1: the degrade-never-lie marker appended to a stale summary on serve. A
 * stale summary is still shown (the agent gets the gist) but flagged so it is
 * never trusted as current.
 */
export const STALE_SUMMARY_SUFFIX = " (may be outdated — entity edited since)";

/**
 * Batch-read the serveable annotations for a set of entity keys (§5.4 serve
 * path). Active rows serve as-is; stale rows (SC-C.3) serve with the
 * `STALE_SUMMARY_SUFFIX` appended to the summary and `stale:true` set, so the
 * agent still gets the gist but never trusts it as current. Rows with neither a
 * domain, role, nor summary — and any non-active/non-stale status — are
 * dropped, so an un-annotated key is simply absent from the map and served
 * identically to today.
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
       ?[entity_key, summary, domain, role, status] :=
         candidate[entity_key],
         *domain_annotations{entity_key, summary, domain, role, status}`,
      { keys: chunk.map((k) => [k]) }
    );
    for (const row of result.rows) {
      const status = (row[4] as string) ?? "active";
      // Only active + stale rows are serveable; any future status (e.g. a
      // superseded row kept for audit) is silently skipped.
      if (status !== "active" && status !== "stale") continue;
      let summary = (row[1] as string) ?? "";
      const domain = (row[2] as string) ?? "";
      const role = (row[3] as string) ?? "";
      if (summary === "" && domain === "" && role === "") continue;
      const stale = status === "stale";
      if (stale && summary !== "")
        summary = `${summary}${STALE_SUMMARY_SUFFIX}`;
      const ann: ServeableAnnotation = {};
      if (domain !== "") ann.domain = domain;
      if (role !== "") ann.role = role;
      if (summary !== "") ann.summary = summary;
      if (stale) ann.stale = true;
      out.set(row[0] as string, ann);
    }
  }
  return out;
}

/** One active domain tag and how many entities currently carry it. */
export interface DomainTagCount {
  domain: string;
  count: number;
}

/**
 * The active domain-tag vocabulary, ranked by entity count (§5.4 "reuse before
 * invent"). Served in the recon / `unerr_context` bundle so an agent about to
 * write a new `@sem domain=` reuses an existing tag instead of minting a near-
 * duplicate (`auth` vs `authn` vs `authentication`). Only active rows with a
 * non-empty domain are counted; best-effort — a read failure returns [].
 */
export async function fetchActiveDomainTags(
  db: AnnotationDb
): Promise<DomainTagCount[]> {
  try {
    const result = await db.run(
      `?[domain, count(entity_key)] :=
         *domain_annotations{entity_key, domain, status: "active"},
         domain != ""`
    );
    const tags: DomainTagCount[] = [];
    for (const row of result.rows) {
      const domain = (row[0] as string) ?? "";
      const count = Number(row[1] ?? 0);
      if (domain === "" || count <= 0) continue;
      tags.push({ domain, count });
    }
    // Rank by count desc; ties broken alphabetically for a stable order.
    tags.sort((a, b) => b.count - a.count || a.domain.localeCompare(b.domain));
    return tags;
  } catch {
    return [];
  }
}

/** One un-annotated entity worth a `@sem` comment, ranked by blast radius. */
export interface MissingAnnotationSite {
  key: string;
  name: string;
  file: string;
  fan_in: number;
}

/**
 * Sprint SC-E.1 — the backfill site enumerator. Returns entities that carry no
 * *durable* (comment- or harvest-sourced) domain annotation, ranked by `fan_in`
 * descending so the highest-blast-radius code gets a `@sem` line first.
 * Inferred annotations (`propagated`, `path`) do NOT count as coverage — they
 * are graph guesses, not human-authored semantics, so an entity holding only
 * those is still a backfill target.
 *
 * This is the graph-enumeration half of the backfill workload (§8): it names
 * the sites; the host agent authors the comments. `unerr plan
 * --missing-annotations` will consume this list once delegation Phase 1 ships
 * (it is the W1.6 site enumerator) — until then the function stands alone and
 * is independently testable. Best-effort: a read failure returns [].
 *
 * @param limit  max sites to return (highest fan_in first). Default 50.
 */
export async function enumerateMissingAnnotationSites(
  db: AnnotationDb,
  limit = 50
): Promise<MissingAnnotationSite[]> {
  const cap = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 50;
  try {
    // `durable[key]` collects every entity holding a comment/harvested row;
    // the output negates it (stratified negation over a named rule) so only
    // entities with zero durable annotations survive. fan_in > 0 skips leaves
    // that no caller depends on — annotating them buys little.
    const result = await db.run(
      `durable[key] := *domain_annotations{entity_key: key, source: "comment"}
       durable[key] := *domain_annotations{entity_key: key, source: "harvested"}
       ?[key, name, file_path, fan_in] :=
         *entities{key, name, file_path, fan_in},
         fan_in > 0,
         not durable[key]
       :order -fan_in
       :limit ${cap}`
    );
    const sites: MissingAnnotationSite[] = [];
    for (const row of result.rows) {
      const key = (row[0] as string) ?? "";
      const name = (row[1] as string) ?? "";
      const file = (row[2] as string) ?? "";
      const fanIn = Number(row[3] ?? 0);
      if (key === "") continue;
      sites.push({ key, name, file, fan_in: fanIn });
    }
    return sites;
  } catch {
    return [];
  }
}

/**
 * §5.2 promotion threshold: a `@sem domain=` value becomes established
 * vocabulary once this many distinct entities carry it. Below it the tag is
 * provisional — a candidate that should either grow to the threshold or be
 * renamed onto an existing tag (prevents `auth` vs `authn` vs `authentication`
 * sprawl). Three is the smallest count that distinguishes a real domain from a
 * one-off typo without waiting so long that sprawl entrenches.
 */
export const PROMOTION_THRESHOLD = 3;

/** A near-duplicate `from` domain that should be consolidated into `into`. */
export interface VocabularyMergeHint {
  from: string;
  fromCount: number;
  into: string;
  intoCount: number;
}

/**
 * §5.2 / §6.4 vocabulary nudges. Splits the active domain tags into the
 * established set (`canonical`, count ≥ {@link PROMOTION_THRESHOLD}) and the
 * provisional set (1..threshold-1), and flags near-duplicate variants for
 * consolidation. Surfaced in the recon / `unerr_context` bundle so an agent
 * standardises on a canonical tag instead of minting a fourth spelling.
 */
export interface VocabularyNudges {
  /** Domains carried by ≥ {@link PROMOTION_THRESHOLD} entities — promoted. */
  canonical: DomainTagCount[];
  /** Domains carried by 1..threshold-1 entities — candidates awaiting promotion. */
  provisional: DomainTagCount[];
  /** Near-duplicate variant → canonical-or-higher-count consolidation target. */
  merge: VocabularyMergeHint[];
}

/** Length of the shared leading run between two strings. */
function commonPrefixLength(a: string, b: string): number {
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a[i] === b[i]) i++;
  return i;
}

/** Levenshtein edit distance (small inputs — domain tags are short). */
function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev: number[] = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const curr: number[] = [i];
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(
        (prev[j] ?? 0) + 1,
        (curr[j - 1] ?? 0) + 1,
        (prev[j - 1] ?? 0) + cost
      );
    }
    prev = curr;
  }
  return prev[n] ?? 0;
}

/**
 * Two domain tags are near-duplicate sprawl when one is a prefix of the other,
 * when they share a 4+ char stem, or when they are within edit distance 2 —
 * the shapes that produce `auth`/`authn`/`authentication`, `payment`/`payments`,
 * and `color`/`colour`. Both must be ≥3 chars so short distinct tags (`ui`/`ux`)
 * never collide.
 */
function areNearDuplicateDomains(a: string, b: string): boolean {
  if (a === b) return false;
  const x = a.toLowerCase();
  const y = b.toLowerCase();
  const short = x.length <= y.length ? x : y;
  const long = x.length <= y.length ? y : x;
  if (short.length < 3) return false;
  if (long.startsWith(short)) return true;
  if (commonPrefixLength(x, y) >= 4) return true;
  return Math.min(x.length, y.length) >= 4 && editDistance(x, y) <= 2;
}

/**
 * Cluster near-duplicate domain tags via union-find, then within each cluster
 * pick the highest-count member as the consolidation target. A non-target
 * member is hinted for merge only when it is dominated — strictly lower count
 * AND (still provisional OR within edit distance 2 of the target) — so two
 * established, genuinely distinct tags that merely share a stem (e.g.
 * `authentication`/`authorization`) are left alone.
 */
function buildMergeHints(tags: DomainTagCount[]): VocabularyMergeHint[] {
  const n = tags.length;
  const parent = Array.from({ length: n }, (_, i) => i);
  const find = (start: number): number => {
    let r = start;
    while (parent[r] !== r) r = parent[r] as number;
    // Path compression — point every node on the walk straight at the root.
    let node = start;
    while (parent[node] !== r) {
      const next = parent[node] as number;
      parent[node] = r;
      node = next;
    }
    return r;
  };
  for (let i = 0; i < n; i++) {
    const ti = tags[i];
    if (!ti) continue;
    for (let j = i + 1; j < n; j++) {
      const tj = tags[j];
      if (tj && areNearDuplicateDomains(ti.domain, tj.domain)) {
        parent[find(i)] = find(j);
      }
    }
  }
  const clusters = new Map<number, number[]>();
  for (let i = 0; i < n; i++) {
    const root = find(i);
    const members = clusters.get(root);
    if (members) members.push(i);
    else clusters.set(root, [i]);
  }
  const hints: VocabularyMergeHint[] = [];
  for (const members of clusters.values()) {
    if (members.length < 2) continue;
    // Consolidation target: highest count, ties broken by longest then alpha
    // (the fuller spelling is the better canonical form).
    const target = members.reduce((best, idx) => {
      const t = tags[idx];
      const b = tags[best];
      if (!t || !b) return best;
      if (t.count !== b.count) return t.count > b.count ? idx : best;
      if (t.domain.length !== b.domain.length)
        return t.domain.length > b.domain.length ? idx : best;
      return t.domain.localeCompare(b.domain) < 0 ? idx : best;
    }, members[0] as number);
    for (const idx of members) {
      if (idx === target) continue;
      const m = tags[idx];
      const into = tags[target];
      if (!m || !into) continue;
      const dominated =
        m.count < into.count &&
        (m.count < PROMOTION_THRESHOLD ||
          editDistance(m.domain.toLowerCase(), into.domain.toLowerCase()) <= 2);
      if (!dominated) continue;
      hints.push({
        from: m.domain,
        fromCount: m.count,
        into: into.domain,
        intoCount: into.count,
      });
    }
  }
  hints.sort(
    (a, b) => b.intoCount - a.intoCount || a.from.localeCompare(b.from)
  );
  return hints;
}

/**
 * §5.2 / §6.4: compute the vocabulary nudges from the active domain tags —
 * the canonical/provisional split at {@link PROMOTION_THRESHOLD} plus
 * near-duplicate merge hints. Best-effort: a read failure yields empty sets.
 */
export async function fetchVocabularyNudges(
  db: AnnotationDb
): Promise<VocabularyNudges> {
  const tags = await fetchActiveDomainTags(db);
  const canonical: DomainTagCount[] = [];
  const provisional: DomainTagCount[] = [];
  for (const t of tags) {
    if (t.count >= PROMOTION_THRESHOLD) canonical.push(t);
    else provisional.push(t);
  }
  return { canonical, provisional, merge: buildMergeHints(tags) };
}

/**
 * Attach serveable annotations onto search-result rows by key. A row with no
 * annotation is returned unchanged (identical to today); a row with one gains
 * `domain`/`role`/`summary`. Best-effort: a read failure returns the rows as-is
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
