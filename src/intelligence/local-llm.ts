/**
 * BYO-LLM Adapter Factory — Provider-agnostic adapter for local LLM endpoints.
 *
 * Supports Ollama, LM Studio, OpenAI-compatible, and Anthropic-direct providers.
 * All adapters target the OpenAI-compatible /v1/embeddings endpoint pattern,
 * which Ollama, LM Studio, and generic OpenAI-compatible servers all expose.
 *
 * Anthropic-direct uses the /v1/messages endpoint for chat but still routes
 * embeddings through a local embedding server (the Anthropic API has no
 * embedding endpoint, so the adapter falls back to the configured baseUrl).
 *
 * SECURITY: API keys are NEVER logged to stderr, included in MCP responses,
 * or written to any ledger/file. They exist only in memory for Authorization headers.
 */

import type { LocalLlmConfig } from "../config/settings.js";
import { resolveEmbeddingEndpoint } from "../config/settings.js";

// ── Types ────────────────────────────────────────────────────

export interface EmbeddingResult {
  /** One embedding vector per input text. */
  embeddings: number[][];
  /** Model that produced the embeddings. */
  model: string;
  /** Total tokens consumed across all inputs. */
  totalTokens: number;
}

export interface LocalLlmAdapter {
  /** Provider name for logging. */
  readonly provider: string;
  /** Configured base URL. */
  readonly baseUrl: string;
  /** Configured embedding model name. */
  readonly embeddingModel: string;
  /** Configured embedding dimensions. */
  readonly embeddingDimensions: number;
  /** Max concurrent requests. */
  readonly maxConcurrency: number;

  /**
   * Compute embeddings for one or more texts.
   * Returns one vector per input text, in order.
   */
  embed(texts: string[]): Promise<EmbeddingResult>;

  /**
   * Health-check: ping the endpoint to verify it's reachable and the
   * embedding model is available. Returns true if ready.
   */
  isAvailable(): Promise<boolean>;
}

// ── Default Base URLs ────────────────────────────────────────

const DEFAULT_BASE_URLS: Record<string, string> = {
  ollama: "http://localhost:11434",
  "lm-studio": "http://localhost:1234",
  "openai-compatible": "http://localhost:8080",
  "anthropic-direct": "https://api.anthropic.com",
};

// ── OpenAI-Compatible Adapter ────────────────────────────────
// Ollama, LM Studio, and generic OpenAI-compatible servers all
// expose /v1/embeddings with the same request/response shape.

interface OpenAiEmbeddingResponse {
  data: Array<{ embedding: number[]; index: number }>;
  model: string;
  usage: { prompt_tokens: number; total_tokens: number };
}

class OpenAiCompatibleAdapter implements LocalLlmAdapter {
  readonly provider: string;
  readonly baseUrl: string;
  readonly embeddingModel: string;
  readonly embeddingDimensions: number;
  readonly maxConcurrency: number;
  private readonly apiKey: string | undefined;

  constructor(config: LocalLlmConfig, providerLabel: string) {
    const endpoint = resolveEmbeddingEndpoint(config);
    this.provider = providerLabel;
    this.baseUrl =
      endpoint.baseUrl ?? DEFAULT_BASE_URLS[endpoint.provider] ?? "";
    this.embeddingModel = endpoint.model;
    this.embeddingDimensions = config.embeddingDimensions;
    this.maxConcurrency = config.maxConcurrency;
    this.apiKey = endpoint.apiKey;
  }

  async embed(texts: string[]): Promise<EmbeddingResult> {
    if (texts.length === 0) {
      return { embeddings: [], model: this.embeddingModel, totalTokens: 0 };
    }

    const url = `${this.baseUrl.replace(/\/+$/, "")}/v1/embeddings`;
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (this.apiKey) {
      headers.Authorization = `Bearer ${this.apiKey}`;
    }

    const response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: this.embeddingModel,
        input: texts,
      }),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(
        `[LocalLLM] ${this.provider} embedding request failed: ${response.status} ${response.statusText}${body ? ` — ${body.slice(0, 200)}` : ""}`
      );
    }

    const json = (await response.json()) as OpenAiEmbeddingResponse;

    // Sort by index to guarantee order matches input order
    const sorted = [...json.data].sort((a, b) => a.index - b.index);

    return {
      embeddings: sorted.map((d) => d.embedding),
      model: json.model ?? this.embeddingModel,
      totalTokens: json.usage?.total_tokens ?? 0,
    };
  }

  async isAvailable(): Promise<boolean> {
    try {
      // Ollama: GET /api/tags lists models
      // LM Studio: GET /v1/models lists models
      // OpenAI-compatible: GET /v1/models lists models
      // Try the most common endpoint first
      const modelsUrl =
        this.provider === "ollama"
          ? `${this.baseUrl.replace(/\/+$/, "")}/api/tags`
          : `${this.baseUrl.replace(/\/+$/, "")}/v1/models`;

      const headers: Record<string, string> = {};
      if (this.apiKey) {
        headers.Authorization = `Bearer ${this.apiKey}`;
      }

      const response = await fetch(modelsUrl, {
        method: "GET",
        headers,
        signal: AbortSignal.timeout(3000),
      });

      return response.ok;
    } catch {
      return false;
    }
  }
}

// ── Anthropic Direct Adapter ─────────────────────────────────
// Anthropic has no embedding API. This adapter uses the configured
// baseUrl for embeddings (which must be a local embedding server)
// and only uses the Anthropic API for chat (not implemented here).

class AnthropicDirectAdapter implements LocalLlmAdapter {
  readonly provider = "anthropic-direct";
  readonly baseUrl: string;
  readonly embeddingModel: string;
  readonly embeddingDimensions: number;
  readonly maxConcurrency: number;
  private readonly inner: OpenAiCompatibleAdapter;

  constructor(config: LocalLlmConfig) {
    const endpoint = resolveEmbeddingEndpoint(config);
    this.baseUrl =
      endpoint.baseUrl ?? DEFAULT_BASE_URLS["anthropic-direct"] ?? "";
    this.embeddingModel = endpoint.model;
    this.embeddingDimensions = config.embeddingDimensions;
    this.maxConcurrency = config.maxConcurrency;

    this.inner = new OpenAiCompatibleAdapter(
      config,
      "anthropic-direct (embedding proxy)"
    );
  }

  async embed(texts: string[]): Promise<EmbeddingResult> {
    return this.inner.embed(texts);
  }

  async isAvailable(): Promise<boolean> {
    return this.inner.isAvailable();
  }
}

// ── Factory ──────────────────────────────────────────────────

/**
 * Create a LocalLlmAdapter for the given settings.
 * Returns null if no localLlm config is provided.
 */
export function createLocalLlmAdapter(
  config: LocalLlmConfig | undefined
): LocalLlmAdapter | null {
  if (!config) return null;

  const embeddingEndpoint = resolveEmbeddingEndpoint(config);
  const effectiveProvider = embeddingEndpoint.provider;

  switch (effectiveProvider) {
    case "ollama":
      return new OpenAiCompatibleAdapter(config, "ollama");
    case "lm-studio":
      return new OpenAiCompatibleAdapter(config, "lm-studio");
    case "openai-compatible":
      return new OpenAiCompatibleAdapter(config, "openai-compatible");
    case "anthropic-direct":
      return new AnthropicDirectAdapter(config);
    default:
      return new OpenAiCompatibleAdapter(config, effectiveProvider);
  }
}

/**
 * Create adapter and verify availability, logging to stderr.
 * Returns the adapter (available or not) — callers check isAvailable() as needed.
 */
export async function createAndVerifyAdapter(
  config: LocalLlmConfig | undefined
): Promise<LocalLlmAdapter | null> {
  const adapter = createLocalLlmAdapter(config);
  if (!adapter) return null;

  const available = await adapter.isAvailable();
  if (available) {
    process.stderr.write(
      `[unerr] BYO-LLM: ${adapter.provider} at ${adapter.baseUrl} ✓ (model: ${adapter.embeddingModel})\n`
    );
  } else {
    process.stderr.write(
      `[unerr] BYO-LLM: ${adapter.provider} at ${adapter.baseUrl} — not reachable (embeddings disabled)\n`
    );
  }

  return adapter;
}
