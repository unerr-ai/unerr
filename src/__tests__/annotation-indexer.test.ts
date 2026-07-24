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
  HARVESTED_SOURCE_CONFIDENCE,
  PATH_SOURCE_CONFIDENCE,
  STALE_SUMMARY_SUFFIX,
  attachAnnotations,
  buildPathFloorRows,
  collectAnnotationCandidates,
  fetchServeableAnnotations,
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
 */
export function validateToken(token: string) {}

function helper() {}
`;

const TARGETS = [
  { key: "e:validateToken", name: "validateToken", startLine: 5, endLine: 5 },
  { key: "e:helper", name: "helper", startLine: 7, endLine: 7 },
];

async function readAnnotation(db: CozoDb, key: string) {
  const result = await db.run(
    `?[summary, domain, source, confidence, status, comment_hash, content_hash] :=
       *domain_annotations{entity_key: $key, summary, domain, source, confidence, status, comment_hash, content_hash}`,
    { key }
  );
  if (result.rows.length === 0) return null;
  const r = result.rows[0]!;
  return {
    summary: r[0] as string,
    domain: r[1] as string,
    source: r[2] as string,
    confidence: r[3] as number,
    status: r[4] as string,
    comment_hash: r[5] as string,
    content_hash: r[6] as string,
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

    it("a plain prose comment above an entity IS a candidate", () => {
      const source = `// Formats ledger rows for the nightly settlement export.
function formatRows() {}
`;
      const candidates = collectAnnotationCandidates(source, [
        { key: "e:formatRows", name: "formatRows", startLine: 2, endLine: 2 },
      ]);
      expect(candidates).toHaveLength(1);
      expect(candidates[0]?.parsed.prose).toContain("Formats ledger rows");
    });

    it("gates a plain prose comment into a harvested row with an empty domain", () => {
      const rows = gateCandidates(
        collectAnnotationCandidates(FIXTURE, TARGETS)
      );
      const row = rows.find((r) => r.entity_key === "e:validateToken");
      expect(row?.summary).toContain("auth boundary");
      expect(row?.domain).toBe("");
      expect(row?.source).toBe("harvested");
      expect(row?.confidence).toBeCloseTo(HARVESTED_SOURCE_CONFIDENCE);
    });

    it("applies the identifier gate's confidence multiplier", () => {
      const source = `// Reconciles rows produced by exportLedgerRows nightly.
function reconcile() {}
`;
      const rows = gateCandidates(
        collectAnnotationCandidates(source, [
          { key: "e:reconcile", name: "reconcile", startLine: 2, endLine: 2 },
        ]),
        { knownIdentifiers: new Set(["reconcile"]) }
      );
      expect(rows[0]?.confidence).toBeCloseTo(
        HARVESTED_SOURCE_CONFIDENCE * 0.7
      );
    });

    it("drops a candidate whose prose fails the gates (tautology)", () => {
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
      expect(row?.source).toBe("harvested");
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

      const edited = FIXTURE.replace("auth boundary", "security boundary");
      const editedRows = gateCandidates(
        collectAnnotationCandidates(edited, TARGETS)
      );
      const written = await upsertAnnotations(db, editedRows);
      expect(written).toBe(1);

      const after = await readAnnotation(db, "e:validateToken");
      expect(after?.summary).toContain("security boundary");
      expect(after?.comment_hash).not.toBe(before?.comment_hash);
    });

    it("harvested tier overwrites a lower-tier (path) row", async () => {
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
      expect(row?.source).toBe("harvested");
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
      expect(row?.source).toBe("harvested");
    });

    it("a rewritten comment re-activates a stale row", async () => {
      const rows = gateCandidates(
        collectAnnotationCandidates(FIXTURE, TARGETS)
      );
      await upsertAnnotations(db, rows);
      await db.run(
        `existing[entity_key, summary, domain, source, confidence, comment_hash, content_hash, computed_at] :=
           *domain_annotations{entity_key, summary, domain, source, confidence, comment_hash, content_hash, computed_at}
         ?[entity_key, summary, domain, source, confidence, status, comment_hash, content_hash, computed_at] :=
           existing[entity_key, summary, domain, source, confidence, comment_hash, content_hash, computed_at],
           status = "stale"
         :put domain_annotations {entity_key => summary, domain, source, confidence, status, comment_hash, content_hash, computed_at}`,
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
    // Edit the body without the comment → stale; edit both → active.
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

      // Comment hash also moves, so the doc tracks the code: never stale.
      const edited = FIXTURE.replace(BODY, EDITED_BODY).replace(
        "auth boundary",
        "security boundary"
      );
      const editedRows = gateCandidates(
        collectAnnotationCandidates(edited, TARGETS)
      );
      const written = await upsertAnnotations(db, editedRows);
      expect(written).toBe(1);

      const after = await readAnnotation(db, "e:validateToken");
      expect(after?.status).toBe("active");
      expect(after?.summary).toContain("security boundary");
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
        `?[entity_key, domain, source, confidence, status] <- [["e:vt", "auth", "harvested", 0.7, "stale"]]
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
        `?[entity_key, domain, source, confidence, status] <- [["e:vt", "auth", "harvested", 0.7, "active"]]
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
      // A harvested-tier annotation (summary only) and a path-floor row
      // (domain only, empty summary) to cover both serve shapes.
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

    it("attaches a summary to an annotated hit", async () => {
      const enriched = await attachAnnotations(db, [
        { key: "e:validateToken", name: "validateToken", score: 1 },
      ]);
      expect(enriched[0]?.summary).toContain("auth boundary");
      expect(enriched[0]).not.toHaveProperty("domain");
    });

    it("leaves an un-annotated hit unchanged (no domain/summary keys)", async () => {
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
    });

    it("serves a stale annotation with the degrade-never-lie suffix + stale flag (SC-C.3)", async () => {
      await db.run(
        `?[entity_key, summary, domain, source, confidence, status] <- [["e:stale", "Validates the inbound token.", "auth", "harvested", 0.7, "stale"]]
         :put domain_annotations {entity_key => summary, domain, source, confidence, status}`,
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
        `?[entity_key, summary, domain, source, confidence, status] <- [["e:vt2", "Reconciles the ledger.", "payments", "harvested", 0.7, "stale"]]
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
        `?[summary, domain, source] := *entities{key, name: $name},
           *domain_annotations{entity_key: key, summary, domain, source}`,
        { name }
      );
      if (result.rows.length === 0) return null;
      const r = result.rows[0]!;
      return {
        summary: r[0] as string,
        domain: r[1] as string,
        source: r[2] as string,
      };
    }

    /** Provenance source of the annotation joined to the live entity by name. */
    async function sourceByName(name: string): Promise<string | null> {
      const result = await store.db.run(
        `?[source] := *entities{key, name: $name},
           *domain_annotations{entity_key: key, source}`,
        { name }
      );
      return (result.rows[0]?.[0] as string | undefined) ?? null;
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

    it("indexing a file with a doc comment writes a harvested summary annotation", async () => {
      writeFileSync(join(tempDir, "auth.ts"), FIXTURE);
      await indexFilesIncremental(tempDir, ["auth.ts"], store, REPO_ID);

      const row = await annotationByName("validateToken");
      expect(row?.source).toBe("harvested");
      expect(row?.summary).toContain("auth boundary");
    });

    it("a comment-text edit with no line shift still updates the annotation", async () => {
      writeFileSync(join(tempDir, "auth.ts"), FIXTURE);
      await indexFilesIncremental(tempDir, ["auth.ts"], store, REPO_ID);

      // Same line count, same entity positions — the entity diff is empty,
      // but the annotation must update (Step 4.5 runs before the early skip).
      writeFileSync(
        join(tempDir, "auth.ts"),
        FIXTURE.replace("auth boundary", "security boundary")
      );
      await indexFilesIncremental(tempDir, ["auth.ts"], store, REPO_ID);

      const row = await annotationByName("validateToken");
      expect(row?.summary).toContain("security boundary");
    });

    it("a fresh index populates the harvested + path tiers correctly", async () => {
      // auth.ts matches the auth path pattern → uncommented entities get the
      // path floor; commented ones get the harvested tier (summary only —
      // the harvested tier never authors a domain label).
      const source = `/**
 * Validates a session token against the active key set — the auth boundary
 * every inbound API call funnels through.
 */
export function validateToken(token: string) {}

export function bareHelper() {}
`;
      writeFileSync(join(tempDir, "auth.ts"), source);
      await indexFilesIncremental(tempDir, ["auth.ts"], store, REPO_ID);

      const bySource = async (name: string) => {
        const result = await store.db.run(
          `?[source, confidence, domain] := *entities{key, name: $name},
             *domain_annotations{entity_key: key, source, confidence, domain}`,
          { name }
        );
        const r = result.rows[0];
        return r
          ? {
              source: r[0] as string,
              confidence: r[1] as number,
              domain: r[2] as string,
            }
          : null;
      };

      expect(await bySource("validateToken")).toEqual({
        source: "harvested",
        confidence: 0.7,
        domain: "",
      });
      expect(await bySource("bareHelper")).toEqual({
        source: "path",
        confidence: 0.4,
        domain: "authentication",
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

    it("deleting the doc comment reconciles the stale harvested-tier row to the path floor", async () => {
      writeFileSync(join(tempDir, "auth.ts"), FIXTURE);
      await indexFilesIncremental(tempDir, ["auth.ts"], store, REPO_ID);
      expect(await sourceByName("validateToken")).toBe("harvested");

      // Strip the whole doc comment. The entity body survives in place, so it
      // never lands in `deleted`; without reconciliation its prior harvested
      // row (tier 2) tier-guards out the path floor (tier 0) and lingers.
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

    it("an unchanged doc comment is not flagged stale (no needless re-derive)", async () => {
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
      expect(await sourceByName("validateToken")).toBe("harvested");
      expect(result.annotationsChanged).toBe(false);
    });
  });
});
