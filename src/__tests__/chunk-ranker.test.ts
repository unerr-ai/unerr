import { describe, expect, it } from "vitest";
import {
  type RankableChunk,
  rankChunksByQuery,
  resolveCurrentQuery,
} from "../intelligence/chunk-ranker.js";

describe("rankChunksByQuery — BM25 lexical ranking", () => {
  it("ranks an on-query chunk above an off-query one", () => {
    const chunks: RankableChunk[] = [
      { text: "the quick brown fox jumps over the lazy dog in the meadow" },
      {
        text: "database connection pool retry logic with exponential backoff and jitter",
      },
    ];
    const ranked = rankChunksByQuery(chunks, "database connection retry");
    // The chunk that mentions the query terms must come first.
    expect(ranked[0]!.index).toBe(1);
    expect(ranked[0]!.score).toBeGreaterThan(ranked[1]!.score);
  });

  it("returns every input chunk exactly once", () => {
    const chunks: RankableChunk[] = [
      { text: "alpha beta gamma payload one" },
      { text: "delta epsilon zeta payload two" },
      { text: "eta theta iota payload three" },
    ];
    const ranked = rankChunksByQuery(chunks, "beta payload");
    const indices = ranked.map((r) => r.index).sort((a, b) => a - b);
    expect(indices).toEqual([0, 1, 2]);
  });
});

describe("rankChunksByQuery — graph-proximity term", () => {
  it("boosts a structurally-near chunk to the top via the proximity fn", () => {
    // Two chunks with identical (zero) lexical overlap with the query, so BM25
    // alone leaves them tied → original-index order (chunk 0 first).
    const chunks: RankableChunk[] = [
      {
        text: "completely unrelated prose about gardening tools",
        entityKey: "far",
      },
      {
        text: "completely unrelated prose about gardening tools",
        entityKey: "near",
      },
    ];
    const proximity = (key: string) => (key === "near" ? 1 : 0);
    const ranked = rankChunksByQuery(
      chunks,
      "authentication token validation",
      {
        graphProximity: proximity,
      }
    );
    // The structurally-near chunk (index 1) now outranks the far one.
    expect(ranked[0]!.index).toBe(1);
    expect(ranked[0]!.score).toBeGreaterThan(ranked[1]!.score);
  });

  it("proximity breaks an otherwise-lexical tie without swamping a strong lexical match", () => {
    const chunks: RankableChunk[] = [
      // Strong lexical match, no proximity boost.
      { text: "retry retry retry connection pool retry", entityKey: "lex" },
      // No lexical match but maximal proximity.
      { text: "irrelevant gardening content", entityKey: "prox" },
    ];
    const ranked = rankChunksByQuery(chunks, "retry connection pool", {
      graphProximity: (k) => (k === "prox" ? 1 : 0),
    });
    // The strong lexical match still wins over a pure-proximity chunk.
    expect(ranked[0]!.index).toBe(0);
  });

  it("BM25-only when no proximity fn is supplied", () => {
    const chunks: RankableChunk[] = [
      { text: "alpha alpha alpha keyword match", entityKey: "x" },
      { text: "no match here at all", entityKey: "y" },
    ];
    const ranked = rankChunksByQuery(chunks, "keyword");
    expect(ranked[0]!.index).toBe(0);
  });
});

describe("rankChunksByQuery — determinism & ties", () => {
  it("same input twice yields identical ordering", () => {
    const chunks: RankableChunk[] = [
      { text: "service mesh sidecar proxy routing rules" },
      { text: "kubernetes pod scheduling and node affinity" },
      { text: "service discovery and load balancing across the mesh" },
    ];
    const a = rankChunksByQuery(chunks, "service mesh routing");
    const b = rankChunksByQuery(chunks, "service mesh routing");
    expect(a).toEqual(b);
  });

  it("ties (equal score) break by ascending original index", () => {
    // None of these chunks contain the query terms → all score 0 → tie.
    const chunks: RankableChunk[] = [
      { text: "one apple banana" },
      { text: "two cherry date" },
      { text: "three fig grape" },
    ];
    const ranked = rankChunksByQuery(chunks, "zzz qqq xyz");
    expect(ranked.map((r) => r.index)).toEqual([0, 1, 2]);
    for (const r of ranked) expect(r.score).toBe(0);
  });
});

describe("rankChunksByQuery — edge cases", () => {
  it("empty chunk list returns empty", () => {
    expect(rankChunksByQuery([], "anything")).toEqual([]);
  });

  it("empty query returns chunks in original index order, score 0", () => {
    const chunks: RankableChunk[] = [
      { text: "first chunk text" },
      { text: "second chunk text" },
    ];
    const ranked = rankChunksByQuery(chunks, "");
    expect(ranked.map((r) => r.index)).toEqual([0, 1]);
    for (const r of ranked) expect(r.score).toBe(0);
  });

  it("whitespace-only query is treated as empty", () => {
    const chunks: RankableChunk[] = [
      { text: "first chunk text" },
      { text: "second chunk text" },
    ];
    const ranked = rankChunksByQuery(chunks, "   \t\n  ");
    expect(ranked.map((r) => r.index)).toEqual([0, 1]);
  });

  it("query of only stopwords/single-chars resolves to no terms → identity order", () => {
    const chunks: RankableChunk[] = [
      { text: "meaningful content alpha" },
      { text: "other content beta" },
    ];
    const ranked = rankChunksByQuery(chunks, "the is a of");
    expect(ranked.map((r) => r.index)).toEqual([0, 1]);
  });
});

describe("resolveCurrentQuery — precedence", () => {
  it("prefers the unerr_context prompt arg when present", () => {
    expect(
      resolveCurrentQuery({
        unerrContextPrompt: "add retry to fetchUser",
        latestUserPrompt: "what does this repo do",
      })
    ).toBe("add retry to fetchUser");
  });

  it("falls back to the latest user prompt when no context arg", () => {
    expect(
      resolveCurrentQuery({ latestUserPrompt: "what does this repo do" })
    ).toBe("what does this repo do");
  });

  it("returns null when neither is present", () => {
    expect(resolveCurrentQuery({})).toBeNull();
  });

  it("treats a blank context prompt as absent and falls through", () => {
    expect(
      resolveCurrentQuery({
        unerrContextPrompt: "   ",
        latestUserPrompt: "real task",
      })
    ).toBe("real task");
  });

  it("returns null when both are blank/whitespace", () => {
    expect(
      resolveCurrentQuery({ unerrContextPrompt: "  ", latestUserPrompt: "\t" })
    ).toBeNull();
  });

  it("trims surrounding whitespace from the resolved query", () => {
    expect(
      resolveCurrentQuery({ unerrContextPrompt: "  build the ranker  " })
    ).toBe("build the ranker");
  });
});
