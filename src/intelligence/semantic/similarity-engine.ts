/**
 * Combined Similarity Engine — weighted cosine across lexical + structural + metadata.
 *
 * Weights: 0.5 lexical (TF-IDF) + 0.3 structural (Node2Vec) + 0.2 metadata (domain + git)
 */

import { cosineSimilarity } from "./embedding-store.js";

export interface SimilarityWeights {
  lexical: number;
  structural: number;
  metadata: number;
}

const DEFAULT_WEIGHTS: SimilarityWeights = {
  lexical: 0.5,
  structural: 0.3,
  metadata: 0.2,
};

export interface EntityEmbeddings {
  lexical: Float32Array;
  structural: Float32Array;
  domain: string | null;
  keywords: string[];
}

export interface SimilarityResult {
  entityKey: string;
  score: number;
  lexicalScore: number;
  structuralScore: number;
  metadataScore: number;
}

/**
 * Compute combined similarity between two entities.
 */
export function computeSimilarity(
  a: EntityEmbeddings,
  b: EntityEmbeddings,
  weights: SimilarityWeights = DEFAULT_WEIGHTS,
): number {
  const lexicalSim = cosineSimilarity(a.lexical, b.lexical);
  const structuralSim = cosineSimilarity(a.structural, b.structural);
  const metadataSim = computeMetadataSimilarity(a, b);

  return (
    weights.lexical * lexicalSim +
    weights.structural * structuralSim +
    weights.metadata * metadataSim
  );
}

/**
 * Find the top-K most similar entities using the combined metric.
 */
export function findMostSimilar(
  queryKey: string,
  queryEmbeddings: EntityEmbeddings,
  allEmbeddings: Map<string, EntityEmbeddings>,
  topK = 10,
  weights: SimilarityWeights = DEFAULT_WEIGHTS,
): SimilarityResult[] {
  const results: SimilarityResult[] = [];

  for (const [key, embeddings] of allEmbeddings) {
    if (key === queryKey) continue;

    const lexicalScore = cosineSimilarity(
      queryEmbeddings.lexical,
      embeddings.lexical,
    );
    const structuralScore = cosineSimilarity(
      queryEmbeddings.structural,
      embeddings.structural,
    );
    const metadataScore = computeMetadataSimilarity(
      queryEmbeddings,
      embeddings,
    );

    const score =
      weights.lexical * lexicalScore +
      weights.structural * structuralScore +
      weights.metadata * metadataScore;

    results.push({
      entityKey: key,
      score,
      lexicalScore,
      structuralScore,
      metadataScore,
    });
  }

  results.sort((a, b) => b.score - a.score);
  return results.slice(0, topK);
}

function computeMetadataSimilarity(
  a: EntityEmbeddings,
  b: EntityEmbeddings,
): number {
  let score = 0;

  if (a.domain && b.domain && a.domain === b.domain) {
    score += 0.5;
  }

  if (a.keywords.length > 0 && b.keywords.length > 0) {
    const aSet = new Set(a.keywords);
    const overlap = b.keywords.filter((k) => aSet.has(k)).length;
    const maxPossible = Math.max(a.keywords.length, b.keywords.length);
    score += 0.5 * (overlap / maxPossible);
  }

  return Math.min(1, score);
}
