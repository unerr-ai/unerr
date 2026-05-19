/**
 * Settings Manager — user-level and project-level configuration.
 *
 * Hierarchy (last wins):
 *   1. Defaults (hardcoded)
 *   2. User settings: ~/.unerr/settings.json
 *   3. Project settings: .unerr/settings.json
 *   4. Environment variables: ANTHROPIC_API_KEY, UNERR_MODEL, etc.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

// ── Schema ────────────────────────────────────────────────────

const LlmProviderEnum = z.enum([
  "ollama",
  "lm-studio",
  "openai-compatible",
  "anthropic-direct",
]);

const EndpointConfigSchema = z.object({
  provider: LlmProviderEnum.optional(),
  baseUrl: z.string().optional(),
  model: z.string().optional(),
  apiKey: z.string().optional(),
});

/**
 * BYO-LLM provider configuration for True Local Mode.
 *
 * Supports two usage patterns:
 *
 * 1. **Simple (single provider):** Set top-level `provider`, `baseUrl`, `apiKey`.
 *    Both embedding and inference use the same provider. `embeddingModel` and
 *    `chatModel` select which models to use.
 *
 * 2. **Split (different providers):** Set `embedding` and/or `inference` sub-objects.
 *    Each can have its own `provider`, `baseUrl`, `apiKey`, and `model`.
 *    Sub-object fields override top-level fields for that concern.
 *
 * Examples:
 *   - Ollama for everything: { provider: "ollama" }
 *   - Fireworks embedding + Anthropic chat:
 *     { embedding: { provider: "openai-compatible", baseUrl: "https://api.fireworks.ai/inference/v1", model: "...", apiKey: "..." },
 *       inference: { provider: "anthropic-direct", apiKey: "..." } }
 */
export const LocalLlmConfigSchema = z.object({
  provider: LlmProviderEnum.default("ollama"),
  baseUrl: z.string().optional(),
  embeddingModel: z.string().default("nomic-embed-text"),
  chatModel: z.string().default("llama3"),
  apiKey: z.string().optional(),
  maxConcurrency: z.number().int().min(1).default(2),
  embeddingDimensions: z.number().int().min(1).default(384),
  embedding: EndpointConfigSchema.optional(),
  inference: EndpointConfigSchema.optional(),
});

export type LocalLlmConfig = z.infer<typeof LocalLlmConfigSchema>;

export interface ResolvedEndpoint {
  provider: string;
  baseUrl: string | undefined;
  model: string;
  apiKey: string | undefined;
}

/**
 * Resolve the effective embedding endpoint config.
 * `config.embedding` fields override top-level `config` fields.
 */
export function resolveEmbeddingEndpoint(
  config: LocalLlmConfig
): ResolvedEndpoint {
  const e = config.embedding;
  return {
    provider: e?.provider ?? config.provider,
    baseUrl: e?.baseUrl ?? config.baseUrl,
    model: e?.model ?? config.embeddingModel,
    apiKey: e?.apiKey ?? config.apiKey,
  };
}

/**
 * Resolve the effective inference (chat) endpoint config.
 * `config.inference` fields override top-level `config` fields.
 */
export function resolveInferenceEndpoint(
  config: LocalLlmConfig
): ResolvedEndpoint {
  const i = config.inference;
  return {
    provider: i?.provider ?? config.provider,
    baseUrl: i?.baseUrl ?? config.baseUrl,
    model: i?.model ?? config.chatModel,
    apiKey: i?.apiKey ?? config.apiKey,
  };
}

const LlmConfigSchema = z.object({
  provider: z
    .enum(["anthropic", "openai", "google", "ollama", "openai-compatible"])
    .default("anthropic"),
  model: z.string().default("claude-sonnet-4-20250514"),
  apiKey: z.string().optional(),
  baseUrl: z.string().optional(),
});

export type LlmConfig = z.infer<typeof LlmConfigSchema>;

export const FetchUrlConfigSchema = z.object({
  playwright: z
    .object({
      enabled: z.boolean().default(false),
      timeoutMs: z.number().int().min(1000).max(60_000).default(15_000),
      waitUntil: z
        .enum(["load", "domcontentloaded", "networkidle"])
        .default("networkidle"),
    })
    .default(() => ({
      enabled: false,
      timeoutMs: 15_000,
      waitUntil: "networkidle" as const,
    })),
});

export type FetchUrlConfig = z.infer<typeof FetchUrlConfigSchema>;

export const SettingsSchema = z.object({
  /** Default Claude model for interactive sessions */
  model: z.string().default("claude-sonnet-4-20250514"),
  /** Anthropic API key (prefer env var ANTHROPIC_API_KEY) */
  anthropicApiKey: z.string().optional(),
  /** Permission mode for tool execution */
  permissionMode: z.enum(["prompt", "auto", "deny-all"]).default("prompt"),
  /** Maximum output tokens per LLM turn */
  maxTokens: z.number().default(8192),
  /** Enable verbose logging */
  verbose: z.boolean().default(false),
  /** AI SDK LLM configuration (Sprint D — unified multi-provider) */
  llm: LlmConfigSchema.optional(),
  /** BYO-LLM configuration for local LLM providers */
  localLlm: LocalLlmConfigSchema.optional(),
  /** fetch_url runtime config (Playwright SPA fallback, etc.) */
  fetchUrl: FetchUrlConfigSchema.default(() => ({
    playwright: {
      enabled: false,
      timeoutMs: 15_000,
      waitUntil: "networkidle" as const,
    },
  })),
});

export type Settings = z.infer<typeof SettingsSchema>;

// ── Defaults ──────────────────────────────────────────────────

const DEFAULTS: Settings = SettingsSchema.parse({});

// ── Loader ────────────────────────────────────────────────────

function loadJsonFile(filePath: string): Record<string, unknown> {
  if (!existsSync(filePath)) return {};
  try {
    return JSON.parse(readFileSync(filePath, "utf-8"));
  } catch {
    return {};
  }
}

/**
 * Load merged settings from all layers.
 */
export function loadSettings(cwd?: string): Settings {
  const projectDir = cwd ?? process.cwd();

  // Layer 2: User settings
  const userSettings = loadJsonFile(join(homedir(), ".unerr", "settings.json"));

  // Layer 3: Project settings
  const projectSettings = loadJsonFile(
    join(projectDir, ".unerr", "settings.json")
  );

  // Layer 4: Environment overrides
  const envOverrides: Record<string, unknown> = {};
  if (process.env.ANTHROPIC_API_KEY)
    envOverrides.anthropicApiKey = process.env.ANTHROPIC_API_KEY;
  if (process.env.UNERR_MODEL) envOverrides.model = process.env.UNERR_MODEL;
  if (process.env.UNERR_VERBOSE === "true") envOverrides.verbose = true;

  // AI SDK LLM env overrides (Sprint D)
  if (process.env.UNERR_LLM_PROVIDER) {
    envOverrides.llm = {
      provider: process.env.UNERR_LLM_PROVIDER,
      ...(process.env.UNERR_MODEL && { model: process.env.UNERR_MODEL }),
      ...(process.env.UNERR_LLM_API_KEY && {
        apiKey: process.env.UNERR_LLM_API_KEY,
      }),
      ...(process.env.UNERR_LLM_BASE_URL && {
        baseUrl: process.env.UNERR_LLM_BASE_URL,
      }),
    };
  }

  // BYO-LLM env overrides
  if (process.env.UNERR_LOCAL_LLM_PROVIDER)
    envOverrides.localLlm = {
      ...(projectSettings.localLlm as Record<string, unknown> | undefined),
      ...(userSettings.localLlm as Record<string, unknown> | undefined),
      provider: process.env.UNERR_LOCAL_LLM_PROVIDER,
      ...(process.env.UNERR_LOCAL_LLM_BASE_URL && {
        baseUrl: process.env.UNERR_LOCAL_LLM_BASE_URL,
      }),
      ...(process.env.UNERR_LOCAL_LLM_EMBEDDING_MODEL && {
        embeddingModel: process.env.UNERR_LOCAL_LLM_EMBEDDING_MODEL,
      }),
      ...(process.env.UNERR_LOCAL_LLM_CHAT_MODEL && {
        chatModel: process.env.UNERR_LOCAL_LLM_CHAT_MODEL,
      }),
    };

  // Merge: defaults ← user ← project ← env
  const merged = {
    ...DEFAULTS,
    ...userSettings,
    ...projectSettings,
    ...envOverrides,
  };

  return SettingsSchema.parse(merged);
}
