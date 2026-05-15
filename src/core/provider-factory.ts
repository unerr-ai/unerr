/**
 * Provider Factory — creates AI SDK provider from settings configuration.
 *
 * Reads the LLM configuration (provider, model, apiKey, baseUrl) and
 * returns a ready-to-use LanguageModel for streamText().
 *
 * Supports two config shapes:
 *   1. Direct ProviderConfig: { provider, model, apiKey, baseUrl }
 *   2. Settings-based: reads from loadSettings().llm
 */

import {
  type ProviderConfig,
  type ProviderName,
  createLanguageModel,
} from "./providers.js";

export interface LlmSettings {
  provider?: string;
  model?: string;
  apiKey?: string;
  baseUrl?: string;
}

const DEFAULT_MODELS: Record<string, string> = {
  anthropic: "claude-sonnet-4-20250514",
  openai: "gpt-4o",
  google: "gemini-2.0-flash",
  ollama: "llama3",
  "openai-compatible": "default",
};

/**
 * Resolve a ProviderConfig from loose settings.
 * Fills in defaults for missing fields.
 */
export function resolveProviderConfig(settings: LlmSettings): ProviderConfig {
  const provider = (settings.provider ?? "anthropic") as ProviderName;
  const model = settings.model ?? DEFAULT_MODELS[provider] ?? "default";

  return {
    provider,
    model,
    apiKey: settings.apiKey,
    baseUrl: settings.baseUrl,
  };
}

/**
 * Create a LanguageModel from settings configuration.
 * This is the primary entry point for the rest of the codebase.
 */
export async function createModelFromSettings(
  settings: LlmSettings
): Promise<unknown> {
  const config = resolveProviderConfig(settings);
  return createLanguageModel(config);
}

/**
 * Create a LanguageModel from environment variables.
 * Falls back to Anthropic with claude-sonnet-4-20250514.
 */
export async function createModelFromEnv(): Promise<unknown> {
  const provider = (process.env.UNERR_LLM_PROVIDER ??
    "anthropic") as ProviderName;
  const model =
    process.env.UNERR_MODEL ?? DEFAULT_MODELS[provider] ?? "default";

  return createLanguageModel({
    provider,
    model,
    apiKey: process.env.ANTHROPIC_API_KEY ?? process.env.OPENAI_API_KEY,
    baseUrl: process.env.UNERR_LLM_BASE_URL,
  });
}
