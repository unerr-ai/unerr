/**
 * Local Embedding Store & Semantic Search — Sprint L3.2.
 *
 * Stores per-entity embedding vectors in CozoDB's entity_embeddings relation.
 * Provides cosine similarity search for semantic_search and find_similar tools,
 * using local vector storage.
 *
 * All embedding computation is delegated to the BYO-LLM adapter (local-llm.ts).
 * Vectors are stored as JSON-encoded float arrays in CozoDB (no native vector type).
 */

import type { CozoDb } from "./cozo-schema.js";
import type { LocalLlmAdapter } from "./local-llm.js";

// ── Types ────────────────────────────────────────────────────

export interface SemanticSearchResult {
  entityKey: string;
  similarity: number;
  kind: string;
  name: string;
  filePath: string;
  signature: string;
}

export interface EmbeddingStats {
  totalEmbeddings: number;
  model: string;
  dimensions: number;
}

// ── Cosine Similarity ────────────────────────────────────────

function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;

  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    const ai = a[i] ?? 0;
    const bi = b[i] ?? 0;
    dot += ai * bi;
    normA += ai * ai;
    normB += bi * bi;
  }

  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

// ── LocalEmbeddingStore ──────────────────────────────────────

export class LocalEmbeddingStore {
  constructor(
    private readonly db: CozoDb,
    private readonly adapter: LocalLlmAdapter
  ) {}

  /**
   * Compute and store embeddings for a batch of entities.
   * Skips entities that already have embeddings from the same model.
   *
   * Returns the number of new embeddings computed.
   */
  async computeEmbeddings(
    entities: Array<{
      key: string;
      signature: string;
      name: string;
      kind: string;
    }>
  ): Promise<{ computed: number; skipped: number; elapsedMs: number }> {
    const t0 = performance.now();
    const model = this.adapter.embeddingModel;

    // Filter out entities that already have embeddings from this model
    const existing = new Set<string>();
    const result = await this.db.run(
      "?[entity_key] := *entity_embeddings{entity_key, model}, model = $model",
      { model }
    );
    for (const row of result.rows) {
      existing.add(row[0] as string);
    }

    const toEmbed = entities.filter((e) => !existing.has(e.key));
    if (toEmbed.length === 0) {
      return {
        computed: 0,
        skipped: entities.length,
        elapsedMs: performance.now() - t0,
      };
    }

    // Build text representation for each entity
    const texts = toEmbed.map((e) => `${e.kind} ${e.name} ${e.signature}`);

    // Batch embed with concurrency limit
    const batchSize = 64;
    let totalComputed = 0;

    for (let i = 0; i < texts.length; i += batchSize) {
      const batchTexts = texts.slice(i, i + batchSize);
      const batchEntities = toEmbed.slice(i, i + batchSize);

      const embResult = await this.adapter.embed(batchTexts);

      const now = new Date().toISOString();
      for (let j = 0; j < batchEntities.length; j++) {
        const entity = batchEntities[j];
        const vector = embResult.embeddings[j];
        if (!entity || !vector) continue;
        this.storeEmbedding(entity.key, vector, model, now);
        totalComputed++;
      }
    }

    return {
      computed: totalComputed,
      skipped: entities.length - totalComputed,
      elapsedMs: performance.now() - t0,
    };
  }

  /**
   * Store a single embedding vector for an entity.
   */
  private async storeEmbedding(
    entityKey: string,
    vector: number[],
    model: string,
    computedAt: string
  ): Promise<void> {
    await this.db.run(
      `?[entity_key, vector_json, model, dimensions, computed_at] <- [[$ek, $vj, $m, $d, $ca]]
       :put entity_embeddings {entity_key => vector_json, model, dimensions, computed_at}`,
      {
        ek: entityKey,
        vj: JSON.stringify(vector),
        m: model,
        d: vector.length,
        ca: computedAt,
      }
    );
  }

  /**
   * Semantic search: embed the query text, then find the top-K most
   * similar entities by cosine similarity.
   */
  async semanticSearch(
    query: string,
    topK = 10,
    minSimilarity = 0.3
  ): Promise<SemanticSearchResult[]> {
    // Embed the query
    const embResult = await this.adapter.embed([query]);
    const queryVec = embResult.embeddings[0];
    if (!queryVec) return [];

    return this.findByVector(queryVec, topK, minSimilarity);
  }

  /**
   * Find similar entities to a given entity key.
   */
  async findSimilar(
    entityKey: string,
    topK = 10,
    minSimilarity = 0.3
  ): Promise<SemanticSearchResult[]> {
    // Load the entity's embedding
    const result = await this.db.run(
      "?[vector_json] := *entity_embeddings{entity_key, vector_json}, entity_key = $ek",
      { ek: entityKey }
    );
    if (result.rows.length === 0) return [];

    const vector = JSON.parse(result.rows[0]?.[0] as string) as number[];
    // Exclude the query entity itself
    return (await this.findByVector(vector, topK + 1, minSimilarity))
      .filter((r) => r.entityKey !== entityKey)
      .slice(0, topK);
  }

  /**
   * Core similarity search: compare a vector against all stored embeddings.
   */
  private async findByVector(
    queryVec: number[],
    topK: number,
    minSimilarity: number
  ): Promise<SemanticSearchResult[]> {
    // Load all embeddings (CozoDB has no native vector ops — we do cosine in JS)
    const all = await this.db.run(
      "?[entity_key, vector_json] := *entity_embeddings{entity_key, vector_json}"
    );

    const scored: Array<{ entityKey: string; similarity: number }> = [];
    for (const row of all.rows) {
      const key = row[0] as string;
      const vec = JSON.parse(row[1] as string) as number[];
      const sim = cosineSimilarity(queryVec, vec);
      if (sim >= minSimilarity) {
        scored.push({ entityKey: key, similarity: sim });
      }
    }

    // Sort descending by similarity, take top K
    scored.sort((a, b) => b.similarity - a.similarity);
    const topResults = scored.slice(0, topK);

    // Enrich with entity metadata
    const results: SemanticSearchResult[] = [];
    for (const s of topResults) {
      const entity = await this.db.run(
        `?[kind, name, file_path, signature] :=
          *entities{key, kind, name, file_path, signature}, key = $key`,
        { key: s.entityKey }
      );
      const row = entity.rows[0];
      results.push({
        entityKey: s.entityKey,
        similarity: Math.round(s.similarity * 1000) / 1000,
        kind: row ? (row[0] as string) : "",
        name: row ? (row[1] as string) : "",
        filePath: row ? (row[2] as string) : "",
        signature: row ? (row[3] as string) : "",
      });
    }
    return results;
  }

  /**
   * Get stats about stored embeddings.
   */
  async getStats(): Promise<EmbeddingStats> {
    const countResult = await this.db.run(
      "?[count(entity_key)] := *entity_embeddings{entity_key}"
    );
    const total =
      countResult.rows.length > 0 ? (countResult.rows[0]?.[0] as number) : 0;

    const modelResult = await this.db.run(
      "?[model, dimensions] := *entity_embeddings{entity_key, model, dimensions}, limit 1"
    );
    const model =
      modelResult.rows.length > 0 ? (modelResult.rows[0]?.[0] as string) : "";
    const dims =
      modelResult.rows.length > 0 ? (modelResult.rows[0]?.[1] as number) : 0;

    return { totalEmbeddings: total, model, dimensions: dims };
  }

  /**
   * Check if an entity has an embedding stored.
   */
  async hasEmbedding(entityKey: string): Promise<boolean> {
    const result = await this.db.run(
      "?[entity_key] := *entity_embeddings{entity_key}, entity_key = $ek",
      { ek: entityKey }
    );
    return result.rows.length > 0;
  }

  /**
   * Clear all stored embeddings. Used when model changes or on re-index.
   */
  async clearAll(): Promise<number> {
    const count = await this.db.run(
      "?[count(entity_key)] := *entity_embeddings{entity_key}"
    );
    const total = count.rows.length > 0 ? (count.rows[0]?.[0] as number) : 0;

    if (total > 0) {
      const keys = await this.db.run(
        "?[entity_key] := *entity_embeddings{entity_key}"
      );
      for (const row of keys.rows) {
        await this.db.run(
          "?[entity_key] <- [[$ek]] :rm entity_embeddings {entity_key}",
          { ek: row[0] as string }
        );
      }
    }
    return total;
  }
}
