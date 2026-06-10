/**
 * Sprint SC-A.3: indexer wiring — parse → gates → domain_annotations upsert.
 *
 * Pure helpers (collect/gate) plus a real in-memory CozoDB exercising the
 * upsert contract: provenance ordering, comment_hash no-write skip,
 * comment-edit update, deleted-entity removal, orphan prune.
 */

import { mkdirSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CozoDb } from "../intelligence/cozo-schema.js";
import { initSchema } from "../intelligence/cozo-schema.js";
import { indexFilesIncremental } from "../intelligence/incremental-indexer.js";
import { CozoGraphStore } from "../intelligence/local-graph.js";
import {
  COMMENT_SOURCE_CONFIDENCE,
  HARVESTED_SOURCE_CONFIDENCE,
  PATH_SOURCE_CONFIDENCE,
  PROMOTION_THRESHOLD,
  STALE_SUMMARY_SUFFIX,
  attachAnnotations,
  buildPathFloorRows,
  collectAnnotationCandidates,
  enumerateMissingAnnotationSites,
  fetchActiveDomainTags,
  fetchServeableAnnotations,
  fetchVocabularyNudges,
  gateCandidates,
  removeAnnotationsForKeys,
  removeOrphanedAnnotations,
  upsertAnnotations,
} from "../intelligence/semantic/annotation-indexer.js";

async function createTestDb(): Promise<CozoDb> {
  const cozoModule = await import("cozo-node");
  const CozoDbConstructor = (
    cozoModule as { default?: { CozoDb: unknown }; CozoDb?: unknown }
  ).default
    ? (cozoModule as { default: { CozoDb: unknown } }).default.CozoDb
    : (cozoModule as { CozoDb: unknown }).CozoDb;
  return new (CozoDbConstructor as any)("mem", "") as CozoDb;
}

const FIXTURE = `/**
 * Validates a session token against the active key set — the auth boundary
 * every inbound API call funnels through.
 * @sem domain=auth role=gateway stability=frozen
 */
export function validateToken(token: string) {}

function helper() {}
`;

const TARGETS = [
  { key: "e:validateToken", name: "validateToken", startLine: 6, endLine: 6 },
  { key: "e:helper", name: "helper", startLine: 8, endLine: 8 },
];

async function readAnnotation(db: CozoDb, key: string) {
  const result = await db.run(
    `?[summary, domain, role, extras, source, confidence, status, comment_hash, content_hash] :=
       *domain_annotations{entity_key: $key, summary, domain, role, extras, source, confidence, status, comment_hash, content_hash}`,
    { key }
  );
  if (result.rows.length === 0) return null;
  const r = result.rows[0]!;
  return {
    summary: r[0] as string,
    domain: r[1] as string,
    role: r[2] as string,
    extras: r[3] as string,
    source: r[4] as string,
    confidence: r[5] as number,
    status: r[6] as string,
    comment_hash: r[7] as string,
    content_hash: r[8] as string,
  };
}

describe("Annotation indexer wiring (SC-A.3)", () => {
  describe("collect + gate (pure)", () => {
    it("collects a candidate only for the entity with a doc comment", () => {
      const candidates = collectAnnotationCandidates(FIXTURE, TARGETS);
      expect(candidates).toHaveLength(1);
      expect(candidates[0]?.entityKey).toBe("e:validateToken");
      expect(candidates[0]?.contentHash).toMatch(/^[0-9a-f]{40}$/);
    });

    it("a plain prose comment above an entity IS a candidate (no sentinel)", () => {
      const source = `// Formats ledger rows for the nightly settlement export.
function formatRows() {}
`;
      const candidates = collectAnnotationCandidates(source, [
        { key: "e:formatRows", name: "formatRows", startLine: 2, endLine: 2 },
      ]);
      // A leading prose comment parses as a candidate; the gates decide
      // whether it survives.
      expect(candidates).toHaveLength(1);
      expect(candidates[0]?.parsed.sentinel).toBeNull();
    });

    it("gates candidates into rows with domain/role split out and extras as JSON", () => {
      const rows = gateCandidates(
        collectAnnotationCandidates(FIXTURE, TARGETS)
      );
      const row = rows.find((r) => r.entity_key === "e:validateToken");
      expect(row?.domain).toBe("auth");
      expect(row?.role).toBe("gateway");
      expect(JSON.parse(row?.extras ?? "{}")).toEqual({ stability: "frozen" });
      expect(row?.source).toBe("comment");
      expect(row?.confidence).toBeCloseTo(COMMENT_SOURCE_CONFIDENCE);
    });

    it("applies the identifier gate's confidence multiplier", () => {
      const source = `// Reconciles rows produced by exportLedgerRows nightly.
// @sem domain=payments
function reconcile() {}
`;
      const rows = gateCandidates(
        collectAnnotationCandidates(source, [
          { key: "e:reconcile", name: "reconcile", startLine: 3, endLine: 3 },
        ]),
        { knownIdentifiers: new Set(["reconcile"]) }
      );
      expect(rows[0]?.confidence).toBeCloseTo(0.95 * 0.7);
    });

    it("drops a candidate where neither prose nor pairs survive the gates", () => {
      const source = `// Process payment.
function processPayment() {}
`;
      const rows = gateCandidates(
        collectAnnotationCandidates(source, [
          {
            key: "e:processPayment",
            name: "processPayment",
            startLine: 2,
            endLine: 2,
          },
        ])
      );
      expect(rows).toHaveLength(0);
    });
  });

  describe("harvest + path floor (SC-A.5)", () => {
    it("prose without a sentinel gates to source=harvested at 0.7", () => {
      const source = `// Formats ledger rows for the nightly settlement export.
function formatRows() {}
`;
      const rows = gateCandidates(
        collectAnnotationCandidates(source, [
          { key: "e:formatRows", name: "formatRows", startLine: 2, endLine: 2 },
        ])
      );
      expect(rows[0]?.source).toBe("harvested");
      expect(rows[0]?.confidence).toBeCloseTo(HARVESTED_SOURCE_CONFIDENCE);
    });

    it("a sentinel-bearing comment gates to source=comment at 0.95", () => {
      const rows = gateCandidates(
        collectAnnotationCandidates(FIXTURE, TARGETS)
      );
      expect(rows[0]?.source).toBe("comment");
      expect(rows[0]?.confidence).toBeCloseTo(COMMENT_SOURCE_CONFIDENCE);
    });

    it("builds path-floor rows only for domain-matching paths", () => {
      const rows = buildPathFloorRows([
        { key: "e:a", file_path: "src/auth/token.ts" },
        { key: "e:b", file_path: "src/zebra/run.ts" },
      ]);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.entity_key).toBe("e:a");
      expect(rows[0]?.domain).toBe("authentication");
      expect(rows[0]?.source).toBe("path");
      expect(rows[0]?.confidence).toBe(PATH_SOURCE_CONFIDENCE);
      expect(rows[0]?.summary).toBe("");
    });
  });

  describe("upsert contract (real CozoDB)", () => {
    let db: CozoDb;

    beforeEach(async () => {
      db = await createTestDb();
      await initSchema(db);
    });

    it("writes a fresh row with status active", async () => {
      const rows = gateCandidates(
        collectAnnotationCandidates(FIXTURE, TARGETS)
      );
      const written = await upsertAnnotations(db, rows);
      expect(written).toBe(1);
      const row = await readAnnotation(db, "e:validateToken");
      expect(row?.summary).toContain("auth boundary");
      expect(row?.status).toBe("active");
      expect(row?.source).toBe("comment");
    });

    it("unchanged comment → second upsert is a no-write", async () => {
      const rows = gateCandidates(
        collectAnnotationCandidates(FIXTURE, TARGETS)
      );
      await upsertAnnotations(db, rows);
      const second = await upsertAnnotations(db, rows);
      expect(second).toBe(0);
    });

    it("edited comment → row updates with a new comment_hash", async () => {
      const rows = gateCandidates(
        collectAnnotationCandidates(FIXTURE, TARGETS)
      );
      await upsertAnnotations(db, rows);
      const before = await readAnnotation(db, "e:validateToken");

      const edited = FIXTURE.replace("role=gateway", "role=validator");
      const editedRows = gateCandidates(
        collectAnnotationCandidates(edited, TARGETS)
      );
      const written = await upsertAnnotations(db, editedRows);
      expect(written).toBe(1);

      const after = await readAnnotation(db, "e:validateToken");
      expect(after?.role).toBe("validator");
      expect(after?.comment_hash).not.toBe(before?.comment_hash);
    });

    it("comment tier overwrites a lower-tier (path) row", async () => {
      await db.run(
        `?[entity_key, domain, source, confidence] <- [["e:validateToken", "misc", "path", 0.4]]
         :put domain_annotations {entity_key => domain, source, confidence}`,
        {}
      );
      const rows = gateCandidates(
        collectAnnotationCandidates(FIXTURE, TARGETS)
      );
      const written = await upsertAnnotations(db, rows);
      expect(written).toBe(1);
      const row = await readAnnotation(db, "e:validateToken");
      expect(row?.source).toBe("comment");
      expect(row?.domain).toBe("auth");
    });

    it("a rewritten comment re-activates a stale row", async () => {
      const rows = gateCandidates(
        collectAnnotationCandidates(FIXTURE, TARGETS)
      );
      await upsertAnnotations(db, rows);
      await db.run(
        `existing[entity_key, summary, domain, role, extras, source, confidence, comment_hash, content_hash, computed_at] :=
           *domain_annotations{entity_key, summary, domain, role, extras, source, confidence, comment_hash, content_hash, computed_at}
         ?[entity_key, summary, domain, role, extras, source, confidence, status, comment_hash, content_hash, computed_at] :=
           existing[entity_key, summary, domain, role, extras, source, confidence, comment_hash, content_hash, computed_at],
           status = "stale"
         :put domain_annotations {entity_key => summary, domain, role, extras, source, confidence, status, comment_hash, content_hash, computed_at}`,
        {}
      );

      const edited = FIXTURE.replace(
        "auth boundary",
        "rewritten auth boundary"
      );
      const editedRows = gateCandidates(
        collectAnnotationCandidates(edited, TARGETS)
      );
      await upsertAnnotations(db, editedRows);
      const row = await readAnnotation(db, "e:validateToken");
      expect(row?.status).toBe("active");
      expect(row?.summary).toContain("rewritten");
    });

    // ── §5.1 comment-drift predicate (SC-C.1) ──────────────────────
    // The doc's gate: edit the body without the comment → stale; edit both → active.
    const BODY = "export function validateToken(token: string) {}";
    const EDITED_BODY =
      "export function validateToken(token: string) { return token; }";

    it("edit body without the comment → annotation goes stale", async () => {
      const rows = gateCandidates(
        collectAnnotationCandidates(FIXTURE, TARGETS)
      );
      await upsertAnnotations(db, rows);
      const before = await readAnnotation(db, "e:validateToken");
      expect(before?.status).toBe("active");

      // Body moves (content_hash changes); the @sem comment is byte-identical
      // (comment_hash unchanged) → the doc now predates the code.
      const edited = FIXTURE.replace(BODY, EDITED_BODY);
      const editedRows = gateCandidates(
        collectAnnotationCandidates(edited, TARGETS)
      );
      const written = await upsertAnnotations(db, editedRows);
      expect(written).toBe(1);

      const after = await readAnnotation(db, "e:validateToken");
      expect(after?.status).toBe("stale");
      // The comment fingerprint is unchanged; only the body hash moved.
      expect(after?.comment_hash).toBe(before?.comment_hash);
      expect(after?.content_hash).not.toBe(before?.content_hash);
    });

    it("edit body AND comment in the same pass → annotation stays active", async () => {
      const rows = gateCandidates(
        collectAnnotationCandidates(FIXTURE, TARGETS)
      );
      await upsertAnnotations(db, rows);

      // Both the body and the @sem line move — the maintenance contract was
      // honored, so the doc tracks the code: never stale.
      const edited = FIXTURE.replace(BODY, EDITED_BODY).replace(
        "role=gateway",
        "role=validator"
      );
      const editedRows = gateCandidates(
        collectAnnotationCandidates(edited, TARGETS)
      );
      const written = await upsertAnnotations(db, editedRows);
      expect(written).toBe(1);

      const after = await readAnnotation(db, "e:validateToken");
      expect(after?.status).toBe("active");
      expect(after?.role).toBe("validator");
    });

    it("a stale annotation re-indexed unchanged is a no-write — fires once per episode", async () => {
      const rows = gateCandidates(
        collectAnnotationCandidates(FIXTURE, TARGETS)
      );
      await upsertAnnotations(db, rows);
      const edited = FIXTURE.replace(BODY, EDITED_BODY);
      const editedRows = gateCandidates(
        collectAnnotationCandidates(edited, TARGETS)
      );
      // First drift detection writes the stale row.
      expect(await upsertAnnotations(db, editedRows)).toBe(1);
      // The same (still-drifted) body re-indexes to a byte-identical row → no
      // re-write, so the C.2 nudge has a single staleness episode to dedup on.
      expect(await upsertAnnotations(db, editedRows)).toBe(0);
      expect((await readAnnotation(db, "e:validateToken"))?.status).toBe(
        "stale"
      );
    });

    it("rewriting the comment after drift clears the stale flag", async () => {
      const rows = gateCandidates(
        collectAnnotationCandidates(FIXTURE, TARGETS)
      );
      await upsertAnnotations(db, rows);
      const drifted = FIXTURE.replace(BODY, EDITED_BODY);
      await upsertAnnotations(
        db,
        gateCandidates(collectAnnotationCandidates(drifted, TARGETS))
      );
      expect((await readAnnotation(db, "e:validateToken"))?.status).toBe(
        "stale"
      );

      // The agent updates the prose to match the new body → comment_hash moves
      // → the row re-activates on the next parse.
      const reconciled = drifted.replace("auth boundary", "rewritten boundary");
      await upsertAnnotations(
        db,
        gateCandidates(collectAnnotationCandidates(reconciled, TARGETS))
      );
      expect((await readAnnotation(db, "e:validateToken"))?.status).toBe(
        "active"
      );
    });

    it("a body-only edit of a harvested (no-sentinel) docstring also drifts", async () => {
      const source = `// Formats ledger rows for the nightly settlement export.
function formatRows() {}
`;
      const targets = [
        { key: "e:formatRows", name: "formatRows", startLine: 2, endLine: 2 },
      ];
      await upsertAnnotations(
        db,
        gateCandidates(collectAnnotationCandidates(source, targets))
      );
      const before = await readAnnotation(db, "e:formatRows");
      expect(before?.source).toBe("harvested");
      expect(before?.status).toBe("active");

      const edited = source.replace(
        "function formatRows() {}",
        "function formatRows() { return []; }"
      );
      await upsertAnnotations(
        db,
        gateCandidates(collectAnnotationCandidates(edited, targets))
      );
      expect((await readAnnotation(db, "e:formatRows"))?.status).toBe("stale");
    });

    it("a path-floor row (empty comment_hash) never drifts", async () => {
      await upsertAnnotations(
        db,
        buildPathFloorRows([{ key: "e:p", file_path: "src/auth/a.ts" }])
      );
      // Path rows carry empty hashes; a re-inferred domain still lands active,
      // never stale (no comment to predate).
      const written = await upsertAnnotations(
        db,
        buildPathFloorRows([{ key: "e:p", file_path: "src/billing/a.ts" }])
      );
      expect(written).toBe(1);
      expect((await readAnnotation(db, "e:p"))?.status).toBe("active");
    });

    // The exact join `extractCommentDriftMeta` (query-router) runs to feed the
    // SC-C.2 nudge. Validated against a real CozoDB so a join quirk (the
    // by-name-index pitfall) can't silently return [].
    it("the comment-drift detection join returns name + file:line for a stale row (SC-C.2)", async () => {
      await db.run(
        `?[key, kind, name, file_path, start_line] <- [["e:vt", "function", "validateToken", "src/auth/token.ts", 41]]
         :put entities {key => kind, name, file_path, start_line}`,
        {}
      );
      await db.run(
        `?[entity_key, domain, source, confidence, status] <- [["e:vt", "auth", "comment", 0.95, "stale"]]
         :put domain_annotations {entity_key => domain, source, confidence, status}`,
        {}
      );
      const res = await db.run(
        `?[name, file_path, start_line] :=
           *domain_annotations{entity_key: $key, status: "stale"},
           *entities{key: $key, name, file_path, start_line}`,
        { key: "e:vt" }
      );
      expect(res.rows.length).toBe(1);
      expect(res.rows[0]).toEqual(["validateToken", "src/auth/token.ts", 41]);
    });

    it("the comment-drift detection join is empty for an active annotation", async () => {
      await db.run(
        `?[key, kind, name, file_path, start_line] <- [["e:vt", "function", "validateToken", "src/auth/token.ts", 41]]
         :put entities {key => kind, name, file_path, start_line}`,
        {}
      );
      await db.run(
        `?[entity_key, domain, source, confidence, status] <- [["e:vt", "auth", "comment", 0.95, "active"]]
         :put domain_annotations {entity_key => domain, source, confidence, status}`,
        {}
      );
      const res = await db.run(
        `?[name] :=
           *domain_annotations{entity_key: $key, status: "stale"},
           *entities{key: $key, name}`,
        { key: "e:vt" }
      );
      expect(res.rows.length).toBe(0);
    });

    it("a path-floor row never overwrites a higher-tier row", async () => {
      const rows = gateCandidates(
        collectAnnotationCandidates(FIXTURE, TARGETS)
      );
      await upsertAnnotations(db, rows);
      const floored = await upsertAnnotations(
        db,
        buildPathFloorRows([
          { key: "e:validateToken", file_path: "src/auth/token.ts" },
        ])
      );
      expect(floored).toBe(0);
      const row = await readAnnotation(db, "e:validateToken");
      expect(row?.source).toBe("comment");
    });

    it("a path-floor row writes for an unannotated entity, and re-runs are no-writes", async () => {
      const pathRows = buildPathFloorRows([
        { key: "e:bare", file_path: "src/auth/session.ts" },
      ]);
      expect(await upsertAnnotations(db, pathRows)).toBe(1);
      expect(await upsertAnnotations(db, pathRows)).toBe(0);
      const row = await readAnnotation(db, "e:bare");
      expect(row?.source).toBe("path");
      expect(row?.domain).toBe("authentication");
    });

    it("a path row updates when the inferred domain changes", async () => {
      await upsertAnnotations(
        db,
        buildPathFloorRows([{ key: "e:moved", file_path: "src/auth/x.ts" }])
      );
      const written = await upsertAnnotations(
        db,
        buildPathFloorRows([{ key: "e:moved", file_path: "src/billing/x.ts" }])
      );
      expect(written).toBe(1);
      const row = await readAnnotation(db, "e:moved");
      expect(row?.domain).toBe("payments");
    });

    it("removeAnnotationsForKeys deletes only the named keys", async () => {
      const rows = gateCandidates(
        collectAnnotationCandidates(FIXTURE, TARGETS)
      );
      await upsertAnnotations(db, rows);
      await removeAnnotationsForKeys(db, ["e:somebody-else"]);
      expect(await readAnnotation(db, "e:validateToken")).not.toBeNull();
      await removeAnnotationsForKeys(db, ["e:validateToken"]);
      expect(await readAnnotation(db, "e:validateToken")).toBeNull();
    });

    it("removeOrphanedAnnotations prunes rows for vanished entities", async () => {
      const rows = gateCandidates(
        collectAnnotationCandidates(FIXTURE, TARGETS)
      );
      await upsertAnnotations(db, rows);
      await removeOrphanedAnnotations(db, new Set(["e:other"]));
      expect(await readAnnotation(db, "e:validateToken")).toBeNull();
    });
  });

  describe("serve path — attachAnnotations / fetchServeableAnnotations (SC-B.3)", () => {
    let db: CozoDb;

    beforeEach(async () => {
      db = await createTestDb();
      await initSchema(db);
      // A comment-tier annotation (summary + domain + role) and a path-floor
      // row (domain only, empty summary) to cover both serve shapes.
      await upsertAnnotations(
        db,
        gateCandidates(collectAnnotationCandidates(FIXTURE, TARGETS))
      );
      await upsertAnnotations(
        db,
        buildPathFloorRows([
          { key: "e:bare", file_path: "src/auth/session.ts" },
        ])
      );
    });

    it("attaches domain/role/summary to an annotated hit", async () => {
      const enriched = await attachAnnotations(db, [
        { key: "e:validateToken", name: "validateToken", score: 1 },
      ]);
      expect(enriched[0]?.domain).toBe("auth");
      expect(enriched[0]?.role).toBe("gateway");
      expect(enriched[0]?.summary).toContain("auth boundary");
    });

    it("leaves an un-annotated hit unchanged (no domain/role/summary keys)", async () => {
      const enriched = await attachAnnotations(db, [
        { key: "e:no-annotation", name: "misc", score: 1 },
      ]);
      expect(enriched[0]).toEqual({
        key: "e:no-annotation",
        name: "misc",
        score: 1,
      });
    });

    it("attaches domain only for a path-floor row (no summary key)", async () => {
      const enriched = await attachAnnotations(db, [
        { key: "e:bare", name: "bare", score: 1 },
      ]);
      expect(enriched[0]?.domain).toBe("authentication");
      expect(enriched[0]).not.toHaveProperty("summary");
      expect(enriched[0]).not.toHaveProperty("role");
    });

    it("serves a stale annotation with the degrade-never-lie suffix + stale flag (SC-C.3)", async () => {
      await db.run(
        `?[entity_key, summary, domain, role, source, confidence, status] <- [["e:stale", "Validates the inbound token.", "auth", "gateway", "comment", 0.95, "stale"]]
         :put domain_annotations {entity_key => summary, domain, role, source, confidence, status}`,
        {}
      );
      const map = await fetchServeableAnnotations(db, ["e:stale"]);
      const ann = map.get("e:stale");
      // Degrades, never lies: still served, but the summary carries the marker
      // and the structured stale flag rides for any downweighting consumer.
      expect(ann?.stale).toBe(true);
      expect(ann?.summary).toBe(
        `Validates the inbound token.${STALE_SUMMARY_SUFFIX}`
      );
      expect(ann?.domain).toBe("auth");
      expect(ann?.role).toBe("gateway");
    });

    it("a stale domain-only row serves the domain + stale flag, no spurious suffix", async () => {
      await db.run(
        `?[entity_key, domain, source, confidence, status] <- [["e:stalebare", "auth", "path", 0.4, "stale"]]
         :put domain_annotations {entity_key => domain, source, confidence, status}`,
        {}
      );
      const ann = (await fetchServeableAnnotations(db, ["e:stalebare"])).get(
        "e:stalebare"
      );
      expect(ann?.stale).toBe(true);
      expect(ann?.domain).toBe("auth");
      expect(ann).not.toHaveProperty("summary");
    });

    it("attachAnnotations carries the stale suffix + flag onto a search hit (SC-C.3)", async () => {
      await db.run(
        `?[entity_key, summary, domain, source, confidence, status] <- [["e:vt2", "Reconciles the ledger.", "payments", "comment", 0.95, "stale"]]
         :put domain_annotations {entity_key => summary, domain, source, confidence, status}`,
        {}
      );
      const enriched = await attachAnnotations(db, [
        { key: "e:vt2", name: "reconcile", score: 1 },
      ]);
      expect(enriched[0]?.stale).toBe(true);
      expect(enriched[0]?.summary).toBe(
        `Reconciles the ledger.${STALE_SUMMARY_SUFFIX}`
      );
    });

    it("an active annotation never carries the stale flag or suffix", async () => {
      const ann = (
        await fetchServeableAnnotations(db, ["e:validateToken"])
      ).get("e:validateToken");
      expect(ann?.stale).toBeUndefined();
      expect(ann?.summary).not.toContain("may be outdated");
    });

    it("empty input → empty output, never throws", async () => {
      expect(await attachAnnotations(db, [])).toEqual([]);
      expect((await fetchServeableAnnotations(db, [])).size).toBe(0);
    });
  });

  describe("active tag vocabulary — fetchActiveDomainTags (SC-B.4)", () => {
    let db: CozoDb;

    beforeEach(async () => {
      db = await createTestDb();
      await initSchema(db);
      // Three entities on `auth`, two on `payments`, one stale `auth` row, and
      // one empty-domain row — counts must rank by active entity count.
      await db.run(
        `?[entity_key, domain, source, confidence, status] <- [
           ["e:a1", "auth", "comment", 0.95, "active"],
           ["e:a2", "auth", "comment", 0.95, "active"],
           ["e:a3", "auth", "harvested", 0.7, "active"],
           ["e:p1", "payments", "comment", 0.95, "active"],
           ["e:p2", "payments", "comment", 0.95, "active"],
           ["e:s1", "auth", "comment", 0.95, "stale"],
           ["e:e1", "", "path", 0.4, "active"]
         ]
         :put domain_annotations {entity_key => domain, source, confidence, status}`,
        {}
      );
    });

    it("ranks active tags by entity count, excludes stale + empty domains", async () => {
      const tags = await fetchActiveDomainTags(db);
      expect(tags).toEqual([
        { domain: "auth", count: 3 },
        { domain: "payments", count: 2 },
      ]);
    });

    it("returns [] on a fresh schema with no annotations (never throws)", async () => {
      const fresh = await createTestDb();
      await initSchema(fresh);
      expect(await fetchActiveDomainTags(fresh)).toEqual([]);
    });
  });

  describe("backfill site enumerator — enumerateMissingAnnotationSites (SC-E.1)", () => {
    let db: CozoDb;

    beforeEach(async () => {
      db = await createTestDb();
      await initSchema(db);
      // Five entities with descending fan_in. a1 has a durable comment
      // annotation, a2 only a propagated (inferred) one, a3/a4 none, a5 is a
      // leaf (fan_in 0). Expect a2,a3,a4 as sites ranked by fan_in; a1 excluded
      // (durable), a5 excluded (leaf).
      await db.run(
        `?[key, kind, name, file_path, fan_in] <- [
           ["e:a1", "function", "login", "src/auth/login.ts", 30],
           ["e:a2", "function", "charge", "src/pay/charge.ts", 20],
           ["e:a3", "function", "refund", "src/pay/refund.ts", 12],
           ["e:a4", "function", "logout", "src/auth/logout.ts", 5],
           ["e:a5", "function", "helper", "src/util/helper.ts", 0]
         ]
         :put entities {key => kind, name, file_path, fan_in}`,
        {}
      );
      await db.run(
        `?[entity_key, domain, source, confidence, status] <- [
           ["e:a1", "auth", "comment", 0.95, "active"],
           ["e:a2", "payments", "propagated", 0.6, "active"]
         ]
         :put domain_annotations {entity_key => domain, source, confidence, status}`,
        {}
      );
    });

    it("ranks durable-annotation-free entities by fan_in; excludes durable + leaves", async () => {
      const sites = await enumerateMissingAnnotationSites(db);
      expect(sites).toEqual([
        { key: "e:a2", name: "charge", file: "src/pay/charge.ts", fan_in: 20 },
        { key: "e:a3", name: "refund", file: "src/pay/refund.ts", fan_in: 12 },
        { key: "e:a4", name: "logout", file: "src/auth/logout.ts", fan_in: 5 },
      ]);
    });

    it("honours the limit (highest fan_in first)", async () => {
      const sites = await enumerateMissingAnnotationSites(db, 1);
      expect(sites).toEqual([
        { key: "e:a2", name: "charge", file: "src/pay/charge.ts", fan_in: 20 },
      ]);
    });

    it("counts a harvested annotation as durable coverage", async () => {
      await db.run(
        `?[entity_key, domain, source, confidence, status] <- [
           ["e:a3", "payments", "harvested", 0.7, "active"]
         ]
         :put domain_annotations {entity_key => domain, source, confidence, status}`,
        {}
      );
      const sites = await enumerateMissingAnnotationSites(db);
      expect(sites.map((s) => s.key)).toEqual(["e:a2", "e:a4"]);
    });

    it("returns [] on a fresh schema (never throws)", async () => {
      const fresh = await createTestDb();
      await initSchema(fresh);
      expect(await enumerateMissingAnnotationSites(fresh)).toEqual([]);
    });
  });

  describe("vocabulary nudges — fetchVocabularyNudges (SC-C.4)", () => {
    let db: CozoDb;

    // n distinct active entities all carrying `domain` — the smallest fixture
    // for exercising the promotion threshold and sprawl clustering.
    async function seedDomain(
      database: CozoDb,
      domain: string,
      n: number
    ): Promise<void> {
      const rows = Array.from(
        { length: n },
        (_, i) => `["e:${domain}-${i}", "${domain}", "comment", 0.95, "active"]`
      ).join(",\n");
      await database.run(
        `?[entity_key, domain, source, confidence, status] <- [${rows}]
         :put domain_annotations {entity_key => domain, source, confidence, status}`,
        {}
      );
    }

    beforeEach(async () => {
      db = await createTestDb();
      await initSchema(db);
    });

    it("promotes a domain at the threshold; one below stays provisional", async () => {
      await seedDomain(db, "payments", PROMOTION_THRESHOLD); // exactly 3 → promoted
      await seedDomain(db, "draft", PROMOTION_THRESHOLD - 1); // 2 → provisional

      const { canonical, provisional, merge } = await fetchVocabularyNudges(db);
      expect(canonical).toEqual([{ domain: "payments", count: 3 }]);
      expect(provisional).toEqual([{ domain: "draft", count: 2 }]);
      // `draft`/`payments` are not near-duplicates — nothing to consolidate.
      expect(merge).toEqual([]);
    });

    it("flags a sub-threshold near-duplicate to consolidate into the canonical spelling", async () => {
      await seedDomain(db, "authentication", 5);
      await seedDomain(db, "authn", 2);

      const { merge } = await fetchVocabularyNudges(db);
      expect(merge).toEqual([
        { from: "authn", fromCount: 2, into: "authentication", intoCount: 5 },
      ]);
    });

    it("leaves two established, genuinely distinct tags that merely share a stem alone", async () => {
      // `authentication` and `authorization` share the `auth` stem but are both
      // promoted and far apart in edit distance — not sprawl, no merge hint.
      await seedDomain(db, "authentication", 5);
      await seedDomain(db, "authorization", 4);

      const { canonical, merge } = await fetchVocabularyNudges(db);
      expect(canonical).toEqual([
        { domain: "authentication", count: 5 },
        { domain: "authorization", count: 4 },
      ]);
      expect(merge).toEqual([]);
    });

    it("returns empty sets on a fresh schema (never throws)", async () => {
      const fresh = await createTestDb();
      await initSchema(fresh);
      expect(await fetchVocabularyNudges(fresh)).toEqual({
        canonical: [],
        provisional: [],
        merge: [],
      });
    });
  });

  describe("end-to-end through indexFilesIncremental", () => {
    const REPO_ID = "annotrepo";
    let tempDir: string;
    let store: CozoGraphStore;

    async function createStore(): Promise<CozoGraphStore> {
      const graphDb = await createTestDb();
      await initSchema(graphDb);
      return CozoGraphStore.create(graphDb);
    }

    /** Annotation row joined to the live entity by name. */
    async function annotationByName(name: string) {
      const result = await store.db.run(
        `?[summary, domain, role] := *entities{key, name: $name},
           *domain_annotations{entity_key: key, summary, domain, role}`,
        { name }
      );
      if (result.rows.length === 0) return null;
      const r = result.rows[0]!;
      return {
        summary: r[0] as string,
        domain: r[1] as string,
        role: r[2] as string,
      };
    }

    async function annotationCount(): Promise<number> {
      const result = await store.db.run(
        "?[count(entity_key)] := *domain_annotations{entity_key}"
      );
      return Number((result.rows[0]?.[0] as number | undefined) ?? 0);
    }

    beforeEach(async () => {
      tempDir = join(
        tmpdir(),
        `unerr-annot-${Date.now()}-${Math.random().toString(36).slice(2)}`
      );
      mkdirSync(tempDir, { recursive: true });
      store = await createStore();
    });

    afterEach(() => {
      rmSync(tempDir, { recursive: true, force: true });
    });

    it("indexing a file with an @sem comment writes a domain annotation", async () => {
      writeFileSync(join(tempDir, "auth.ts"), FIXTURE);
      await indexFilesIncremental(tempDir, ["auth.ts"], store, REPO_ID);

      const row = await annotationByName("validateToken");
      expect(row?.domain).toBe("auth");
      expect(row?.role).toBe("gateway");
      expect(row?.summary).toContain("auth boundary");
    });

    it("a comment-text edit with no line shift still updates the annotation", async () => {
      writeFileSync(join(tempDir, "auth.ts"), FIXTURE);
      await indexFilesIncremental(tempDir, ["auth.ts"], store, REPO_ID);

      // Same line count, same entity positions — the entity diff is empty,
      // but the annotation must update (Step 4.5 runs before the early skip).
      writeFileSync(
        join(tempDir, "auth.ts"),
        FIXTURE.replace("role=gateway", "role=validator")
      );
      await indexFilesIncremental(tempDir, ["auth.ts"], store, REPO_ID);

      const row = await annotationByName("validateToken");
      expect(row?.role).toBe("validator");
    });

    it("a fresh index populates all three provenance tiers correctly", async () => {
      // File name matches the auth path pattern → uncommented entities get
      // the path floor; commented ones get comment/harvested tiers.
      const source = `/**
 * Validates a session token against the active key set — the auth boundary
 * every inbound API call funnels through.
 * @sem domain=auth role=gateway
 */
export function validateToken(token: string) {}

// Rotates the signing key pair against the provider schedule nightly.
export function rotateKeys() {}

export function bareHelper() {}
`;
      writeFileSync(join(tempDir, "auth.ts"), source);
      await indexFilesIncremental(tempDir, ["auth.ts"], store, REPO_ID);

      const bySource = async (name: string) => {
        const result = await store.db.run(
          `?[source, confidence] := *entities{key, name: $name},
             *domain_annotations{entity_key: key, source, confidence}`,
          { name }
        );
        const r = result.rows[0];
        return r
          ? { source: r[0] as string, confidence: r[1] as number }
          : null;
      };

      expect(await bySource("validateToken")).toEqual({
        source: "comment",
        confidence: 0.95,
      });
      expect(await bySource("rotateKeys")).toEqual({
        source: "harvested",
        confidence: 0.7,
      });
      expect(await bySource("bareHelper")).toEqual({
        source: "path",
        confidence: 0.4,
      });
    });

    it("deleting the file removes its annotation rows", async () => {
      writeFileSync(join(tempDir, "auth.ts"), FIXTURE);
      await indexFilesIncremental(tempDir, ["auth.ts"], store, REPO_ID);
      expect(await annotationCount()).toBeGreaterThan(0);

      unlinkSync(join(tempDir, "auth.ts"));
      await indexFilesIncremental(tempDir, ["auth.ts"], store, REPO_ID);
      expect(await annotationCount()).toBe(0);
    });

    /** Provenance source of the annotation joined to the live entity by name. */
    async function sourceByName(name: string): Promise<string | null> {
      const result = await store.db.run(
        `?[source] := *entities{key, name: $name},
           *domain_annotations{entity_key: key, source}`,
        { name }
      );
      return (result.rows[0]?.[0] as string | undefined) ?? null;
    }

    it("deleting the @sem comment reconciles the stale comment-tier row to the path floor", async () => {
      writeFileSync(join(tempDir, "auth.ts"), FIXTURE);
      await indexFilesIncremental(tempDir, ["auth.ts"], store, REPO_ID);
      expect(await sourceByName("validateToken")).toBe("comment");

      // Strip the whole doc comment (prose + @sem). The entity body survives in
      // place, so it never lands in `deleted`; without reconciliation its prior
      // comment row (0.95) tier-guards out the path floor (0.4) and lingers.
      const stripped = FIXTURE.replace(/\/\*\*[\s\S]*?\*\/\n/, "");
      writeFileSync(join(tempDir, "auth.ts"), stripped);
      const result = await indexFilesIncremental(
        tempDir,
        ["auth.ts"],
        store,
        REPO_ID
      );

      // auth.ts matches the auth path pattern → it downgrades to the floor, and
      // the change is signalled so the debounced domain re-derive fires.
      expect(await sourceByName("validateToken")).toBe("path");
      expect(result.annotationsChanged).toBe(true);
    });

    it("removing only the @sem line (prose kept) downgrades comment → harvested, not a lingering comment tier", async () => {
      writeFileSync(join(tempDir, "auth.ts"), FIXTURE);
      await indexFilesIncremental(tempDir, ["auth.ts"], store, REPO_ID);
      expect(await sourceByName("validateToken")).toBe("comment");

      // Strip just the sentinel line. The prose docstring remains → a harvested
      // (0.7) candidate, which the tier guard would block from overwriting the
      // prior comment (0.95). Reconciliation must delete the stale comment row
      // so the harvested row lands and the auth domain label is dropped.
      const stripped = FIXTURE.replace(/^ \* @sem.*\n/m, "");
      writeFileSync(join(tempDir, "auth.ts"), stripped);
      const result = await indexFilesIncremental(
        tempDir,
        ["auth.ts"],
        store,
        REPO_ID
      );

      expect(await sourceByName("validateToken")).toBe("harvested");
      expect((await annotationByName("validateToken"))?.domain).toBe("");
      expect(result.annotationsChanged).toBe(true);
    });

    it("an unchanged @sem comment is not flagged stale (no needless re-derive)", async () => {
      writeFileSync(join(tempDir, "auth.ts"), FIXTURE);
      await indexFilesIncremental(tempDir, ["auth.ts"], store, REPO_ID);

      // Re-index the identical file: the comment is byte-identical, so the
      // reconciliation must NOT delete it and annotationsChanged stays false.
      const result = await indexFilesIncremental(
        tempDir,
        ["auth.ts"],
        store,
        REPO_ID
      );
      expect(await sourceByName("validateToken")).toBe("comment");
      expect(result.annotationsChanged).toBe(false);
    });
  });
});
