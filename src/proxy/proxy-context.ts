/**
 * ProxyContext — Local-only context for the proxy.
 *
 * Local-only LLM adapter — optional BYO-LLM capability.
 */

import type { LocalLlmAdapter } from "../intelligence/local-llm.js";

export interface ProxyContext {
  readonly llmAdapter: LocalLlmAdapter | null;
}

/**
 * Create a ProxyContext with optional BYO-LLM adapter.
 */
export function createLocalContext(
  llmAdapter: LocalLlmAdapter | null = null
): ProxyContext {
  return { llmAdapter };
}
