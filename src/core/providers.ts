/**
 * AI Provider Registry — unified provider abstraction via Vercel AI SDK.
 *
 * Supports: Anthropic, OpenAI, Google Gemini, Ollama (local), any OpenAI-compatible.
 * Each provider returns an AI SDK LanguageModel that plugs into streamText().
 *
 * Design: the registry is a pure function map — no state, no singletons.
 * Provider creation is lazy (only when called) to avoid importing unused SDKs.
 */

/**
 * AI SDK v6 uses LanguageModelV3 | LanguageModelV2 union typed as `LanguageModel`.
 * We use `unknown` here to avoid coupling to the AI SDK's internal type hierarchy.
 * The actual model instances are passed through to streamText() which validates them.
 */
type AnyLanguageModel = unknown;

export type ProviderName =
  | "anthropic"
  | "openai"
  | "google"
  | "ollama"
  | "openai-compatible";

export interface ProviderConfig {
  provider: ProviderName;
  model: string;
  apiKey?: string;
  baseUrl?: string;
}

/**
 * Create an AI SDK LanguageModel from provider configuration.
 * Throws on invalid config or missing API keys (except Ollama).
 */
export async function createLanguageModel(
  config: ProviderConfig
): Promise<AnyLanguageModel> {
  switch (config.provider) {
    case "anthropic":
      return createAnthropicModel(config);
    case "openai":
      return createOpenAIModel(config);
    case "google":
      return createGoogleModel(config);
    case "ollama":
      return createOllamaModel(config);
    case "openai-compatible":
      return createOpenAICompatibleModel(config);
    default: {
      const _exhaustive: never = config.provider;
      throw new Error(`Unknown provider: ${config.provider}`);
    }
  }
}

async function createAnthropicModel(
  config: ProviderConfig
): Promise<AnyLanguageModel> {
  const { createAnthropic } = await import("@ai-sdk/anthropic");
  const anthropic = createAnthropic({
    apiKey: config.apiKey ?? process.env.ANTHROPIC_API_KEY,
  });
  return anthropic(config.model);
}

async function createOpenAIModel(
  config: ProviderConfig
): Promise<AnyLanguageModel> {
  const { createOpenAI } = await import("@ai-sdk/openai");
  const openai = createOpenAI({
    apiKey: config.apiKey ?? process.env.OPENAI_API_KEY,
    ...(config.baseUrl ? { baseURL: config.baseUrl } : {}),
  });
  return openai(config.model);
}

async function createGoogleModel(
  config: ProviderConfig
): Promise<AnyLanguageModel> {
  const { createGoogleGenerativeAI } = await import("@ai-sdk/google");
  const google = createGoogleGenerativeAI({
    apiKey: config.apiKey ?? process.env.GOOGLE_GENERATIVE_AI_API_KEY,
  });
  return google(config.model);
}

/**
 * Ollama uses the OpenAI-compatible endpoint with a local baseURL.
 * No API key required — Ollama runs locally.
 */
async function createOllamaModel(
  config: ProviderConfig
): Promise<AnyLanguageModel> {
  const { createOpenAI } = await import("@ai-sdk/openai");
  const ollama = createOpenAI({
    baseURL: config.baseUrl ?? "http://localhost:11434/v1",
    apiKey: "ollama",
  });
  return ollama(config.model);
}

/**
 * Any OpenAI-compatible API (LM Studio, vLLM, Together, Fireworks, etc.)
 * Requires baseUrl to be set.
 */
async function createOpenAICompatibleModel(
  config: ProviderConfig
): Promise<AnyLanguageModel> {
  if (!config.baseUrl) {
    throw new Error("openai-compatible provider requires baseUrl to be set");
  }
  const { createOpenAI } = await import("@ai-sdk/openai");
  const compatible = createOpenAI({
    baseURL: config.baseUrl,
    apiKey: config.apiKey ?? "no-key",
  });
  return compatible(config.model);
}

/**
 * List of all supported provider names.
 */
export const SUPPORTED_PROVIDERS: readonly ProviderName[] = [
  "anthropic",
  "openai",
  "google",
  "ollama",
  "openai-compatible",
] as const;
