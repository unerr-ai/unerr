/**
 * Tests for Sprint L8.1 — LocalChatProvider + ChatProvider interface.
 */

import http from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { LocalLlmConfig } from "../config/settings.js";
import {
  type ChatMessage,
  type ChatStreamChunk,
  type ChatToolDef,
  LocalChatProvider,
  toChatToolDefs,
} from "../core/local-chat-provider.js";
import type { Tool } from "../tools/types.js";

// ── Mock Ollama Server ──────────────────────────────────────

function createMockOllamaServer(): http.Server {
  return http.createServer((req, res) => {
    if (req.url === "/api/chat" && req.method === "POST") {
      let body = "";
      req.on("data", (chunk) => {
        body += chunk;
      });
      req.on("end", () => {
        res.writeHead(200, { "Content-Type": "application/x-ndjson" });
        // Stream two chunks then done
        res.write(
          `${JSON.stringify({
            message: { role: "assistant", content: "Hello " },
            done: false,
          })}\n`
        );
        res.write(
          `${JSON.stringify({
            message: { role: "assistant", content: "world!" },
            done: true,
            eval_count: 10,
            prompt_eval_count: 5,
          })}\n`
        );
        res.end();
      });
    } else if (req.url === "/api/tags") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ models: [{ name: "llama3" }] }));
    } else {
      res.writeHead(404);
      res.end();
    }
  });
}

// ── Mock OpenAI-Compatible Server ───────────────────────────

function createMockOpenAiServer(): http.Server {
  return http.createServer((req, res) => {
    if (req.url === "/v1/chat/completions" && req.method === "POST") {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write(
        'data: {"choices":[{"delta":{"content":"Hi "},"index":0}]}\n\n'
      );
      res.write(
        'data: {"choices":[{"delta":{"content":"there!"},"index":0}]}\n\n'
      );
      res.write("data: [DONE]\n\n");
      res.end();
    } else if (req.url === "/v1/models") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ data: [{ id: "llama3" }] }));
    } else {
      res.writeHead(404);
      res.end();
    }
  });
}

// ── Tests ───────────────────────────────────────────────────

describe("LocalChatProvider — Ollama (L8.1)", () => {
  let server: http.Server;
  let port: number;

  beforeAll(async () => {
    server = createMockOllamaServer();
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve());
    });
    port = (server.address() as { port: number }).port;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("streams chat response from Ollama /api/chat", async () => {
    const config: LocalLlmConfig = {
      provider: "ollama",
      baseUrl: `http://127.0.0.1:${port}`,
      chatModel: "llama3",
      embeddingModel: "nomic-embed-text",
      embeddingDimensions: 384,
      maxConcurrency: 2,
    };

    const provider = new LocalChatProvider(config);
    expect(provider.providerName).toBe("ollama");
    expect(provider.modelId).toBe("llama3");

    const chunks: ChatStreamChunk[] = [];
    const response = await provider.streamChat(
      [{ role: "user", content: "Hello" }],
      [],
      "You are a helpful assistant.",
      1024,
      (chunk) => chunks.push(chunk)
    );

    expect(response.text).toBe("Hello world!");
    expect(response.toolCalls).toHaveLength(0);
    expect(response.outputTokens).toBe(10);
    expect(response.inputTokens).toBe(5);

    const textChunks = chunks.filter((c) => c.type === "text_delta");
    expect(textChunks).toHaveLength(2);
    expect(textChunks[0]?.text).toBe("Hello ");
    expect(textChunks[1]?.text).toBe("world!");
    expect(chunks[chunks.length - 1]?.type).toBe("done");
  });
});

describe("LocalChatProvider — OpenAI-Compatible (L8.1)", () => {
  let server: http.Server;
  let port: number;

  beforeAll(async () => {
    server = createMockOpenAiServer();
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve());
    });
    port = (server.address() as { port: number }).port;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("streams chat response from OpenAI-compatible SSE endpoint", async () => {
    const config: LocalLlmConfig = {
      provider: "lm-studio",
      baseUrl: `http://127.0.0.1:${port}`,
      chatModel: "llama3",
      embeddingModel: "nomic-embed-text",
      embeddingDimensions: 384,
      maxConcurrency: 2,
    };

    const provider = new LocalChatProvider(config);
    expect(provider.providerName).toBe("lm-studio");

    const chunks: ChatStreamChunk[] = [];
    const response = await provider.streamChat(
      [{ role: "user", content: "Hi" }],
      [],
      "You are helpful.",
      1024,
      (chunk) => chunks.push(chunk)
    );

    expect(response.text).toBe("Hi there!");
    expect(response.toolCalls).toHaveLength(0);

    const textChunks = chunks.filter((c) => c.type === "text_delta");
    expect(textChunks).toHaveLength(2);
    expect(chunks[chunks.length - 1]?.type).toBe("done");
  });
});

describe("toChatToolDefs (L8.1)", () => {
  it("converts Tool[] to ChatToolDef[]", () => {
    const tools: Tool[] = [
      {
        name: "get_function",
        description: "Get function details",
        inputSchema: {
          type: "object",
          properties: { key: { type: "string" } },
          required: ["key"],
        },
        isReadOnly: true,
        requiresPermission: false,
        execute: async () => ({ content: "" }),
      },
    ];

    const defs = toChatToolDefs(tools);
    expect(defs).toHaveLength(1);
    expect(defs[0]?.type).toBe("function");
    expect(defs[0]?.function.name).toBe("get_function");
    expect(defs[0]?.function.description).toBe("Get function details");
    expect(defs[0]?.function.parameters).toEqual(tools[0]?.inputSchema);
  });
});

describe("LocalChatProvider — anthropic-direct (L8.1)", () => {
  it("throws if no API key configured", async () => {
    const config: LocalLlmConfig = {
      provider: "anthropic-direct",
      chatModel: "claude-sonnet-4-20250514",
      embeddingModel: "nomic-embed-text",
      embeddingDimensions: 384,
      maxConcurrency: 2,
    };

    const provider = new LocalChatProvider(config);
    expect(provider.providerName).toBe("anthropic-direct");

    await expect(
      provider.streamChat(
        [{ role: "user", content: "Hello" }],
        [],
        "System prompt",
        1024,
        () => {}
      )
    ).rejects.toThrow("anthropic-direct requires an API key");
  });
});
