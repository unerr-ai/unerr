import { describe, expect, it } from "vitest";
import {
  enforceBudget,
  isStructuredContent,
} from "../proxy/budget-enforcer.js";

describe("enforceBudget", () => {
  it("passes through content within budget", () => {
    const content = "short content";
    const result = enforceBudget(content, 1000);
    expect(result.content).toBe(content);
    expect(result.truncated).toBe(false);
    expect(result.deliveredTokens).toBe(result.originalTokens);
  });

  it("truncates content exceeding budget", () => {
    const content = Array.from(
      { length: 500 },
      (_, i) => `Line ${i}: some content here that takes up space`
    ).join("\n");
    const result = enforceBudget(content, 200);
    expect(result.truncated).toBe(true);
    expect(result.deliveredTokens).toBeLessThan(result.originalTokens);
    expect(result.content).toContain("[...");
    expect(result.content).toContain("truncated");
  });

  it("preserves head and tail of truncated content", () => {
    const lines = Array.from({ length: 100 }, (_, i) => `Line ${i}`);
    const content = lines.join("\n");
    const result = enforceBudget(content, 100);
    expect(result.content).toContain("Line 0");
    expect(result.content).toContain("Line 99");
  });

  it("uses default budget of 4000 tokens", () => {
    const small = "hello world";
    const result = enforceBudget(small);
    expect(result.truncated).toBe(false);
  });

  it("reports original and delivered token counts", () => {
    const content = Array.from(
      { length: 200 },
      (_, i) => `Data line ${i} with some padding text`
    ).join("\n");
    const result = enforceBudget(content, 100);
    expect(result.originalTokens).toBeGreaterThan(100);
    expect(result.deliveredTokens).toBeLessThanOrEqual(result.originalTokens);
  });
});

describe("isStructuredContent", () => {
  it("returns true for JSON objects", () => {
    expect(isStructuredContent('{"key": "value"}')).toBe(true);
  });

  it("returns true for non-string values", () => {
    expect(isStructuredContent({ key: "value" })).toBe(true);
    expect(isStructuredContent(42)).toBe(true);
    expect(isStructuredContent(null)).toBe(true);
  });

  it("returns false for plain text", () => {
    expect(isStructuredContent("hello world")).toBe(false);
  });

  it("returns false for invalid JSON", () => {
    expect(isStructuredContent("{not valid json}")).toBe(false);
  });
});
