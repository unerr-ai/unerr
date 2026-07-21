/**
 * Verifies the wire-cap nudge interpolation is concrete (numeric values, not
 * literal `N`) and context-aware (knows whether entity/limit/token_budget
 * were already set).
 *
 * Before this change, the same generic "narrow with limit:N/entity:<name> or
 * token_budget:N" hint reappeared on every retry — even when the caller had
 * already passed entity: or token_budget: — producing a retry loop.
 */

import { describe, expect, it } from "vitest";
import { estimateTokenCount } from "../intelligence/token-estimator.js";
import { applyWireCap } from "../proxy/wire-cap.js";

// Realistic code-like text, NOT "x".repeat — the wire cap counts real BPE
// tokens, and a run of one repeated char collapses to far fewer tokens than its
// length, so it would not overflow the token cap the way real content does.
function bigString(bytes: number): string {
  const line =
    "const result = computeValue(alpha, beta, gamma, delta); // note\n";
  return line.repeat(Math.ceil(bytes / line.length)).slice(0, bytes);
}

describe("wire-cap too_large nudge — concrete & context-aware", () => {
  it("emits a numeric suggested_token_budget in the body", () => {
    const oversized = bigString(20_000);
    const { body, pageHint } = applyWireCap("file_read", oversized, {});
    const obj = body as Record<string, unknown>;
    expect(obj.status).toBe("too_large");
    expect(typeof obj.suggested_token_budget).toBe("number");
    expect(obj.needed_tokens).toBeGreaterThan(0);
    expect(pageHint).toMatch(/token_budget:\d+/);
    expect(pageHint).not.toMatch(/token_budget:N/);
  });

  it("uses `entity_too_large` reason when caller already passed entity", () => {
    const oversized = bigString(20_000);
    const { body, pageHint } = applyWireCap("file_read", oversized, {
      entity: "indexLocalProject",
    });
    const obj = body as Record<string, unknown>;
    expect(obj.reason).toBe("entity_too_large");
    expect(obj.entity).toBe("indexLocalProject");
    expect(pageHint).toContain("offset/limit");
    // Critical: must NOT tell caller to "narrow with entity:" — they did.
    expect(pageHint).not.toContain("entity:<name>");
  });

  it("echoes the requested_token_budget when caller already set one", () => {
    const oversized = bigString(40_000);
    const { body } = applyWireCap("file_read", oversized, {
      token_budget: 2000,
    });
    const obj = body as Record<string, unknown>;
    expect(obj.requested_token_budget).toBe(2000);
    expect(obj.suggested_token_budget).toBeGreaterThan(2000);
  });

  it("uses `page_too_large` and shrinks the limit when paginated", () => {
    const oversized = bigString(20_000);
    const { body, pageHint } = applyWireCap("search_code", oversized, {
      limit: 100,
    });
    const obj = body as Record<string, unknown>;
    expect(obj.reason).toBe("page_too_large");
    expect(pageHint).toMatch(/limit:\d+/);
    expect(pageHint).not.toMatch(/limit:N/);
  });

  it("uses `narrow_required` when token_budget was lifted and still overflowed", () => {
    // 16384 / 4 = 4096 — bump well above HARD_BYTE_CAP so a token_budget of
    // 5000 lifts the cap to 20000 bytes, but the payload is bigger still.
    const oversized = bigString(30_000);
    const { body } = applyWireCap("file_read", oversized, {
      token_budget: 5000,
    });
    const obj = body as Record<string, unknown>;
    expect(obj.reason).toBe("narrow_required");
  });
});

describe("wire-cap pagination hint — concrete next cursor", () => {
  it("emits a numeric cursor (not the literal N)", () => {
    // search_code returns a top-level array; its cursorArg is `limit`.
    const arr = Array.from({ length: 50 }, (_, i) => ({ id: i }));
    const { pageHint } = applyWireCap("search_code", arr, {});
    // Cursor should be a real number, never the placeholder.
    expect(pageHint).toMatch(/:\d+/);
    expect(pageHint).not.toMatch(/:N(\s|\/|$)/);
  });
});

describe("wire-cap fetch_url too_large hint", () => {
  function oversizedFetchBody() {
    return {
      result_status: "ok" as const,
      url: "https://x",
      final_url: "https://x",
      status: 200,
      title: "t",
      extractor: "defuddle" as const,
      word_count: 1000,
      raw_bytes: 50_000,
      extracted_bytes: 30_000,
      compression_ratio: 0.4,
      cache_hit: false,
      passages: Array.from({ length: 1 }, (_, i) => ({
        index: i,
        heading: null,
        text: "x".repeat(20_000),
        start_line: 1,
      })),
      total: 1,
      quality: {
        playwright_rescued: false,
        bm25_ranked: false,
        rule_applied: null,
      },
    };
  }

  it("recommends `prompt:<keywords>` when no prompt is set", () => {
    const { pageHint, body } = applyWireCap(
      "fetch_url",
      oversizedFetchBody(),
      {}
    );
    const obj = body as Record<string, unknown>;
    expect(obj.status).toBe("too_large");
    expect(pageHint).toMatch(/prompt:<keywords>/);
    expect(pageHint).toMatch(/limit:\d+/);
    expect(pageHint).toMatch(/token_budget:\d+/);
    expect(pageHint).not.toMatch(/entity:<name>/);
  });

  it("does not re-suggest prompt when one is already set", () => {
    const { pageHint } = applyWireCap("fetch_url", oversizedFetchBody(), {
      prompt: "rate limits and quotas",
    });
    expect(pageHint).toMatch(/BM25-ranked/);
    expect(pageHint).not.toMatch(/prompt:<keywords>/);
  });
});

describe("wire-cap suggested_token_budget clears the cap on retry (no undershoot loop)", () => {
  // Regression for the file_read entity-overflow loop. The wire cap now counts
  // real BPE tokens (estimateTokenCount) — the SAME metric as `token_budget` —
  // so the suggested budget (this response's token count, rounded up to 100)
  // clears the cap on retry by construction. Previously the cap was byte-based
  // (token_budget × 4) while the suggestion was BPE-token-based; for code at
  // ~4.1 bytes/token the suggestion's byte cap stayed below the payload, so
  // retrying the suggested value failed identically and re-suggested it (loop).
  //
  // Code-like text (not "x".repeat — BPE collapses repeated chars) so the token
  // count scales with size.
  function codeLike(bytes: number): string {
    const line =
      "const result = computeValue(alpha, beta, gamma, delta); // note\n";
    return line.repeat(Math.ceil(bytes / line.length)).slice(0, bytes);
  }

  it("retrying file_read with the suggested_token_budget no longer returns too_large", () => {
    const payload = codeLike(14_000); // ≈ compressShellOutput body size
    const first = applyWireCap("file_read", payload, {
      entity: "compressShellOutput",
    });
    const firstObj = first.body as Record<string, unknown>;
    expect(firstObj.status).toBe("too_large");
    expect(firstObj.reason).toBe("entity_too_large");

    const suggested = firstObj.suggested_token_budget as number;
    const tokens = firstObj.tokens as number;

    // Core invariant: the suggested budget covers the payload's real token count.
    expect(suggested).toBeGreaterThanOrEqual(tokens);

    // And it actually clears on retry — the loop is broken.
    const retry = applyWireCap("file_read", payload, {
      entity: "compressShellOutput",
      token_budget: suggested,
    });
    const retryObj = retry.body as Record<string, unknown>;
    expect(retryObj.status).not.toBe("too_large");
  });

  it("never re-suggests the same value that was just requested and failed", () => {
    const payload = codeLike(9_000); // ≈ maybeCompressContent body size
    const first = applyWireCap("file_read", payload, { entity: "x" });
    const suggested = (first.body as Record<string, unknown>)
      .suggested_token_budget as number;

    // Retry at the suggested value: if it still overflows, the next suggestion
    // MUST be strictly larger (no identical re-suggestion loop). If it clears,
    // there is no second suggestion at all — both outcomes break the loop.
    const retry = applyWireCap("file_read", payload, {
      entity: "x",
      token_budget: suggested,
    });
    const retryObj = retry.body as Record<string, unknown>;
    if (retryObj.status === "too_large") {
      expect(retryObj.suggested_token_budget as number).toBeGreaterThan(
        suggested
      );
    } else {
      expect(retryObj.status).not.toBe("too_large");
    }
  });
});

describe("wire-cap head delivery — spend the budget already paid for", () => {
  it("includes a head prefix and head_chars, staying roughly within the cap", () => {
    const oversized = bigString(20_000);
    const { body } = applyWireCap("file_read", oversized, {});
    const obj = body as Record<string, unknown>;
    expect(obj.status).toBe("too_large");
    expect(typeof obj.head).toBe("string");
    expect(typeof obj.head_chars).toBe("number");
    expect(obj.head_chars as number).toBeGreaterThan(0);
    expect(oversized.startsWith(obj.head as string)).toBe(true);
    // Total delivered body stays close to cap_tokens — a small slack for the
    // heuristic charsPerToken conversion used to size the head slice.
    const bodyTokens = estimateTokenCount(JSON.stringify(obj));
    expect(bodyTokens).toBeLessThanOrEqual((obj.cap_tokens as number) + 100);
  });

  it("pageHint names the head delivery and the cache marker retrieves past it", () => {
    const oversized = bigString(20_000);
    const { body, pageHint } = applyWireCap("file_read", oversized, {});
    const obj = body as Record<string, unknown>;
    const headChars = obj.head_chars as number;
    expect(pageHint).toContain("head");
    expect(pageHint).toMatch(/\d+tok delivered inline/);
    expect(pageHint).toContain(`offset:${headChars}`);
  });

  it("omits head when the cap leaves under 200 tokens of room after the envelope", () => {
    const oversized = bigString(20_000);
    // A huge `entity` echoes into the too_large envelope itself (oversize.entity),
    // consuming nearly the whole cap before any head slice is considered.
    const hugeEntity = bigString(8_000);
    const { body, pageHint } = applyWireCap("file_read", oversized, {
      entity: hugeEntity,
    });
    const obj = body as Record<string, unknown>;
    expect(obj.status).toBe("too_large");
    expect(obj.head).toBeUndefined();
    expect(obj.head_chars).toBeUndefined();
    expect(pageHint).not.toMatch(/delivered inline/);
    expect(pageHint).toContain("offset:0");
  });
});
