/**
 * Layer 8 §6 — domain-graph derivations (Sprint SC-D.1/D.2/D.4/D.5).
 *
 * Fixture: two tagged communities (auth, payments) + one untagged util entity
 * reached only along a call edge, plus a mixed-domain file and a cross-domain
 * coupled/calls/co-change triple. Exercises label propagation, the community
 * vote, the domain edges, and the file/module rollups against a real CozoDB.
 */

import { beforeEach, describe, expect, it } from "vitest";
import type { CozoDb } from "../intelligence/cozo-schema.js";
import { initSchema } from "../intelligence/cozo-schema.js";
import {
  buildDomainEdges,
  computeCommunityDomains,
  computeDomainCoverage,
  computeFileDomains,
  computeModuleDomains,
  deriveDomainGraph,
  propagateLabels,
} from "../intelligence/semantic/domain-graph.js";

async function createTestDb(): Promise<CozoDb> {
  const cozoModule = await import("cozo-node");
  const CozoDbConstructor = (
    cozoModule as { default?: { CozoDb: unknown }; CozoDb?: unknown }
  ).default
    ? (cozoModule as { default: { CozoDb: unknown } }).default.CozoDb
    : (cozoModule as { CozoDb: unknown }).CozoDb;
  // biome-ignore lint/suspicious/noExplicitAny: dynamic cozo constructor
  return new (CozoDbConstructor as any)("mem", "") as CozoDb;
}

async function seedFixture(db: CozoDb): Promise<void> {
  await db.run(
    `?[key, kind, name, file_path, community] <- $rows
     :put entities {key => kind, name, file_path, community}`,
    {
      rows: [
        ["e:a1", "function", "login", "src/auth/login.ts", 0],
        ["e:a2", "function", "logout", "src/auth/logout.ts", 0],
        ["e:a3", "function", "helper", "src/auth/helper.ts", 0],
        ["e:a4", "function", "edgecase", "src/auth/login.ts", 0],
        ["e:p1", "function", "charge", "src/pay/charge.ts", 1],
        ["e:p2", "function", "refund", "src/pay/refund.ts", 1],
        ["e:x1", "function", "util", "src/util/util.ts", 2],
      ],
    }
  );
  // Seeds (real annotations). a1 declares a cross-domain `coupled=charge`.
  await db.run(
    `?[entity_key, domain, role, extras, source, confidence, status] <- $rows
     :put domain_annotations {entity_key => domain, role, extras, source, confidence, status}`,
    {
      rows: [
        ["e:a1", "auth", "", '{"coupled":"charge"}', "comment", 0.95, "active"],
        ["e:a2", "auth", "", "{}", "comment", 0.95, "active"],
        ["e:a4", "payments", "", "{}", "comment", 0.4, "active"],
        ["e:p1", "payments", "", "{}", "comment", 0.95, "active"],
        ["e:p2", "payments", "", "{}", "comment", 0.95, "active"],
      ],
    }
  );
  await db.run(
    `?[from_key, to_key, type] <- $rows :put edges {from_key, to_key, type}`,
    {
      rows: [
        ["e:a1", "e:x1", "calls"], // auth → untagged util: propagation seed
        ["e:a1", "e:p1", "calls"], // auth → payments: cross-domain call
        ["file:src/auth/login.ts", "file:src/pay/charge.ts", "co_changes"],
      ],
    }
  );
}

async function propagatedRows(
  db: CozoDb
): Promise<Array<{ key: string; domain: string; confidence: number }>> {
  const res = await db.run(
    `?[entity_key, domain, confidence] :=
       *domain_annotations{entity_key, domain, confidence, source: "propagated"}`
  );
  return res.rows
    .map((r) => ({
      key: r[0] as string,
      domain: r[1] as string,
      confidence: Number(r[2]),
    }))
    .sort((a, b) => a.key.localeCompare(b.key));
}

describe("domain graph — §6 derivations (SC-D)", () => {
  let db: CozoDb;

  beforeEach(async () => {
    db = await createTestDb();
    await initSchema(db);
    await seedFixture(db);
  });

  it("propagates labels: community members + call-edge decay (D.1)", async () => {
    const written = await propagateLabels(db);
    // a3 (untagged auth-community member) + x1 (untagged call neighbour of a1).
    expect(written).toBe(2);
    expect(await propagatedRows(db)).toEqual([
      { key: "e:a3", domain: "auth", confidence: 0.6 },
      { key: "e:x1", domain: "auth", confidence: 0.6 },
    ]);
  });

  it("is idempotent: a second propagation writes nothing new (D.1)", async () => {
    await propagateLabels(db);
    expect(await propagateLabels(db)).toBe(0);
  });

  it("votes dominant domain + coverage + purity per community (D.2)", async () => {
    const rows = await computeCommunityDomains(db);
    const byId = new Map(rows.map((r) => [r.community_id, r]));
    // Community 0: a1,a2 auth (1.9) vs a4 payments (0.4) → auth; 3/4 tagged;
    // purity 1.9 / 2.3.
    expect(byId.get(0)).toEqual({
      community_id: 0,
      domain: "auth",
      coverage: 0.75,
      purity: 0.826,
    });
    // Community 1: pure payments.
    expect(byId.get(1)).toEqual({
      community_id: 1,
      domain: "payments",
      coverage: 1,
      purity: 1,
    });
    // Community 2 (only the untagged util) gets no row.
    expect(byId.has(2)).toBe(false);
  });

  it("persists the vote into community_domains (D.2)", async () => {
    await computeCommunityDomains(db);
    const res = await db.run(
      `?[community_id, domain, purity] := *community_domains{community_id, domain, purity}`
    );
    expect(res.rows.length).toBe(2);
  });

  it("builds domain edges from coupled + calls + co-change (D.4)", async () => {
    const edges = await buildDomainEdges(db);
    // All evidence is auth↔payments; one edge per type, normalised + sorted.
    expect(edges).toEqual([
      {
        from_domain: "auth",
        to_domain: "payments",
        edge_type: "calls_observed",
        weight: 1,
        evidence_count: 1,
      },
      {
        from_domain: "auth",
        to_domain: "payments",
        edge_type: "co_change",
        weight: 1,
        evidence_count: 1,
      },
      {
        from_domain: "auth",
        to_domain: "payments",
        edge_type: "coupled_declared",
        weight: 1,
        evidence_count: 1,
      },
    ]);
  });

  it("derives file domains by confidence-weighted majority (D.5)", async () => {
    const files = await computeFileDomains(db);
    // login.ts mixes a1 auth(0.95) + a4 payments(0.4) → auth wins, 0.95/1.35.
    expect(files.get("src/auth/login.ts")).toEqual({
      domain: "auth",
      confidence: 0.704,
    });
    expect(files.get("src/pay/charge.ts")).toEqual({
      domain: "payments",
      confidence: 1,
    });
    // helper.ts has no domain (untagged, propagation not run) → no rollup.
    expect(files.has("src/auth/helper.ts")).toBe(false);
  });

  it("derives module domains by file majority (D.5)", async () => {
    const modules = await computeModuleDomains(db);
    expect(modules.get("src/auth")?.domain).toBe("auth");
    expect(modules.get("src/pay")?.domain).toBe("payments");
  });

  it("deriveDomainGraph runs all stages and is idempotent", async () => {
    const first = await deriveDomainGraph(db);
    expect(first.propagated).toBe(2);
    expect(first.communities).toBe(2);
    expect(first.edges).toBe(3);
    // Second pass: propagation reproduces the same labels → zero new writes.
    const second = await deriveDomainGraph(db);
    expect(second.propagated).toBe(0);
    expect(second.communities).toBe(2);
    expect(second.edges).toBe(3);
  });
});

describe("domain coverage by provenance tier (SC-E.3)", () => {
  let db: CozoDb;

  beforeEach(async () => {
    db = await createTestDb();
    await initSchema(db);
  });

  async function seedTiers(): Promise<void> {
    await db.run(
      `?[entity_key, domain, role, extras, source, confidence, status] <- $rows
       :put domain_annotations {entity_key => domain, role, extras, source, confidence, status}`,
      {
        rows: [
          // payments: 1 comment + 1 harvested (durable) + 2 propagated (inferred)
          ["e:p1", "payments", "", "{}", "comment", 0.95, "active"],
          ["e:p2", "payments", "", "{}", "harvested", 0.7, "active"],
          ["e:p3", "payments", "", "{}", "propagated", 0.6, "active"],
          ["e:p4", "payments", "", "{}", "propagated", 0.45, "active"],
          // auth: all 2 comment (fully durable)
          ["e:a1", "auth", "", "{}", "comment", 0.95, "active"],
          ["e:a2", "auth", "", "{}", "comment", 0.95, "active"],
          // search: 1 path (fully inferred) + 1 inactive (excluded)
          ["e:s1", "search", "", "{}", "path", 0.4, "active"],
          ["e:s2", "search", "", "{}", "comment", 0.95, "superseded"],
          // blank domain row — excluded entirely
          ["e:z1", "", "", "{}", "comment", 0.95, "active"],
        ],
      }
    );
  }

  it("splits each domain's entities by provenance tier", async () => {
    await seedTiers();
    const rows = await computeDomainCoverage(db);
    const payments = rows.find((r) => r.domain === "payments");
    expect(payments).toEqual({
      domain: "payments",
      comment: 1,
      harvested: 1,
      propagated: 2,
      path: 0,
      total: 4,
      durablePct: 50, // (1 comment + 1 harvested) / 4
    });
  });

  it("excludes non-active and blank-domain rows", async () => {
    await seedTiers();
    const rows = await computeDomainCoverage(db);
    // search has one active path row; the superseded comment row is dropped.
    const search = rows.find((r) => r.domain === "search");
    expect(search).toMatchObject({
      total: 1,
      path: 1,
      comment: 0,
      durablePct: 0,
    });
    // blank-domain row never produces a coverage entry.
    expect(rows.some((r) => r.domain === "")).toBe(false);
  });

  it("sorts lowest durable coverage first, then by size", async () => {
    await seedTiers();
    const rows = await computeDomainCoverage(db);
    expect(rows.map((r) => r.domain)).toEqual(["search", "payments", "auth"]);
    expect(rows.map((r) => r.durablePct)).toEqual([0, 50, 100]);
  });

  it("returns an empty list on a fresh schema", async () => {
    expect(await computeDomainCoverage(db)).toEqual([]);
  });
});
