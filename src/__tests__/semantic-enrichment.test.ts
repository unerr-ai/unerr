/**
 * Sprint SE.11-SE.15: Semantic enrichment tests.
 *
 * Tests: identifier tokenizer, TF-IDF, Node2Vec, similarity engine.
 */

import { describe, expect, it } from "vitest";
import {
  extractDocComment,
  extractDocTags,
} from "../intelligence/semantic/docstring-extractor.js";
import {
  cosineSimilarity,
  decodeEmbedding,
  encodeEmbedding,
  findSimilar,
} from "../intelligence/semantic/embedding-store.js";
import { runEnrichment } from "../intelligence/semantic/enrichment-orchestrator.js";
import { extractKeywords } from "../intelligence/semantic/git-message-miner.js";
import {
  buildTokenFrequency,
  tokenizeFilePath,
  tokenizeIdentifier,
} from "../intelligence/semantic/identifier-tokenizer.js";
import {
  STRUCTURAL_DIM,
  combineEmbeddings,
  trainEmbeddings,
} from "../intelligence/semantic/node2vec-embeddings.js";
import {
  buildAdjacencyFromEdges,
  generateWalks,
} from "../intelligence/semantic/node2vec-walks.js";
import {
  getPrimaryDomain,
  inferDomain,
} from "../intelligence/semantic/path-domain-inference.js";
import {
  type EntityEmbeddings,
  computeSimilarity,
  findMostSimilar,
} from "../intelligence/semantic/similarity-engine.js";
import {
  VECTOR_DIM,
  buildCorpus,
  buildTfIdfVectors,
  computeTfIdfVector,
} from "../intelligence/semantic/tfidf-vectors.js";

describe("Identifier Tokenizer (SE.1)", () => {
  it("tokenizes camelCase", () => {
    expect(tokenizeIdentifier("getUserProfile")).toEqual([
      "get",
      "user",
      "profile",
    ]);
  });

  it("tokenizes PascalCase", () => {
    expect(tokenizeIdentifier("UserService")).toEqual(["user", "service"]);
  });

  it("tokenizes snake_case", () => {
    expect(tokenizeIdentifier("get_user_profile")).toEqual([
      "get",
      "user",
      "profile",
    ]);
  });

  it("tokenizes kebab-case", () => {
    expect(tokenizeIdentifier("get-user-profile")).toEqual([
      "get",
      "user",
      "profile",
    ]);
  });

  it("handles acronyms", () => {
    const tokens = tokenizeIdentifier("HTMLParser");
    expect(tokens).toContain("html");
    expect(tokens).toContain("parser");
  });

  it("handles numbers", () => {
    const tokens = tokenizeIdentifier("base64Encode");
    expect(tokens.length).toBeGreaterThanOrEqual(2);
  });

  it("returns empty for empty string", () => {
    expect(tokenizeIdentifier("")).toEqual([]);
  });

  it("tokenizes file paths", () => {
    const tokens = tokenizeFilePath("src/auth/user-service.ts");
    expect(tokens).toContain("auth");
    expect(tokens).toContain("user");
    expect(tokens).toContain("service");
  });

  it("builds token frequency", () => {
    const freq = buildTokenFrequency(["getUserProfile", "getOrderProfile"]);
    expect(freq.get("get")).toBe(2);
    expect(freq.get("profile")).toBe(2);
  });
});

describe("TF-IDF Vectors (SE.2)", () => {
  it("produces 64-dimensional vectors", () => {
    const corpus = buildCorpus([
      "getUserProfile",
      "processOrder",
      "validateInput",
    ]);
    const vec = computeTfIdfVector("getUserProfile", corpus);
    expect(vec.length).toBe(VECTOR_DIM);
    expect(vec.length).toBe(64);
  });

  it("vectors are normalized to unit length", () => {
    const corpus = buildCorpus(["getUserProfile", "processOrder"]);
    const vec = computeTfIdfVector("getUserProfile", corpus);
    let norm = 0;
    for (let i = 0; i < vec.length; i++) norm += vec[i]! * vec[i]!;
    expect(Math.abs(Math.sqrt(norm) - 1.0)).toBeLessThan(0.01);
  });

  it("similar names produce closer vectors", () => {
    const identifiers = ["getUserProfile", "getUserSettings", "processPayment"];
    const corpus = buildCorpus(identifiers);
    const v1 = computeTfIdfVector("getUserProfile", corpus);
    const v2 = computeTfIdfVector("getUserSettings", corpus);
    const v3 = computeTfIdfVector("processPayment", corpus);

    const sim12 = cosineSimilarity(v1, v2);
    const sim13 = cosineSimilarity(v1, v3);
    expect(sim12).toBeGreaterThan(sim13);
  });

  it("buildTfIdfVectors produces correct count", () => {
    const vectors = buildTfIdfVectors(["a", "b", "c"]);
    expect(vectors.size).toBe(3);
  });
});

describe("Node2Vec (SE.3 + SE.4)", () => {
  it("generates deterministic walks (same seed)", () => {
    const adj = new Map([
      ["a", ["b", "c"]],
      ["b", ["a", "c"]],
      ["c", ["a", "b"]],
    ]);

    const walks1 = generateWalks(adj, {
      seed: 42,
      walksPerNode: 2,
      walkLength: 5,
    });
    const walks2 = generateWalks(adj, {
      seed: 42,
      walksPerNode: 2,
      walkLength: 5,
    });

    expect(walks1).toEqual(walks2);
  });

  it("different seeds produce different walks", () => {
    const adj = new Map([
      ["a", ["b", "c", "d"]],
      ["b", ["a", "c"]],
      ["c", ["a", "b"]],
      ["d", ["a"]],
    ]);

    const walks1 = generateWalks(adj, {
      seed: 42,
      walksPerNode: 2,
      walkLength: 10,
    });
    const walks2 = generateWalks(adj, {
      seed: 99,
      walksPerNode: 2,
      walkLength: 10,
    });

    const flat1 = walks1.flat().join(",");
    const flat2 = walks2.flat().join(",");
    expect(flat1).not.toBe(flat2);
  });

  it("walks respect graph structure (only visit neighbors)", () => {
    const adj = new Map([
      ["a", ["b"]],
      ["b", ["a", "c"]],
      ["c", ["b"]],
    ]);

    const walks = generateWalks(adj, {
      seed: 42,
      walksPerNode: 1,
      walkLength: 5,
    });
    for (const walk of walks) {
      for (let i = 1; i < walk.length; i++) {
        const prev = walk[i - 1]!;
        const curr = walk[i]!;
        expect(adj.get(prev)).toContain(curr);
      }
    }
  });

  it("trainEmbeddings produces 64-dim vectors", () => {
    const walks = [
      ["a", "b", "c", "a"],
      ["b", "c", "a", "b"],
    ];
    const embeddings = trainEmbeddings(walks);
    expect(embeddings.size).toBe(3);
    for (const [_, vec] of embeddings) {
      expect(vec.length).toBe(STRUCTURAL_DIM);
      expect(vec.length).toBe(64);
    }
  });

  it("combineEmbeddings produces 128-dim output", () => {
    const lexical = new Float32Array(64);
    const structural = new Float32Array(64);
    const combined = combineEmbeddings(lexical, structural);
    expect(combined.length).toBe(128);
  });

  it("buildAdjacencyFromEdges works", () => {
    const edges = [
      { from_key: "a", to_key: "b" },
      { from_key: "b", to_key: "c" },
    ];
    const adj = buildAdjacencyFromEdges(edges);
    expect(adj.get("a")).toContain("b");
    expect(adj.get("b")).toContain("a");
    expect(adj.get("b")).toContain("c");
  });
});

describe("Docstring Extractor (SE.6)", () => {
  it("extracts JSDoc comment", () => {
    const source = `/**
 * Process a payment.
 * @param amount - The amount
 * @returns Receipt
 */
function processPayment(amount: number) {}`;
    const doc = extractDocComment(source, 6);
    expect(doc).toContain("Process a payment");
  });

  it("extracts doc tags", () => {
    const doc = "Process payment. @param amount @returns Receipt @deprecated";
    const tags = extractDocTags(doc);
    expect(tags).toContain("param");
    expect(tags).toContain("returns");
    expect(tags).toContain("deprecated");
  });

  it("returns null for no comment", () => {
    expect(extractDocComment("function foo() {}", 1)).toBeNull();
  });
});

describe("Path Domain Inference (SE.7)", () => {
  it("infers auth domain", () => {
    const labels = inferDomain("src/auth/login.ts");
    expect(labels[0]?.domain).toBe("authentication");
  });

  it("infers testing domain", () => {
    expect(getPrimaryDomain("src/__tests__/auth.test.ts")).toBe("testing");
  });

  it("infers database domain", () => {
    expect(getPrimaryDomain("src/db/migrations/001.ts")).toBe("database");
  });

  it("returns null for unknown paths", () => {
    expect(getPrimaryDomain("src/foo/bar.ts")).toBeNull();
  });
});

describe("Embedding Store (SE.8)", () => {
  it("encodes and decodes embeddings correctly", () => {
    const original = new Float32Array([1.0, 2.0, 3.0, -0.5]);
    const encoded = encodeEmbedding(original);
    const decoded = decodeEmbedding(encoded);

    expect(decoded.length).toBe(original.length);
    for (let i = 0; i < original.length; i++) {
      expect(Math.abs(decoded[i]! - original[i]!)).toBeLessThan(0.001);
    }
  });

  it("cosine similarity of identical vectors is 1", () => {
    const vec = new Float32Array([1, 0, 0, 1]);
    expect(cosineSimilarity(vec, vec)).toBeCloseTo(1.0);
  });

  it("cosine similarity of orthogonal vectors is 0", () => {
    const a = new Float32Array([1, 0, 0, 0]);
    const b = new Float32Array([0, 1, 0, 0]);
    expect(cosineSimilarity(a, b)).toBeCloseTo(0.0);
  });

  it("findSimilar returns ranked results", () => {
    const query = new Float32Array([1, 0, 0, 0]);
    const embeddings = new Map([
      ["close", new Float32Array([0.9, 0.1, 0, 0])],
      ["far", new Float32Array([0, 0, 0, 1])],
    ]);

    const results = findSimilar(query, embeddings, 2);
    expect(results[0]!.entityKey).toBe("close");
    expect(results[0]!.similarity).toBeGreaterThan(results[1]!.similarity);
  });
});

describe("Similarity Engine (SE.9)", () => {
  it("entities with similar names AND structure rank highest", () => {
    const queryEmb: EntityEmbeddings = {
      lexical: new Float32Array(64).fill(0.1),
      structural: new Float32Array(64).fill(0.1),
      domain: "authentication",
      keywords: ["get", "user"],
    };

    const similar: EntityEmbeddings = {
      lexical: new Float32Array(64).fill(0.09),
      structural: new Float32Array(64).fill(0.09),
      domain: "authentication",
      keywords: ["get", "profile"],
    };

    const different: EntityEmbeddings = {
      lexical: new Float32Array(64).fill(-0.1),
      structural: new Float32Array(64).fill(-0.1),
      domain: "payments",
      keywords: ["process", "payment"],
    };

    const scoreSimilar = computeSimilarity(queryEmb, similar);
    const scoreDifferent = computeSimilarity(queryEmb, different);

    expect(scoreSimilar).toBeGreaterThan(scoreDifferent);
  });

  it("findMostSimilar returns sorted results", () => {
    const query: EntityEmbeddings = {
      lexical: new Float32Array(64).fill(0.1),
      structural: new Float32Array(64).fill(0.1),
      domain: "auth",
      keywords: ["login"],
    };

    const all = new Map<string, EntityEmbeddings>([
      ["query", query],
      ["close", { ...query, domain: "auth" }],
      [
        "far",
        {
          lexical: new Float32Array(64).fill(-0.1),
          structural: new Float32Array(64).fill(-0.1),
          domain: "payments",
          keywords: [],
        },
      ],
    ]);

    const results = findMostSimilar("query", query, all, 2);
    expect(results.length).toBe(2);
    expect(results[0]!.score).toBeGreaterThanOrEqual(results[1]!.score);
  });
});

describe("Git Message Mining (SE.5)", () => {
  it("extracts keywords from commit messages", () => {
    const messages = [
      "Fix authentication bug in login handler",
      "Refactor login to use JWT tokens",
      "Add unit tests for authentication flow",
    ];
    const keywords = extractKeywords(messages);
    expect(keywords).toContain("login");
    expect(keywords).toContain("authentication");
    expect(keywords.length).toBeGreaterThan(0);
    expect(keywords.length).toBeLessThanOrEqual(20);
  });

  it("filters stopwords", () => {
    const keywords = extractKeywords([
      "the quick brown fox is not a good test",
    ]);
    expect(keywords).not.toContain("the");
    expect(keywords).not.toContain("is");
    expect(keywords).not.toContain("not");
  });
});

describe("Enrichment Orchestrator (SE.10)", () => {
  it("runs full enrichment pipeline", async () => {
    const result = await runEnrichment({
      entities: [
        { key: "e1", name: "getUserProfile", file_path: "src/auth/user.ts" },
        {
          key: "e2",
          name: "processPayment",
          file_path: "src/payments/checkout.ts",
        },
        {
          key: "e3",
          name: "validateInput",
          file_path: "src/utils/validate.ts",
        },
      ],
      edges: [
        { from_key: "e1", to_key: "e3" },
        { from_key: "e2", to_key: "e3" },
      ],
    });

    expect(result.entityCount).toBe(3);
    expect(result.embeddings.size).toBe(3);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);

    const e1 = result.embeddings.get("e1")!;
    expect(e1.lexical.length).toBe(64);
    expect(e1.structural.length).toBe(64);
    expect(e1.domain).toBe("authentication");
  });

  it("handles empty input", async () => {
    const result = await runEnrichment({ entities: [], edges: [] });
    expect(result.entityCount).toBe(0);
    expect(result.embeddings.size).toBe(0);
  });
});
