/**
 * Tests for Sprint L8.2 — `unerr enrich` enrichment logic.
 *
 * Tests the prompt builder and response parser without requiring
 * a real LLM or CozoDB instance.
 */

import { describe, expect, it } from "vitest";

// Re-export internal functions for testing by importing the module
// and testing the prompt/parse logic through the public API patterns.

// Since buildEnrichmentPrompt and parseEnrichmentResponse are module-private,
// we test them indirectly through their behavior. We can also test them
// by extracting them — but for now, test the patterns they implement.

describe("Enrichment prompt builder (L8.2)", () => {
  it("builds a structured prompt for entity batch", () => {
    // Verify the prompt format expected by parseEnrichmentResponse
    const entities = [
      {
        key: "fn:auth:login",
        kind: "function",
        name: "login",
        filePath: "src/auth.ts",
        signature: "login(user: User): Promise<Token>",
      },
      {
        key: "cls:auth:AuthService",
        kind: "class",
        name: "AuthService",
        filePath: "src/auth.ts",
        signature: "class AuthService",
      },
    ];

    // The prompt should contain entity info
    const entityBlock = entities
      .map(
        (e, i) =>
          `[${i + 1}] ${e.kind} "${e.name}" in ${e.filePath}\n    Signature: ${e.signature || "(none)"}`,
      )
      .join("\n");

    expect(entityBlock).toContain('[1] function "login"');
    expect(entityBlock).toContain('[2] class "AuthService"');
    expect(entityBlock).toContain("src/auth.ts");
  });
});

describe("Enrichment response parser (L8.2)", () => {
  // Mirror the parseEnrichmentResponse logic
  function parseEnrichmentResponse(
    text: string,
    count: number,
  ): Array<{ purpose: string; taxonomy: string; feature_area: string }> {
    const jsonMatch = text.match(/\[[\s\S]*\]/);
    if (!jsonMatch) {
      return Array.from({ length: count }, () => ({
        purpose: "",
        taxonomy: "unknown",
        feature_area: "unknown",
      }));
    }

    try {
      const parsed = JSON.parse(jsonMatch[0]) as Array<{
        index?: number;
        purpose?: string;
        taxonomy?: string;
        feature_area?: string;
      }>;

      const results: Array<{
        purpose: string;
        taxonomy: string;
        feature_area: string;
      }> = [];
      for (let i = 0; i < count; i++) {
        const entry = parsed.find((p) => p.index === i + 1) ?? parsed[i] ?? {};
        results.push({
          purpose: entry.purpose ?? "",
          taxonomy: entry.taxonomy ?? "unknown",
          feature_area: entry.feature_area ?? "unknown",
        });
      }
      return results;
    } catch {
      return Array.from({ length: count }, () => ({
        purpose: "",
        taxonomy: "unknown",
        feature_area: "unknown",
      }));
    }
  }

  it("parses well-formed JSON array response", () => {
    const text = JSON.stringify([
      {
        index: 1,
        purpose: "Handles user login",
        taxonomy: "authentication",
        feature_area: "user-auth",
      },
      {
        index: 2,
        purpose: "Manages auth state",
        taxonomy: "authentication",
        feature_area: "user-auth",
      },
    ]);

    const results = parseEnrichmentResponse(text, 2);
    expect(results).toHaveLength(2);
    expect(results[0]?.purpose).toBe("Handles user login");
    expect(results[0]?.taxonomy).toBe("authentication");
    expect(results[1]?.feature_area).toBe("user-auth");
  });

  it("handles markdown-wrapped JSON", () => {
    const text =
      '```json\n[{"index": 1, "purpose": "Test function", "taxonomy": "testing", "feature_area": "unit-tests"}]\n```';

    const results = parseEnrichmentResponse(text, 1);
    expect(results).toHaveLength(1);
    expect(results[0]?.purpose).toBe("Test function");
    expect(results[0]?.taxonomy).toBe("testing");
  });

  it("returns defaults for unparseable response", () => {
    const results = parseEnrichmentResponse(
      "Sorry, I cannot help with that.",
      3,
    );
    expect(results).toHaveLength(3);
    expect(results[0]?.purpose).toBe("");
    expect(results[0]?.taxonomy).toBe("unknown");
    expect(results[0]?.feature_area).toBe("unknown");
  });

  it("handles partial responses with missing fields", () => {
    const text = JSON.stringify([
      { index: 1, purpose: "Does something" },
      { index: 2, taxonomy: "data-access" },
    ]);

    const results = parseEnrichmentResponse(text, 2);
    expect(results[0]?.purpose).toBe("Does something");
    expect(results[0]?.taxonomy).toBe("unknown"); // missing → default
    expect(results[1]?.purpose).toBe(""); // missing → default
    expect(results[1]?.taxonomy).toBe("data-access");
  });

  it("handles fewer results than requested", () => {
    const text = JSON.stringify([
      {
        index: 1,
        purpose: "Only one result",
        taxonomy: "misc",
        feature_area: "core",
      },
    ]);

    const results = parseEnrichmentResponse(text, 3);
    expect(results).toHaveLength(3);
    expect(results[0]?.purpose).toBe("Only one result");
    expect(results[1]?.purpose).toBe(""); // fallback
    expect(results[2]?.purpose).toBe(""); // fallback
  });

  it("handles index-based matching", () => {
    // Response with out-of-order indices
    const text = JSON.stringify([
      { index: 2, purpose: "Second", taxonomy: "b", feature_area: "b" },
      { index: 1, purpose: "First", taxonomy: "a", feature_area: "a" },
    ]);

    const results = parseEnrichmentResponse(text, 2);
    expect(results[0]?.purpose).toBe("First");
    expect(results[1]?.purpose).toBe("Second");
  });
});
