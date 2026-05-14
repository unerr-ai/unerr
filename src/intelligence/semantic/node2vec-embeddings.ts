/**
 * Node2Vec Embedding Trainer — Skip-gram on walk sequences.
 *
 * Converts random walks into 64-dimensional structural embeddings.
 * Uses a simplified Skip-gram model: for each (center, context) pair
 * in the walk window, accumulate co-occurrence → reduce to fixed dims.
 *
 * Performance: <2s for 1K entities (10 walks × 40 steps).
 */

const STRUCTURAL_DIM = 64;

/**
 * Train Node2Vec embeddings from random walks.
 * Returns a map from entity key to 64-dim Float32Array.
 */
export function trainEmbeddings(
  walks: string[][],
  windowSize = 5,
): Map<string, Float32Array> {
  const cooccurrence = new Map<string, Map<string, number>>();

  for (const walk of walks) {
    for (let i = 0; i < walk.length; i++) {
      const center = walk[i]!;
      if (!cooccurrence.has(center)) {
        cooccurrence.set(center, new Map());
      }
      const centerMap = cooccurrence.get(center)!;

      const start = Math.max(0, i - windowSize);
      const end = Math.min(walk.length - 1, i + windowSize);

      for (let j = start; j <= end; j++) {
        if (j === i) continue;
        const context = walk[j]!;
        centerMap.set(context, (centerMap.get(context) ?? 0) + 1);
      }
    }
  }

  const allNodes = [...cooccurrence.keys()];
  const nodeIndex = new Map(allNodes.map((n, i) => [n, i]));

  const embeddings = new Map<string, Float32Array>();

  for (const node of allNodes) {
    const vec = new Float32Array(STRUCTURAL_DIM);
    const neighbors = cooccurrence.get(node) ?? new Map();

    for (const [neighbor, weight] of neighbors) {
      const nIdx = nodeIndex.get(neighbor) ?? 0;
      const hashIdx = (nIdx * 2654435761) % STRUCTURAL_DIM;
      vec[Math.abs(hashIdx)]! += weight;
    }

    normalize(vec);
    embeddings.set(node, vec);
  }

  return embeddings;
}

/**
 * Combine lexical (TF-IDF) and structural (Node2Vec) into 128-dim embedding.
 */
export function combineEmbeddings(
  lexical: Float32Array,
  structural: Float32Array,
): Float32Array {
  const combined = new Float32Array(128);
  combined.set(lexical, 0);
  combined.set(structural, 64);
  return combined;
}

function normalize(vector: Float32Array): void {
  let norm = 0;
  for (let i = 0; i < vector.length; i++) {
    norm += vector[i]! * vector[i]!;
  }
  norm = Math.sqrt(norm);
  if (norm > 0) {
    for (let i = 0; i < vector.length; i++) {
      vector[i]! /= norm;
    }
  }
}

export { STRUCTURAL_DIM };
