/**
 * Sprint L3.1 Tests: BYO-LLM Adapter Factory — adapter creation, embedding, health check.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LocalLlmConfig } from "../config/settings.js";
import {
  type EmbeddingResult,
  type LocalLlmAdapter,
  createAndVerifyAdapter,
  createLocalLlmAdapter,
} from "../intelligence/local-llm.js";

// ── Adapter Factory ─────────────────────────────────────────

describe("createLocalLlmAdapter", () => {
  it("returns null when config is undefined", () => {
    expect(createLocalLlmAdapter(undefined)).toBeNull();
  });

  it("creates Ollama adapter with defaults", () => {
    const config: LocalLlmConfig = {
      provider: "ollama",
      embeddingModel: "nomic-embed-text",
      chatModel: "llama3",
      maxConcurrency: 2,
      embeddingDimensions: 384,
    };
    const adapter = createLocalLlmAdapter(config);
    expect(adapter).not.toBeNull();
    expect(adapter?.provider).toBe("ollama");
    expect(adapter?.baseUrl).toBe("http://localhost:11434");
    expect(adapter?.embeddingModel).toBe("nomic-embed-text");
    expect(adapter?.embeddingDimensions).toBe(384);
    expect(adapter?.maxConcurrency).toBe(2);
  });

  it("creates LM Studio adapter with custom baseUrl", () => {
    const config: LocalLlmConfig = {
      provider: "lm-studio",
      baseUrl: "http://localhost:5555",
      embeddingModel: "all-MiniLM-L6-v2",
      chatModel: "llama3",
      maxConcurrency: 4,
      embeddingDimensions: 384,
    };
    const adapter = createLocalLlmAdapter(config);
    expect(adapter?.provider).toBe("lm-studio");
    expect(adapter?.baseUrl).toBe("http://localhost:5555");
  });

  it("creates OpenAI-compatible adapter", () => {
    const config: LocalLlmConfig = {
      provider: "openai-compatible",
      baseUrl: "http://localhost:8080",
      embeddingModel: "text-embedding-3-small",
      chatModel: "gpt-4o",
      apiKey: "sk-test",
      maxConcurrency: 2,
      embeddingDimensions: 1536,
    };
    const adapter = createLocalLlmAdapter(config);
    expect(adapter?.provider).toBe("openai-compatible");
  });

  it("creates Anthropic-direct adapter", () => {
    const config: LocalLlmConfig = {
      provider: "anthropic-direct",
      embeddingModel: "nomic-embed-text",
      chatModel: "claude-sonnet-4-20250514",
      maxConcurrency: 2,
      embeddingDimensions: 384,
    };
    const adapter = createLocalLlmAdapter(config);
    expect(adapter?.provider).toBe("anthropic-direct");
    expect(adapter?.baseUrl).toBe("https://api.anthropic.com");
  });
});

// ── Embed Method ────────────────────────────────────────────

describe("adapter.embed", () => {
  let adapter: LocalLlmAdapter;

  beforeEach(() => {
    adapter = createLocalLlmAdapter({
      provider: "ollama",
      embeddingModel: "nomic-embed-text",
      chatModel: "llama3",
      maxConcurrency: 2,
      embeddingDimensions: 384,
    }) as LocalLlmAdapter;
  });

  it("returns empty result for empty input", async () => {
    const result = await adapter.embed([]);
    expect(result.embeddings).toEqual([]);
    expect(result.totalTokens).toBe(0);
  });

  it("calls /v1/embeddings with correct payload", async () => {
    const mockResponse: {
      data: Array<{ embedding: number[]; index: number }>;
      model: string;
      usage: { prompt_tokens: number; total_tokens: number };
    } = {
      data: [
        { embedding: [0.1, 0.2, 0.3], index: 0 },
        { embedding: [0.4, 0.5, 0.6], index: 1 },
      ],
      model: "nomic-embed-text",
      usage: { prompt_tokens: 10, total_tokens: 10 },
    };

    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        new Response(JSON.stringify(mockResponse), { status: 200 })
      );

    const result = await adapter.embed(["hello", "world"]);

    expect(fetchSpy).toHaveBeenCalledOnce();
    const call = fetchSpy.mock.calls[0];
    const [url, init] = call ?? [];
    expect(url).toBe("http://localhost:11434/v1/embeddings");
    expect(init?.method).toBe("POST");
    const body = JSON.parse(init?.body as string);
    expect(body.model).toBe("nomic-embed-text");
    expect(body.input).toEqual(["hello", "world"]);

    expect(result.embeddings).toHaveLength(2);
    expect(result.embeddings[0]).toEqual([0.1, 0.2, 0.3]);
    expect(result.embeddings[1]).toEqual([0.4, 0.5, 0.6]);
    expect(result.totalTokens).toBe(10);

    fetchSpy.mockRestore();
  });

  it("sorts response by index to preserve order", async () => {
    const mockResponse = {
      data: [
        { embedding: [0.4, 0.5], index: 1 },
        { embedding: [0.1, 0.2], index: 0 },
      ],
      model: "nomic-embed-text",
      usage: { prompt_tokens: 5, total_tokens: 5 },
    };

    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        new Response(JSON.stringify(mockResponse), { status: 200 })
      );

    const result = await adapter.embed(["first", "second"]);
    expect(result.embeddings[0]).toEqual([0.1, 0.2]);
    expect(result.embeddings[1]).toEqual([0.4, 0.5]);

    fetchSpy.mockRestore();
  });

  it("throws on non-200 response", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("model not found", {
        status: 404,
        statusText: "Not Found",
      })
    );

    await expect(adapter.embed(["test"])).rejects.toThrow("404 Not Found");
    fetchSpy.mockRestore();
  });

  it("includes Authorization header when apiKey is set", async () => {
    const adapterWithKey = createLocalLlmAdapter({
      provider: "openai-compatible",
      baseUrl: "http://localhost:8080",
      embeddingModel: "test-model",
      chatModel: "test",
      apiKey: "sk-secret",
      maxConcurrency: 2,
      embeddingDimensions: 384,
    }) as LocalLlmAdapter;

    const mockResponse = {
      data: [{ embedding: [0.1], index: 0 }],
      model: "test-model",
      usage: { prompt_tokens: 1, total_tokens: 1 },
    };

    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        new Response(JSON.stringify(mockResponse), { status: 200 })
      );

    await adapterWithKey.embed(["test"]);

    const headers = fetchSpy.mock.calls[0]?.[1]?.headers as Record<
      string,
      string
    >;
    expect(headers.Authorization).toBe("Bearer sk-secret");

    fetchSpy.mockRestore();
  });
});

// ── Health Check ────────────────────────────────────────────

describe("adapter.isAvailable", () => {
  it("returns true when endpoint responds 200", async () => {
    const adapter = createLocalLlmAdapter({
      provider: "ollama",
      embeddingModel: "nomic-embed-text",
      chatModel: "llama3",
      maxConcurrency: 2,
      embeddingDimensions: 384,
    }) as LocalLlmAdapter;

    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        new Response(JSON.stringify({ models: [] }), { status: 200 })
      );

    expect(await adapter.isAvailable()).toBe(true);
    // Ollama uses /api/tags
    expect(fetchSpy.mock.calls[0]?.[0]).toBe("http://localhost:11434/api/tags");

    fetchSpy.mockRestore();
  });

  it("returns false when endpoint is unreachable", async () => {
    const adapter = createLocalLlmAdapter({
      provider: "ollama",
      embeddingModel: "nomic-embed-text",
      chatModel: "llama3",
      maxConcurrency: 2,
      embeddingDimensions: 384,
    }) as LocalLlmAdapter;

    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("ECONNREFUSED"));

    expect(await adapter.isAvailable()).toBe(false);

    fetchSpy.mockRestore();
  });

  it("LM Studio uses /v1/models endpoint", async () => {
    const adapter = createLocalLlmAdapter({
      provider: "lm-studio",
      embeddingModel: "test",
      chatModel: "test",
      maxConcurrency: 2,
      embeddingDimensions: 384,
    }) as LocalLlmAdapter;

    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        new Response(JSON.stringify({ data: [] }), { status: 200 })
      );

    await adapter.isAvailable();
    expect(fetchSpy.mock.calls[0]?.[0]).toBe("http://localhost:1234/v1/models");

    fetchSpy.mockRestore();
  });
});

// ── createAndVerifyAdapter ──────────────────────────────────

describe("createAndVerifyAdapter", () => {
  it("returns null for undefined config", async () => {
    expect(await createAndVerifyAdapter(undefined)).toBeNull();
  });

  it("logs available status to stderr", async () => {
    const stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        new Response(JSON.stringify({ models: [] }), { status: 200 })
      );

    const adapter = await createAndVerifyAdapter({
      provider: "ollama",
      embeddingModel: "nomic-embed-text",
      chatModel: "llama3",
      maxConcurrency: 2,
      embeddingDimensions: 384,
    });

    expect(adapter).not.toBeNull();
    const output = stderrSpy.mock.calls.map((c) => c[0]).join("");
    expect(output).toContain("BYO-LLM");
    expect(output).toContain("ollama");
    // API key should NEVER appear in stderr
    expect(output).not.toContain("sk-");

    stderrSpy.mockRestore();
    fetchSpy.mockRestore();
  });

  it("logs unavailable status without leaking apiKey", async () => {
    const stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("ECONNREFUSED"));

    await createAndVerifyAdapter({
      provider: "openai-compatible",
      baseUrl: "http://localhost:9999",
      embeddingModel: "test",
      chatModel: "test",
      apiKey: "sk-supersecret-key",
      maxConcurrency: 2,
      embeddingDimensions: 384,
    });

    const output = stderrSpy.mock.calls.map((c) => c[0]).join("");
    expect(output).toContain("not reachable");
    expect(output).not.toContain("sk-supersecret-key");

    stderrSpy.mockRestore();
    fetchSpy.mockRestore();
  });
});
