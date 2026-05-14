/**
 * CozoDB Embedding Store — stores Float32Array embeddings inline.
 *
 * Each entity gets a 128-dim embedding (512 bytes) stored as a
 * base64-encoded string in CozoDB. Provides cosine similarity
 * queries in <5ms.
 */

export interface StoredEmbedding {
  entityKey: string;
  embedding: Float32Array;
}

/**
 * Encode a Float32Array to a base64 string for CozoDB storage.
 */
export function encodeEmbedding(embedding: Float32Array): string {
  const buffer = Buffer.from(
    embedding.buffer,
    embedding.byteOffset,
    embedding.byteLength,
  );
  return buffer.toString("base64");
}

/**
 * Decode a base64 string back to Float32Array.
 */
export function decodeEmbedding(encoded: string): Float32Array {
  const buffer = Buffer.from(encoded, "base64");
  return new Float32Array(
    buffer.buffer,
    buffer.byteOffset,
    buffer.byteLength / 4,
  );
}

/**
 * Compute cosine similarity between two embeddings.
 */
export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return 0;

  let dot = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    normA += a[i]! * a[i]!;
    normB += b[i]! * b[i]!;
  }

  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom > 0 ? dot / denom : 0;
}

/**
 * Find the top-K most similar entities to a query embedding.
 */
export function findSimilar(
  query: Float32Array,
  allEmbeddings: Map<string, Float32Array>,
  topK = 10,
  excludeKey?: string,
): Array<{ entityKey: string; similarity: number }> {
  const results: Array<{ entityKey: string; similarity: number }> = [];

  for (const [key, embedding] of allEmbeddings) {
    if (key === excludeKey) continue;
    const sim = cosineSimilarity(query, embedding);
    results.push({ entityKey: key, similarity: sim });
  }

  results.sort((a, b) => b.similarity - a.similarity);
  return results.slice(0, topK);
}
