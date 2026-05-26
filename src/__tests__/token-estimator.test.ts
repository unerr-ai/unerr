import { describe, expect, it } from "vitest";
import {
  estimateTokenCount,
  estimateTokens,
  isTokenizerReady,
  warmTokenizer,
} from "../intelligence/token-estimator.js";

describe("estimateTokenCount", () => {
  it("returns 0 for empty string", () => {
    expect(estimateTokenCount("")).toBe(0);
  });

  it("estimates English prose at ~chars/4", () => {
    const text =
      "The quick brown fox jumps over the lazy dog. This is a sample of English prose that should be tokenized at approximately four characters per token.";
    const tokens = estimateTokenCount(text);
    const expectedApprox = Math.ceil(text.length / 4);
    expect(tokens).toBeGreaterThan(expectedApprox * 0.7);
    expect(tokens).toBeLessThan(expectedApprox * 1.4);
  });

  it("estimates code at ~chars/3.5", () => {
    const code = `export function processOrder(orderId: string): Promise<OrderResult> {
  const order = await db.findOrder(orderId);
  if (!order) throw new Error("Order not found");
  const items = await db.getOrderItems(orderId);
  return { order, items, total: items.reduce((s, i) => s + i.price, 0) };
}`;
    const tokens = estimateTokenCount(code);
    expect(tokens).toBeGreaterThan(code.length / 5);
    expect(tokens).toBeLessThan(code.length / 2);
  });

  it("estimates JSON at ~chars/3", () => {
    const json = JSON.stringify({
      name: "test-project",
      version: "1.0.0",
      dependencies: { react: "^19.0.0", typescript: "^5.0.0" },
      scripts: { build: "tsc", test: "vitest run" },
    });
    const tokens = estimateTokenCount(json);
    const expectedApprox = Math.ceil(json.length / 3);
    expect(tokens).toBeGreaterThan(expectedApprox * 0.6);
    expect(tokens).toBeLessThan(expectedApprox * 1.5);
  });

  it("handles whitespace-heavy input", () => {
    const text = "hello\n\n\n   \n\n   world   \n\n\n";
    const tokens = estimateTokenCount(text);
    expect(tokens).toBeGreaterThan(0);
    expect(tokens).toBeLessThan(text.length);
  });

  it("estimates are consistent across multiple calls", () => {
    const text = "function hello() { return 42; }";
    const t1 = estimateTokenCount(text);
    const t2 = estimateTokenCount(text);
    expect(t1).toBe(t2);
  });
});

describe("estimateTokens", () => {
  it("handles null/undefined", () => {
    expect(estimateTokens(null)).toBe(0);
    expect(estimateTokens(undefined)).toBe(0);
  });

  it("handles objects by serializing", () => {
    const obj = { key: "value" };
    const tokens = estimateTokens(obj);
    expect(tokens).toBeGreaterThan(0);
  });
});

describe("real tokenizer (gpt-tokenizer / o200k_base)", () => {
  it("is available in the test environment", () => {
    // gpt-tokenizer is a hard dependency, so the real counter must load.
    expect(isTokenizerReady()).toBe(true);
  });

  it("warmTokenizer is safe and idempotent", () => {
    expect(() => {
      warmTokenizer();
      warmTokenizer();
    }).not.toThrow();
  });

  it("produces the exact BPE count for a known string", () => {
    // o200k_base tokenizes "hello world" as ["hello", " world"] = 2 tokens.
    expect(estimateTokenCount("hello world")).toBe(2);
  });

  it("counts a single short word as 1 token", () => {
    expect(estimateTokenCount("hello")).toBe(1);
  });
});

describe("large-input heuristic fallback", () => {
  it("falls back to the heuristic above 50k chars without throwing", () => {
    const huge = "const x = 1;\n".repeat(5000); // ~65k chars > LARGE_INPUT_CHARS
    expect(huge.length).toBeGreaterThan(50_000);
    const tokens = estimateTokenCount(huge);
    expect(tokens).toBeGreaterThan(0);
    expect(Number.isFinite(tokens)).toBe(true);
    // Heuristic stays within an order of magnitude of the char/4 ballpark.
    expect(tokens).toBeLessThan(huge.length);
  });
});
