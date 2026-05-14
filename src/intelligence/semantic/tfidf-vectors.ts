/**
 * TF-IDF Vector Builder — produces 64-dimensional lexical embeddings.
 *
 * Corpus: all entity identifiers in the project.
 * Method: standard TF-IDF with dimensionality reduction via hashing trick.
 *
 * Output: Float32Array[64] per entity, normalized to unit length.
 * Performance: <500ms for 1K entities.
 */

import { tokenizeIdentifier } from "./identifier-tokenizer.js";

export interface TfIdfCorpus {
  vocabulary: Map<string, number>;
  idf: Map<string, number>;
  documentCount: number;
}

/**
 * Build a TF-IDF corpus from entity identifiers.
 */
export function buildCorpus(identifiers: string[]): TfIdfCorpus {
  const documentFrequency = new Map<string, number>();
  const vocabulary = new Map<string, number>();
  let vocabIndex = 0;

  for (const id of identifiers) {
    const tokens = new Set(tokenizeIdentifier(id));
    for (const token of tokens) {
      documentFrequency.set(token, (documentFrequency.get(token) ?? 0) + 1);
      if (!vocabulary.has(token)) {
        vocabulary.set(token, vocabIndex++);
      }
    }
  }

  const idf = new Map<string, number>();
  const N = identifiers.length;

  for (const [token, df] of documentFrequency) {
    idf.set(token, Math.log((N + 1) / (df + 1)) + 1);
  }

  return { vocabulary, idf, documentCount: N };
}

const VECTOR_DIM = 64;

/**
 * Compute a 64-dim TF-IDF vector for a single identifier.
 * Uses hashing trick for dimensionality reduction.
 */
export function computeTfIdfVector(
  identifier: string,
  corpus: TfIdfCorpus,
): Float32Array {
  const vector = new Float32Array(VECTOR_DIM);
  const tokens = tokenizeIdentifier(identifier);

  if (tokens.length === 0) return vector;

  const tokenCounts = new Map<string, number>();
  for (const token of tokens) {
    tokenCounts.set(token, (tokenCounts.get(token) ?? 0) + 1);
  }

  for (const [token, count] of tokenCounts) {
    const tf = count / tokens.length;
    const idfVal = corpus.idf.get(token) ?? 1;
    const tfidf = tf * idfVal;

    const hashIdx = hashToken(token) % VECTOR_DIM;
    vector[hashIdx]! += tfidf;
  }

  normalize(vector);
  return vector;
}

/**
 * Build TF-IDF vectors for all entities at once.
 */
export function buildTfIdfVectors(
  identifiers: string[],
): Map<string, Float32Array> {
  const corpus = buildCorpus(identifiers);
  const vectors = new Map<string, Float32Array>();

  for (const id of identifiers) {
    vectors.set(id, computeTfIdfVector(id, corpus));
  }

  return vectors;
}

function hashToken(token: string): number {
  let hash = 0;
  for (let i = 0; i < token.length; i++) {
    hash = ((hash << 5) - hash + token.charCodeAt(i)) | 0;
  }
  return Math.abs(hash);
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

export { VECTOR_DIM };
