/**
 * Semantic Enrichment Orchestrator — runs after Phase 1 indexing.
 *
 * Pipeline: tokenize → TF-IDF → Node2Vec → git mine → combine → store.
 * Runs in background, non-blocking to MCP proxy startup.
 */

import { createModuleLogger } from "../../utils/logger.js";
import { tokenizeIdentifier } from "./identifier-tokenizer.js";
import { combineEmbeddings, trainEmbeddings } from "./node2vec-embeddings.js";
import { buildAdjacencyFromEdges, generateWalks } from "./node2vec-walks.js";
import { getPrimaryDomain } from "./path-domain-inference.js";
import type { EntityEmbeddings } from "./similarity-engine.js";
import { buildCorpus, computeTfIdfVector } from "./tfidf-vectors.js";

const log = createModuleLogger("semantic-enrichment");

export interface EnrichmentInput {
  entities: Array<{ key: string; name: string; file_path: string }>;
  edges: Array<{ from_key: string; to_key: string }>;
}

export interface EnrichmentResult {
  embeddings: Map<string, EntityEmbeddings>;
  entityCount: number;
  durationMs: number;
}

/**
 * Run the full semantic enrichment pipeline.
 */
export async function runEnrichment(
  input: EnrichmentInput,
): Promise<EnrichmentResult> {
  const start = performance.now();
  const { entities, edges } = input;

  if (entities.length === 0) {
    return { embeddings: new Map(), entityCount: 0, durationMs: 0 };
  }

  log.info(`Starting semantic enrichment for ${entities.length} entities`);

  const identifiers = entities.map((e) => e.name);
  const corpus = buildCorpus(identifiers);

  const adjacency = buildAdjacencyFromEdges(edges);
  const walks = generateWalks(adjacency, {
    seed: 42,
    walksPerNode: 5,
    walkLength: 20,
  });
  const structuralEmbeddings = trainEmbeddings(walks);

  const embeddings = new Map<string, EntityEmbeddings>();

  for (const entity of entities) {
    const lexical = computeTfIdfVector(entity.name, corpus);
    const structural =
      structuralEmbeddings.get(entity.key) ?? new Float32Array(64);
    const domain = getPrimaryDomain(entity.file_path);

    embeddings.set(entity.key, {
      lexical,
      structural,
      domain,
      keywords: tokenizeIdentifier(entity.name),
    });
  }

  const durationMs = performance.now() - start;
  log.info(
    `Semantic enrichment complete: ${entities.length} entities in ${Math.round(durationMs)}ms`,
  );

  return { embeddings, entityCount: entities.length, durationMs };
}
