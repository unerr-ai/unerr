import { describe, expect, it } from "vitest";
import {
  type ContextInjector,
  createEnvelopePipeline,
  estimateTokens,
  wrapResponse,
} from "../proxy/response-envelope.js";

describe("estimateTokens", () => {
  it("estimates tokens for a short string", () => {
    const tokens = estimateTokens("hello world");
    expect(tokens).toBeGreaterThan(0);
    expect(tokens).toBeLessThan(20);
  });

  it("handles objects by serializing to JSON", () => {
    const obj = { key: "value", nested: { a: 1 } };
    const tokens = estimateTokens(obj);
    expect(tokens).toBeGreaterThan(0);
  });

  it("returns 0 for null/undefined", () => {
    expect(estimateTokens(null)).toBe(0);
    expect(estimateTokens(undefined)).toBe(0);
  });

  it("handles empty string", () => {
    expect(estimateTokens("")).toBe(0);
  });
});

describe("wrapResponse", () => {
  it("wraps content with _meta fields", async () => {
    const result = await wrapResponse({ data: "test" }, 5.2);

    expect(result.content).toEqual({ data: "test" });
    expect(result._meta["dev.unerr/version"]).toBe("0.1.3");
    expect(result._meta["dev.unerr/latency_ms"]).toBe(5.2);
    expect(result._meta["dev.unerr/tokens_saved"]).toBeGreaterThanOrEqual(0);
  });

  it("calculates token savings when originalTokens provided", async () => {
    const result = await wrapResponse("short", 1, 1000);
    expect(result._meta["dev.unerr/tokens_saved"]).toBeGreaterThan(0);
  });

  it("never returns negative token savings", async () => {
    const result = await wrapResponse("a very long response string", 1, 1);
    expect(result._meta["dev.unerr/tokens_saved"]).toBe(0);
  });

  it("does not include _context when no injectors provide data", async () => {
    const result = await wrapResponse("test", 1);
    expect(result._context).toBeUndefined();
  });
});

describe("createEnvelopePipeline", () => {
  it("runs injectors and merges _context", async () => {
    const injector: ContextInjector = {
      key: "test",
      inject: () => ({ "dev.unerr/test": { hello: "world" } }),
    };

    const pipeline = createEnvelopePipeline([injector]);
    const result = await pipeline.wrapResponse("content", 1);

    expect(result._context).toBeDefined();
    expect(result._context?.["dev.unerr/test"]).toEqual({ hello: "world" });
  });

  it("handles injector returning null", async () => {
    const injector: ContextInjector = {
      key: "noop",
      inject: () => null,
    };

    const pipeline = createEnvelopePipeline([injector]);
    const result = await pipeline.wrapResponse("content", 1);

    expect(result._context).toBeUndefined();
  });

  it("swallows injector errors silently", async () => {
    const injector: ContextInjector = {
      key: "boom",
      inject: () => {
        throw new Error("injector crashed");
      },
    };

    const pipeline = createEnvelopePipeline([injector]);
    const result = await pipeline.wrapResponse("content", 1);

    expect(result.content).toBe("content");
    expect(result._meta["dev.unerr/version"]).toBe("0.1.3");
  });

  it("merges multiple injectors", async () => {
    const injectors: ContextInjector[] = [
      { key: "a", inject: () => ({ alpha: 1 }) },
      { key: "b", inject: () => ({ beta: 2 }) },
    ];

    const pipeline = createEnvelopePipeline(injectors);
    const result = await pipeline.wrapResponse("content", 1);

    expect(result._context?.alpha).toBe(1);
    expect(result._context?.beta).toBe(2);
  });

  it("passes tool metadata to injectors", async () => {
    let capturedArgs: unknown;
    const injector: ContextInjector = {
      key: "spy",
      inject: (args) => {
        capturedArgs = args;
        return null;
      },
    };

    const pipeline = createEnvelopePipeline([injector]);
    await pipeline.wrapResponse(
      "content",
      5,
      "get_function",
      { key: "abc" },
      100
    );

    const args = capturedArgs as {
      toolName: string;
      toolArgs: Record<string, unknown>;
    };
    expect(args.toolName).toBe("get_function");
    expect(args.toolArgs.key).toBe("abc");
  });
});
