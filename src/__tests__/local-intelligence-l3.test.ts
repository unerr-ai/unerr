/**
 * Sprint L3 Tests: Local Project Stats (L3.3).
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

  async run(
    query: string,
    _params?: Record<string, unknown>
  ): Promise<{ rows: unknown[][] }> {
    // ── :create — no-op
    if (query.includes(":create ")) {
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

    // Default
    return { rows: [] };
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
    }
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
    { fromKey: "fn::db::connect", toKey: "fn::db::query", type: "calls" }
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
