import { describe, expect, it } from "vitest";
import {
  estimateCost,
  estimateSavings,
  estimateTokenCount,
  estimateTokens,
  getModelCostRate,
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

describe("estimateCost", () => {
  it("calculates cost for Claude Sonnet", () => {
    const cost = estimateCost("claude-sonnet-4-20250514", 1_000_000, 500_000);
    expect(cost).toBe(3 + 7.5);
  });

  it("uses default rates for unknown models", () => {
    const cost = estimateCost("unknown-model", 1_000_000, 1_000_000);
    expect(cost).toBe(3 + 15);
  });

  it("returns 0 for Ollama", () => {
    const cost = estimateCost("ollama", 1_000_000, 1_000_000);
    expect(cost).toBe(0);
  });
});

describe("estimateSavings", () => {
  it("calculates dollar savings from token reduction", () => {
    const savings = estimateSavings("claude-sonnet-4-20250514", 10000, 3000);
    expect(savings).toBeGreaterThan(0);
  });

  it("returns 0 when no savings", () => {
    const savings = estimateSavings("claude-sonnet-4-20250514", 1000, 1000);
    expect(savings).toBe(0);
  });
});

describe("getModelCostRate", () => {
  it("returns known model rates", () => {
    const rate = getModelCostRate("gpt-4o");
    expect(rate.inputPerMillion).toBe(2.5);
    expect(rate.outputPerMillion).toBe(10);
  });

  it("returns default rates for unknown models", () => {
    const rate = getModelCostRate("imaginary-model");
    expect(rate.inputPerMillion).toBe(3);
    expect(rate.outputPerMillion).toBe(15);
  });
});
