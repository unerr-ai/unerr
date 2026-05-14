/**
 * Sprint L3.2 Tests: Local Embedding Store — storage, semantic search, find_similar, cosine similarity.
 */

import { describe, expect, it, vi } from "vitest";
import type { CozoDb } from "../intelligence/cozo-schema.js";
import { LocalEmbeddingStore } from "../intelligence/local-embeddings.js";
import type {
  EmbeddingResult,
  LocalLlmAdapter,
} from "../intelligence/local-llm.js";

// ── Mock CozoDB ─────────────────────────────────────────────
// In-memory mock that supports the specific Datalog query patterns
// used by LocalEmbeddingStore. Real cozo-node's run() is async,
// but the CozoDb interface expects synchronous — so we mock it.

interface MockRow {
  [col: string]: unknown;
}

function createMockDb(): CozoDb {
  const entities = new Map<string, MockRow>();
  const embeddings = new Map<string, MockRow>();

  return {
    async run(
      query: string,
      params?: Record<string, unknown>,
    ): Promise<{ rows: unknown[][] }> {
      // ── :create — no-op, just acknowledge
      if (query.includes(":create ")) {
        return { rows: [] };
      }

      // ── :put entities
      if (query.includes(":put entities")) {
        const key = (params?.k ?? params?.key) as string;
        entities.set(key, {
          key,
          kind: (params?.kind ?? "") as string,
          name: (params?.name ?? "") as string,
          file_path: (params?.fp ?? params?.file_path ?? "") as string,
          signature: (params?.sig ?? params?.signature ?? "") as string,
        });
        return { rows: [] };
      }

      // ── :put entity_embeddings
      if (query.includes(":put entity_embeddings")) {
        const ek = params?.ek as string;
        embeddings.set(ek, {
          entity_key: ek,
          vector_json: params?.vj as string,
          model: params?.m as string,
          dimensions: params?.d as number,
          computed_at: params?.ca as string,
        });
        return { rows: [] };
      }

      // ── :rm entity_embeddings
      if (query.includes(":rm entity_embeddings")) {
        const ek = params?.ek as string;
        embeddings.delete(ek);
        return { rows: [] };
      }

      // ── Query: entity_embeddings by model (computeEmbeddings skip check)
      if (
        query.includes("*entity_embeddings") &&
        query.includes("model") &&
        query.includes("$model")
      ) {
        const model = params?.model as string;
        const rows: unknown[][] = [];
        for (const [key, emb] of embeddings) {
          if (emb.model === model) {
            rows.push([key]);
          }
        }
        return { rows };
      }

      // ── Query: count(entity_key) from entity_embeddings
      if (
        query.includes("count(entity_key)") &&
        query.includes("*entity_embeddings")
      ) {
        return { rows: [[embeddings.size]] };
      }

      // ── Query: model, dimensions from entity_embeddings limit 1
      if (
        query.includes("model, dimensions") &&
        query.includes("*entity_embeddings") &&
        query.includes("limit 1")
      ) {
        if (embeddings.size === 0) return { rows: [] };
        const first = embeddings.values().next().value as MockRow;
        return { rows: [[first.model, first.dimensions]] };
      }

      // ── Query: vector_json for specific entity (findSimilar)
      if (
        query.includes("?[vector_json]") &&
        query.includes("*entity_embeddings") &&
        query.includes("entity_key = $ek")
      ) {
        const ek = params?.ek as string;
        const emb = embeddings.get(ek);
        if (emb) {
          return { rows: [[emb.vector_json]] };
        }
        return { rows: [] };
      }

      // ── Query: entity_key, vector_json from entity_embeddings (all embeddings)
      if (
        query.includes("entity_key, vector_json") &&
        query.includes("*entity_embeddings")
      ) {
        const rows: unknown[][] = [];
        for (const emb of embeddings.values()) {
          rows.push([emb.entity_key, emb.vector_json]);
        }
        return { rows };
      }

      // ── Query: entity_key from entity_embeddings with entity_key = $ek (hasEmbedding)
      if (
        query.includes("*entity_embeddings") &&
        query.includes("entity_key = $ek")
      ) {
        const ek = params?.ek as string;
        if (embeddings.has(ek)) {
          return { rows: [[ek]] };
        }
        return { rows: [] };
      }

      // ── Query: all entity_keys from entity_embeddings (clearAll key scan)
      if (
        query.includes("?[entity_key]") &&
        query.includes("*entity_embeddings")
      ) {
        const rows: unknown[][] = [];
        for (const key of embeddings.keys()) {
          rows.push([key]);
        }
        return { rows };
      }

      // ── Query: entity metadata by key (findByVector enrichment)
      if (query.includes("*entities") && query.includes("key = $key")) {
        const key = params?.key as string;
        const entity = entities.get(key);
        if (entity) {
          return {
            rows: [
              [entity.kind, entity.name, entity.file_path, entity.signature],
            ],
          };
        }
        return { rows: [] };
      }

      // Default
      return { rows: [] };
    },
  };
}

// ── Mock Adapter ────────────────────────────────────────────

function createMockAdapter(dims = 3): LocalLlmAdapter {
  return {
    provider: "test",
    baseUrl: "http://localhost:9999",
    embeddingModel: "test-model",
    embeddingDimensions: dims,
    maxConcurrency: 2,
    embed: vi.fn(async (texts: string[]): Promise<EmbeddingResult> => {
      // Deterministic embeddings: hash each text into a vector
      const embeddings = texts.map((text) => {
        const base = Array.from(text).reduce(
          (sum, ch) => sum + ch.charCodeAt(0),
          0,
        );
        const vec: number[] = [];
        for (let i = 0; i < dims; i++) {
          vec.push(Math.sin(base + i * 0.7));
        }
        // Normalize
        const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0));
        return norm > 0 ? vec.map((v) => v / norm) : vec;
      });
      return {
        embeddings,
        model: "test-model",
        totalTokens: texts.length * 5,
      };
    }),
    isAvailable: vi.fn(async () => true),
  };
}

// ── Helper: seed entities ──────────────────────────────────

function seedEntities(
  db: CozoDb,
  entities: Array<{
    key: string;
    kind: string;
    name: string;
    filePath: string;
    signature: string;
  }>,
) {
  for (const e of entities) {
    db.run(":put entities {key => kind, name, file_path, signature}", {
      k: e.key,
      kind: e.kind,
      name: e.name,
      fp: e.filePath,
      sig: e.signature,
    });
  }
}

// ── Tests ───────────────────────────────────────────────────

describe("LocalEmbeddingStore", () => {
  it("computes and stores embeddings", async () => {
    const db = createMockDb();
    const adapter = createMockAdapter();
    const store = new LocalEmbeddingStore(db, adapter);

    const entities = [
      {
        key: "fn::auth::login",
        kind: "function",
        name: "login",
        filePath: "auth.ts",
        signature: "login(user: string)",
      },
      {
        key: "fn::auth::logout",
        kind: "function",
        name: "logout",
        filePath: "auth.ts",
        signature: "logout()",
      },
    ];
    seedEntities(db, entities);

    const result = await store.computeEmbeddings(
      entities.map((e) => ({
        key: e.key,
        signature: e.signature,
        name: e.name,
        kind: e.kind,
      })),
    );

    expect(result.computed).toBe(2);
    expect(result.skipped).toBe(0);
    expect(result.elapsedMs).toBeGreaterThanOrEqual(0);
    expect(adapter.embed).toHaveBeenCalledOnce();
  });

  it("skips already-embedded entities", async () => {
    const db = createMockDb();
    const adapter = createMockAdapter();
    const store = new LocalEmbeddingStore(db, adapter);

    const entities = [
      {
        key: "fn::a",
        kind: "function",
        name: "a",
        filePath: "a.ts",
        signature: "a()",
      },
    ];
    seedEntities(db, entities);

    // First call computes
    await store.computeEmbeddings(
      entities.map((e) => ({
        key: e.key,
        signature: e.signature,
        name: e.name,
        kind: e.kind,
      })),
    );
    expect(adapter.embed).toHaveBeenCalledTimes(1);

    // Second call skips
    const result2 = await store.computeEmbeddings(
      entities.map((e) => ({
        key: e.key,
        signature: e.signature,
        name: e.name,
        kind: e.kind,
      })),
    );
    expect(result2.computed).toBe(0);
    expect(result2.skipped).toBe(1);
    // embed should NOT have been called again
    expect(adapter.embed).toHaveBeenCalledTimes(1);
  });

  it("semantic search returns ranked results", async () => {
    const db = createMockDb();
    const adapter = createMockAdapter(8);
    const store = new LocalEmbeddingStore(db, adapter);

    const entities = [
      {
        key: "fn::auth::login",
        kind: "function",
        name: "login",
        filePath: "auth.ts",
        signature: "login(user: string, password: string)",
      },
      {
        key: "fn::auth::logout",
        kind: "function",
        name: "logout",
        filePath: "auth.ts",
        signature: "logout()",
      },
      {
        key: "fn::db::connect",
        kind: "function",
        name: "connect",
        filePath: "db.ts",
        signature: "connect(uri: string)",
      },
    ];
    seedEntities(db, entities);

    await store.computeEmbeddings(
      entities.map((e) => ({
        key: e.key,
        signature: e.signature,
        name: e.name,
        kind: e.kind,
      })),
    );

    // Search for something similar to "login"
    const results = await store.semanticSearch("login authentication", 10, 0.0);

    expect(results.length).toBeGreaterThan(0);
    // Results should be sorted by similarity descending
    for (let i = 1; i < results.length; i++) {
      expect(results[i - 1]?.similarity).toBeGreaterThanOrEqual(
        results[i]?.similarity ?? 0,
      );
    }
    // Each result should have entity metadata
    for (const r of results) {
      expect(r.entityKey).toBeTruthy();
      expect(r.similarity).toBeGreaterThanOrEqual(0);
      expect(r.similarity).toBeLessThanOrEqual(1);
    }
  });

  it("find_similar returns related entities excluding self", async () => {
    const db = createMockDb();
    const adapter = createMockAdapter(8);
    const store = new LocalEmbeddingStore(db, adapter);

    const entities = [
      {
        key: "fn::a",
        kind: "function",
        name: "processUser",
        filePath: "a.ts",
        signature: "processUser(id: string)",
      },
      {
        key: "fn::b",
        kind: "function",
        name: "processOrder",
        filePath: "b.ts",
        signature: "processOrder(id: string)",
      },
      {
        key: "fn::c",
        kind: "function",
        name: "renderPage",
        filePath: "c.ts",
        signature: "renderPage()",
      },
    ];
    seedEntities(db, entities);

    await store.computeEmbeddings(
      entities.map((e) => ({
        key: e.key,
        signature: e.signature,
        name: e.name,
        kind: e.kind,
      })),
    );

    const results = await store.findSimilar("fn::a", 10, -1.0);

    // Should not include self
    expect(results.every((r) => r.entityKey !== "fn::a")).toBe(true);
    // Should have results
    expect(results.length).toBeGreaterThan(0);
  });

  it("getStats returns correct counts", async () => {
    const db = createMockDb();
    const adapter = createMockAdapter();
    const store = new LocalEmbeddingStore(db, adapter);

    let stats = await store.getStats();
    expect(stats.totalEmbeddings).toBe(0);

    const entities = [
      {
        key: "fn::x",
        kind: "function",
        name: "x",
        filePath: "x.ts",
        signature: "x()",
      },
      {
        key: "fn::y",
        kind: "function",
        name: "y",
        filePath: "y.ts",
        signature: "y()",
      },
    ];
    seedEntities(db, entities);

    await store.computeEmbeddings(
      entities.map((e) => ({
        key: e.key,
        signature: e.signature,
        name: e.name,
        kind: e.kind,
      })),
    );

    stats = await store.getStats();
    expect(stats.totalEmbeddings).toBe(2);
    expect(stats.model).toBe("test-model");
    expect(stats.dimensions).toBe(3);
  });

  it("hasEmbedding checks specific entity", async () => {
    const db = createMockDb();
    const adapter = createMockAdapter();
    const store = new LocalEmbeddingStore(db, adapter);

    const entities = [
      {
        key: "fn::z",
        kind: "function",
        name: "z",
        filePath: "z.ts",
        signature: "z()",
      },
    ];
    seedEntities(db, entities);

    expect(await store.hasEmbedding("fn::z")).toBe(false);

    await store.computeEmbeddings(
      entities.map((e) => ({
        key: e.key,
        signature: e.signature,
        name: e.name,
        kind: e.kind,
      })),
    );

    expect(await store.hasEmbedding("fn::z")).toBe(true);
    expect(await store.hasEmbedding("fn::nonexistent")).toBe(false);
  });

  it("clearAll removes all embeddings", async () => {
    const db = createMockDb();
    const adapter = createMockAdapter();
    const store = new LocalEmbeddingStore(db, adapter);

    const entities = [
      {
        key: "fn::a",
        kind: "function",
        name: "a",
        filePath: "a.ts",
        signature: "a()",
      },
      {
        key: "fn::b",
        kind: "function",
        name: "b",
        filePath: "b.ts",
        signature: "b()",
      },
    ];
    seedEntities(db, entities);

    await store.computeEmbeddings(
      entities.map((e) => ({
        key: e.key,
        signature: e.signature,
        name: e.name,
        kind: e.kind,
      })),
    );

    expect((await store.getStats()).totalEmbeddings).toBe(2);

    const cleared = await store.clearAll();
    expect(cleared).toBe(2);
    expect((await store.getStats()).totalEmbeddings).toBe(0);
  });

  it("find_similar returns empty when entity has no embedding", async () => {
    const db = createMockDb();
    const adapter = createMockAdapter();
    const store = new LocalEmbeddingStore(db, adapter);

    const results = await store.findSimilar("fn::nonexistent");
    expect(results).toEqual([]);
  });
});
