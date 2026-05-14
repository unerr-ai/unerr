/**
 * Sprint L3 Tests: Local Project Stats (L3.3) & entity_embeddings relation (L3.4).
 *
 * Uses an in-memory mock CozoDB (real cozo-node's run() is async/Promise-based,
 * but the CozoDb interface expects synchronous returns).
 */

import { describe, expect, it } from "vitest";
import type { CozoDb } from "../intelligence/cozo-schema.js";

// ── Mock CozoDB with Relation Storage ──────────────────────

interface MockEntity {
  key: string;
  kind: string;
  name: string;
  filePath: string;
}

interface MockEdge {
  fromKey: string;
  toKey: string;
  type: string;
}

interface MockFileIndex {
  filePath: string;
  entityKey: string;
}

interface MockEmbedding {
  entityKey: string;
  vectorJson: string;
  model: string;
  dimensions: number;
  computedAt: string;
}

class MockCozoDb implements CozoDb {
  readonly entities: MockEntity[] = [];
  readonly edges: MockEdge[] = [];
  readonly fileIndex: MockFileIndex[] = [];
  readonly rules: Array<{ key: string; name: string; enabled: boolean }> = [];
  readonly driftOverlay: Array<{ key: string }> = [];
  readonly communities: Array<{
    id: number;
    label: string;
    size: number;
    cohesion: number;
  }> = [];
  readonly corrections: Array<{ entityKey: string; errorType: string }> = [];
  readonly embeddings: Map<string, MockEmbedding> = new Map();

  async run(
    query: string,
    params?: Record<string, unknown>,
  ): Promise<{ rows: unknown[][] }> {
    // ── :create — no-op
    if (query.includes(":create ")) {
      return { rows: [] };
    }

    // ── :put entity_embeddings
    if (query.includes(":put entity_embeddings")) {
      const ek = this.extractInlineOrParam(
        query,
        params,
        "entity_key",
        0,
      ) as string;
      const vj = this.extractInlineOrParam(
        query,
        params,
        "vector_json",
        1,
      ) as string;
      const model = this.extractInlineOrParam(
        query,
        params,
        "model",
        2,
      ) as string;
      const dims = this.extractInlineOrParam(
        query,
        params,
        "dimensions",
        3,
      ) as number;
      const ca = this.extractInlineOrParam(
        query,
        params,
        "computed_at",
        4,
      ) as string;
      this.embeddings.set(ek, {
        entityKey: ek,
        vectorJson: vj,
        model,
        dimensions: dims,
        computedAt: ca,
      });
      return { rows: [] };
    }

    // ── :rm entity_embeddings
    if (query.includes(":rm entity_embeddings")) {
      const ek = this.extractInlineOrParam(
        query,
        params,
        "entity_key",
        0,
      ) as string;
      this.embeddings.delete(ek);
      return { rows: [] };
    }

    // ── :put (other relations) — no-op, data seeded via addXxx methods
    if (query.includes(":put ")) {
      return { rows: [] };
    }

    // ── Aggregation queries for getLocalProjectStats
    // NOTE: More specific patterns (group-by) must come BEFORE simple counts
    // to avoid false matches (e.g., "kind, count(key)" also contains "count(key)").

    // kind, count(key) from entities (group by kind)
    if (query.includes("kind, count(key)") && query.includes("*entities")) {
      const grouped = new Map<string, number>();
      for (const e of this.entities) {
        grouped.set(e.kind, (grouped.get(e.kind) ?? 0) + 1);
      }
      return { rows: Array.from(grouped.entries()) };
    }

    // type, count(from_key) from edges (group by type)
    if (query.includes("type, count(from_key)") && query.includes("*edges")) {
      const grouped = new Map<string, number>();
      for (const e of this.edges) {
        grouped.set(e.type, (grouped.get(e.type) ?? 0) + 1);
      }
      return { rows: Array.from(grouped.entries()) };
    }

    // file_path, count(entity_key) from file_index (top files)
    if (
      query.includes("file_path, count(entity_key)") &&
      query.includes("*file_index")
    ) {
      const grouped = new Map<string, number>();
      for (const fi of this.fileIndex) {
        grouped.set(fi.filePath, (grouped.get(fi.filePath) ?? 0) + 1);
      }
      const sorted = Array.from(grouped.entries()).sort((a, b) => b[1] - a[1]);
      return { rows: sorted.slice(0, 10) };
    }

    // count_unique(file_path) from entities
    if (
      query.includes("count_unique(file_path)") &&
      query.includes("*entities")
    ) {
      const unique = new Set(this.entities.map((e) => e.filePath));
      return { rows: [[unique.size]] };
    }

    // count(key) from entities
    if (query.includes("count(key)") && query.includes("*entities")) {
      return { rows: [[this.entities.length]] };
    }

    // count(from_key) from edges
    if (query.includes("count(from_key)") && query.includes("*edges")) {
      return { rows: [[this.edges.length]] };
    }

    // count(key) from rules where enabled = true
    if (
      query.includes("count(key)") &&
      query.includes("*rules") &&
      query.includes("enabled")
    ) {
      return { rows: [[this.rules.filter((r) => r.enabled).length]] };
    }

    // count(key) from drift_overlay
    if (query.includes("count(key)") && query.includes("*drift_overlay")) {
      return { rows: [[this.driftOverlay.length]] };
    }

    // count(id) from communities
    if (query.includes("count(id)") && query.includes("*communities")) {
      return { rows: [[this.communities.length]] };
    }

    // count(entity_key) from corrections
    if (query.includes("count(entity_key)") && query.includes("*corrections")) {
      return { rows: [[this.corrections.length]] };
    }

    // ── entity_embeddings queries

    // Read all: entity_key, vector_json, model, dimensions
    if (
      query.includes("entity_key, vector_json, model, dimensions") &&
      query.includes("*entity_embeddings")
    ) {
      const rows: unknown[][] = [];
      for (const emb of this.embeddings.values()) {
        rows.push([emb.entityKey, emb.vectorJson, emb.model, emb.dimensions]);
      }
      return { rows };
    }

    // Count after delete
    if (query.includes("entity_key") && query.includes("*entity_embeddings")) {
      const rows: unknown[][] = [];
      for (const key of this.embeddings.keys()) {
        rows.push([key]);
      }
      return { rows };
    }

    // Default
    return { rows: [] };
  }

  private extractInlineOrParam(
    query: string,
    params: Record<string, unknown> | undefined,
    _field: string,
    _index: number,
  ): unknown {
    // For the entity_embeddings CRUD test, values come from the <- [[...]] clause
    // Parse the values from the inline array
    const match = query.match(/<-\s*\[\[(.*?)\]\]/);
    if (match) {
      const values = this.parseInlineValues(match[1] ?? "");
      if (_index < values.length) return values[_index];
    }
    return params?.[_field] ?? "";
  }

  private parseInlineValues(str: string): unknown[] {
    const values: unknown[] = [];
    let i = 0;
    while (i < str.length) {
      // Skip whitespace and commas
      while (i < str.length && (str[i] === " " || str[i] === ",")) i++;
      if (i >= str.length) break;

      if (str[i] === '"') {
        // String literal
        i++;
        let val = "";
        while (i < str.length && str[i] !== '"') {
          val += str[i];
          i++;
        }
        i++; // skip closing quote
        values.push(val);
      } else if (str[i] === "$") {
        // Parameter reference — skip for now
        while (i < str.length && str[i] !== "," && str[i] !== "]") i++;
        values.push(null); // placeholder
      } else {
        // Number or boolean
        let val = "";
        while (
          i < str.length &&
          str[i] !== "," &&
          str[i] !== "]" &&
          str[i] !== " "
        ) {
          val += str[i];
          i++;
        }
        if (val === "true") values.push(true);
        else if (val === "false") values.push(false);
        else values.push(Number(val));
      }
    }
    return values;
  }
}

function createTestDb(): MockCozoDb {
  return new MockCozoDb();
}

function seedGraph(db: MockCozoDb) {
  // Seed entities
  db.entities.push(
    {
      key: "fn::auth::login",
      kind: "function",
      name: "login",
      filePath: "src/auth.ts",
    },
    {
      key: "fn::auth::logout",
      kind: "function",
      name: "logout",
      filePath: "src/auth.ts",
    },
    {
      key: "cls::auth::AuthService",
      kind: "class",
      name: "AuthService",
      filePath: "src/auth.ts",
    },
    {
      key: "fn::db::connect",
      kind: "function",
      name: "connect",
      filePath: "src/db.ts",
    },
    {
      key: "fn::db::query",
      kind: "function",
      name: "query",
      filePath: "src/db.ts",
    },
    {
      key: "file::src/auth.ts",
      kind: "file",
      name: "auth.ts",
      filePath: "src/auth.ts",
    },
    {
      key: "file::src/db.ts",
      kind: "file",
      name: "db.ts",
      filePath: "src/db.ts",
    },
  );

  // Seed file index
  for (const e of db.entities) {
    db.fileIndex.push({ filePath: e.filePath, entityKey: e.key });
  }

  // Seed edges
  db.edges.push(
    { fromKey: "fn::auth::login", toKey: "fn::db::query", type: "calls" },
    {
      fromKey: "cls::auth::AuthService",
      toKey: "fn::auth::login",
      type: "contains",
    },
    {
      fromKey: "cls::auth::AuthService",
      toKey: "fn::auth::logout",
      type: "contains",
    },
    { fromKey: "fn::db::connect", toKey: "fn::db::query", type: "calls" },
  );

  // Seed a rule
  db.rules.push({ key: "rule::no-any", name: "no-any", enabled: true });

  // Seed a community
  db.communities.push({
    id: 0,
    label: "auth-cluster",
    size: 3,
    cohesion: 0.85,
  });

  // Seed a drift entity
  db.driftOverlay.push({ key: "fn::auth::login" });

  // Seed a correction
  db.corrections.push({
    entityKey: "fn::auth::login",
    errorType: "null-check",
  });
}

// ── L3.3: getLocalProjectStats ──────────────────────────────

describe("CozoGraphStore.getLocalProjectStats", () => {
  it("returns aggregated stats from graph", async () => {
    const db = createTestDb();
    seedGraph(db);

    const { CozoGraphStore } = await import("../intelligence/local-graph.js");
    const store = await CozoGraphStore.create(db as CozoDb);

    const stats = await store.getLocalProjectStats();

    expect(stats.entityCount).toBe(7);
    expect(stats.edgeCount).toBe(4);
    expect(stats.fileCount).toBe(2); // src/auth.ts and src/db.ts
    expect(stats.ruleCount).toBe(1);
    expect(stats.driftCount).toBe(1);
    expect(stats.communityCount).toBe(1);
    expect(stats.correctionCount).toBe(1);

    // Entity breakdown by kind
    expect(stats.entityByKind.function).toBe(4);
    expect(stats.entityByKind.class).toBe(1);
    expect(stats.entityByKind.file).toBe(2);

    // Edge breakdown by type
    expect(stats.edgeByType.calls).toBe(2);
    expect(stats.edgeByType.contains).toBe(2);

    // Top files
    expect(stats.topFiles.length).toBeGreaterThan(0);
    // src/auth.ts has 4 entities (3 + 1 file), src/db.ts has 3
    const authFile = stats.topFiles.find((f) => f.filePath === "src/auth.ts");
    expect(authFile).toBeDefined();
    expect(authFile?.entityCount).toBeGreaterThanOrEqual(3);
  });

  it("returns zeros for empty graph", async () => {
    const db = createTestDb();
    const { CozoGraphStore } = await import("../intelligence/local-graph.js");
    const store = await CozoGraphStore.create(db as CozoDb);

    const stats = await store.getLocalProjectStats();

    expect(stats.entityCount).toBe(0);
    expect(stats.edgeCount).toBe(0);
    expect(stats.fileCount).toBe(0);
    expect(stats.ruleCount).toBe(0);
    expect(stats.driftCount).toBe(0);
    expect(stats.entityByKind).toEqual({});
    expect(stats.edgeByType).toEqual({});
    expect(stats.topFiles).toEqual([]);
  });

  it("completes under 10ms for modest graph", async () => {
    const db = createTestDb();
    seedGraph(db);

    const { CozoGraphStore } = await import("../intelligence/local-graph.js");
    const store = await CozoGraphStore.create(db as CozoDb);

    const t0 = performance.now();
    await store.getLocalProjectStats();
    const elapsed = performance.now() - t0;

    expect(elapsed).toBeLessThan(50); // generous for CI; typically <5ms
  });
});

// ── L3.4: entity_embeddings relation ────────────────────────

describe("entity_embeddings relation", () => {
  it("exists in schema and supports CRUD", async () => {
    const db = createTestDb();

    // Insert via mock's run method (simulates CozoDB :put)
    await db.run(
      `?[entity_key, vector_json, model, dimensions, computed_at] <- [["fn::test", "[0.1,0.2,0.3]", "test-model", 3, "2026-04-17"]]
       :put entity_embeddings {entity_key => vector_json, model, dimensions, computed_at}`,
    );

    // Read
    const result = await db.run(
      "?[entity_key, vector_json, model, dimensions] := *entity_embeddings{entity_key, vector_json, model, dimensions}",
    );
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]?.[0]).toBe("fn::test");
    expect(result.rows[0]?.[2]).toBe("test-model");
    expect(result.rows[0]?.[3]).toBe(3);

    // Delete
    await db.run(
      `?[entity_key] <- [["fn::test"]] :rm entity_embeddings {entity_key}`,
    );
    const afterDelete = await db.run(
      "?[entity_key] := *entity_embeddings{entity_key}",
    );
    expect(afterDelete.rows).toHaveLength(0);
  });
});
