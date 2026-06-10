/**
 * Sprint SC-A.2: Layer 8 domain-graph relations — create + round-trip.
 *
 * Hits a real in-memory CozoDB instance so the actual :create / :put / named
 * Datalog syntax is exercised (domain_annotations has 10 value columns —
 * named syntax always, per the Datalog rules).
 */

import { beforeEach, describe, expect, it } from "vitest";
import type { CozoDb } from "../intelligence/cozo-schema.js";
import { initSchema } from "../intelligence/cozo-schema.js";

async function createTestDb(): Promise<CozoDb> {
  const cozoModule = await import("cozo-node");
  const CozoDbConstructor = (
    cozoModule as { default?: { CozoDb: unknown }; CozoDb?: unknown }
  ).default
    ? (cozoModule as { default: { CozoDb: unknown } }).default.CozoDb
    : (cozoModule as { CozoDb: unknown }).CozoDb;
  return new (CozoDbConstructor as any)("mem", "") as CozoDb;
}

describe("Layer 8 domain-graph schema (SC-A.2)", () => {
  let db: CozoDb;

  beforeEach(async () => {
    db = await createTestDb();
    await initSchema(db);
  });

  it("creates all three relations", async () => {
    const result = await db.run("::relations", {});
    const names = result.rows.map((r) => r[0]);
    expect(names).toContain("domain_annotations");
    expect(names).toContain("domain_edges");
    expect(names).toContain("community_domains");
  });

  it("initSchema is idempotent on existing relations", async () => {
    await expect(initSchema(db)).resolves.not.toThrow();
  });

  it("round-trips a domain_annotations row with named syntax", async () => {
    await db.run(
      `?[entity_key, summary, domain, role, extras, source, confidence, status, comment_hash, content_hash, computed_at] <-
         [[$key, $summary, "auth", "gateway", $extras, "comment", 0.95, "active", "ch1", "bh1", "2026-06-07"]]
       :put domain_annotations {entity_key => summary, domain, role, extras, source, confidence, status, comment_hash, content_hash, computed_at}`,
      {
        key: "src/auth/token.ts::validateToken",
        summary: "Validates a session token against the active key set.",
        extras: JSON.stringify({ stability: "frozen" }),
      }
    );

    const result = await db.run(
      `?[summary, domain, role, source, confidence, status] :=
         *domain_annotations{entity_key: $key, summary, domain, role, source, confidence, status}`,
      { key: "src/auth/token.ts::validateToken" }
    );
    expect(result.rows).toHaveLength(1);
    const [summary, domain, role, source, confidence, status] =
      result.rows[0]!;
    expect(summary).toContain("session token");
    expect(domain).toBe("auth");
    expect(role).toBe("gateway");
    expect(source).toBe("comment");
    expect(confidence).toBeCloseTo(0.95);
    expect(status).toBe("active");
  });

  it("upsert by entity_key replaces the prior annotation", async () => {
    const put = `?[entity_key, domain, source, confidence] <- [[$key, $domain, $source, $conf]]
       :put domain_annotations {entity_key => domain, source, confidence}`;
    await db.run(put, {
      key: "e1",
      domain: "auth",
      source: "path",
      conf: 0.4,
    });
    await db.run(put, {
      key: "e1",
      domain: "auth",
      source: "comment",
      conf: 0.95,
    });

    const result = await db.run(
      "?[source, confidence] := *domain_annotations{entity_key: $key, source, confidence}",
      { key: "e1" }
    );
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]![0]).toBe("comment");
  });

  it("round-trips domain_edges keyed by (from, to, type)", async () => {
    await db.run(
      `?[from_domain, to_domain, edge_type, weight, evidence_count] <-
         [["auth", "session-store", "calls_observed", 14.0, 14]]
       :put domain_edges {from_domain, to_domain, edge_type => weight, evidence_count}`,
      {}
    );

    const result = await db.run(
      `?[to_domain, weight, evidence_count] :=
         *domain_edges{from_domain: "auth", to_domain, edge_type: "calls_observed", weight, evidence_count}`,
      {}
    );
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]![0]).toBe("session-store");
    expect(result.rows[0]![2]).toBe(14);
  });

  it("round-trips community_domains with coverage and purity", async () => {
    await db.run(
      `?[community_id, domain, coverage, purity] <- [[7, "payments", 0.84, 0.91]]
       :put community_domains {community_id => domain, coverage, purity}`,
      {}
    );

    const result = await db.run(
      `?[domain, coverage, purity] :=
         *community_domains{community_id: 7, domain, coverage, purity}`,
      {}
    );
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]![0]).toBe("payments");
    expect(result.rows[0]![2]).toBeCloseTo(0.91);
  });

  it("unspecified value columns fall back to schema defaults", async () => {
    await db.run(
      `?[entity_key, domain] <- [["e2", "graph-indexing"]]
       :put domain_annotations {entity_key => domain}`,
      {}
    );

    const result = await db.run(
      `?[summary, extras, source, status, confidence] :=
         *domain_annotations{entity_key: "e2", summary, extras, source, status, confidence}`,
      {}
    );
    expect(result.rows).toHaveLength(1);
    const [summary, extras, source, status, confidence] = result.rows[0]!;
    expect(summary).toBe("");
    expect(extras).toBe("{}");
    expect(source).toBe("path");
    expect(status).toBe("active");
    expect(confidence).toBe(0);
  });
});
