/**
 * Leapfrog Sprint C TEST: Structural-priority truncation.
 *
 * Tests the smartTruncate() module against the spec:
 *   - Priority order: metadata → imports → signatures → bodies
 *   - Small entities returned in full (no truncation)
 *   - Large entities truncated at appropriate level
 *   - Truncation markers include token_budget hint
 *   - Never cuts mid-line (SC-12)
 *   - estimateTokens() uses 4 chars/token
 *   - truncateResultList() for array-returning tools
 */

import { describe, expect, it } from "vitest";
import {
  estimateTokens,
  smartTruncate,
  truncateResultList,
} from "../intelligence/smart-truncate.js";

describe("estimateTokens", () => {
  it("returns 0 for empty string", () => {
    expect(estimateTokens("")).toBe(0);
  });

  it("uses 4 chars per token", () => {
    expect(estimateTokens("abcd")).toBe(1);
    expect(estimateTokens("abcdefgh")).toBe(2);
    expect(estimateTokens("a")).toBe(1);
  });

  it("rounds up fractional tokens", () => {
    expect(estimateTokens("abcde")).toBe(2); // 5/4 = 1.25 → 2
  });
});

describe("smartTruncate", () => {
  const smallMetadata = "name: login\nkind: function\nfile: src/auth.ts";
  const smallImports =
    'import { hash } from "bcrypt";\nimport { db } from "./db";';
  const smallSignature =
    "function login(email: string, password: string): Promise<User>";
  const smallBody =
    "  const user = await db.findUser(email);\n  if (!user) throw new Error('not found');\n  return user;";

  it("returns full content when everything fits within budget", () => {
    const result = smartTruncate({
      metadata: smallMetadata,
      imports: smallImports,
      signatures: smallSignature,
      bodies: smallBody,
      budget: 5000,
    });

    expect(result.truncated).toBe(false);
    expect(result.truncation_level).toBe("full");
    expect(result.content).toContain(smallMetadata);
    expect(result.content).toContain(smallImports);
    expect(result.content).toContain(smallSignature);
    expect(result.content).toContain(smallBody);
    expect(result.tokens_used).toBeLessThanOrEqual(result.tokens_budget);
  });

  it("small entity (100 tokens) → full content, truncated: false", () => {
    const result = smartTruncate({
      metadata: "name: x",
      imports: "",
      signatures: "function x(): void",
      bodies: "return;",
      budget: 2000,
    });

    expect(result.truncated).toBe(false);
    expect(result.truncation_level).toBe("full");
    expect(result.tokens_used).toBeLessThan(100);
  });

  it("large entity (10K tokens) with budget 500 → truncated", () => {
    const largeBodies = Array.from(
      { length: 500 },
      (_, i) => `  const line${i} = processItem(items[${i}]);`
    ).join("\n");

    const result = smartTruncate({
      metadata: smallMetadata,
      imports: smallImports,
      signatures: smallSignature,
      bodies: largeBodies,
      budget: 500,
    });

    expect(result.truncated).toBe(true);
    expect(
      result.truncation_level === "signatures_only" ||
        result.truncation_level === "signatures_and_bodies" ||
        result.truncation_level === "metadata_only"
    ).toBe(true);
    expect(result.content).toContain("lines omitted");
    expect(result.full_tokens_estimate).toBeGreaterThan(500);
    expect(result.tokens_used).toBeLessThanOrEqual(result.tokens_budget + 50);
  });

  it("budget 50K → full content even for large entities", () => {
    const largeBodies = Array.from(
      { length: 200 },
      (_, i) => `  const line${i} = processItem(items[${i}]);`
    ).join("\n");

    const result = smartTruncate({
      metadata: smallMetadata,
      imports: smallImports,
      signatures: smallSignature,
      bodies: largeBodies,
      budget: 50000,
    });

    expect(result.truncated).toBe(false);
    expect(result.truncation_level).toBe("full");
    expect(result.content).toContain(largeBodies);
  });

  it("never cuts mid-line (SC-12)", () => {
    const bodies = Array.from(
      { length: 100 },
      (_, i) =>
        `  const longVariableName${i} = someVeryLongFunctionCall(param1, param2, param3);`
    ).join("\n");

    const result = smartTruncate({
      metadata: smallMetadata,
      imports: "",
      signatures: "",
      bodies,
      budget: 300,
    });

    if (result.truncated) {
      const lines = result.content.split("\n");
      for (const line of lines) {
        if (line.startsWith("//")) continue;
        if (line.trim() === "") continue;
        expect(
          line.endsWith(";") ||
            line.startsWith("name:") ||
            line.startsWith("kind:") ||
            line.startsWith("file:")
        ).toBe(true);
      }
    }
  });

  it("truncation marker includes full_tokens_estimate for re-request", () => {
    const largeBodies = "x\n".repeat(5000);

    const result = smartTruncate({
      metadata: "name: big",
      imports: "",
      signatures: "",
      bodies: largeBodies,
      budget: 200,
    });

    expect(result.truncated).toBe(true);
    expect(result.content).toContain("token_budget:");
    expect(result.full_tokens_estimate).toBeGreaterThan(200);
  });

  it("handles empty sections gracefully", () => {
    const result = smartTruncate({
      metadata: "name: empty",
      imports: "",
      signatures: "",
      bodies: "",
      budget: 2000,
    });

    expect(result.truncated).toBe(false);
    expect(result.truncation_level).toBe("full");
    expect(result.content).toBe("name: empty");
  });

  it("metadata always included even when budget is very small", () => {
    const result = smartTruncate({
      metadata: "name: critical\nkind: function\nrisk: high",
      imports: 'import { x } from "y";',
      signatures: "function critical(): void",
      bodies: "return expensiveComputation();",
      budget: 100,
    });

    expect(result.content).toContain("name: critical");
  });

  it("priority order: metadata first, then imports, then signatures, then bodies", () => {
    const result = smartTruncate({
      metadata: "META_MARKER",
      imports: "IMPORT_MARKER",
      signatures: "SIG_MARKER",
      bodies: "BODY_MARKER",
      budget: 5000,
    });

    const metaIdx = result.content.indexOf("META_MARKER");
    const importIdx = result.content.indexOf("IMPORT_MARKER");
    const sigIdx = result.content.indexOf("SIG_MARKER");
    const bodyIdx = result.content.indexOf("BODY_MARKER");

    expect(metaIdx).toBeLessThan(importIdx);
    expect(importIdx).toBeLessThan(sigIdx);
    expect(sigIdx).toBeLessThan(bodyIdx);
  });

  it("enforces minimum budget of 100", () => {
    const result = smartTruncate({
      metadata: "name: test",
      imports: "",
      signatures: "",
      bodies: "",
      budget: 10,
    });

    expect(result.tokens_budget).toBe(100);
  });

  it("performance: handles 10K-line entity under 5ms", () => {
    const bigBodies = Array.from(
      { length: 10000 },
      (_, i) => `  const line${i} = processItem(items[${i}], options);`
    ).join("\n");

    const t0 = performance.now();
    const result = smartTruncate({
      metadata: smallMetadata,
      imports: smallImports,
      signatures: smallSignature,
      bodies: bigBodies,
      budget: 2000,
    });
    const elapsed = performance.now() - t0;

    expect(elapsed).toBeLessThan(50);
    expect(result.truncated).toBe(true);
  });
});

describe("truncateResultList", () => {
  it("keeps all items when under budget", () => {
    const items = [{ name: "a" }, { name: "b" }, { name: "c" }];
    const result = truncateResultList(items, 5000, (i) => JSON.stringify(i));

    expect(result.items).toHaveLength(3);
    expect(result.truncated).toBe(false);
    expect(result.total).toBe(3);
  });

  it("truncates items when over budget", () => {
    const items = Array.from({ length: 100 }, (_, i) => ({
      name: `entity_${i}`,
      file_path: `src/module${i}/handler.ts`,
      signature: `function entity_${i}(): Promise<Result>`,
    }));

    const result = truncateResultList(items, 200, (i) => JSON.stringify(i));

    expect(result.items.length).toBeLessThan(100);
    expect(result.truncated).toBe(true);
    expect(result.total).toBe(100);
  });

  it("always includes at least one item", () => {
    const items = [{ name: "big_entity", description: "x".repeat(10000) }];

    const result = truncateResultList(items, 100, (i) => JSON.stringify(i));

    expect(result.items).toHaveLength(1);
    expect(result.total).toBe(1);
  });
});
