/**
 * Budget Enforcer — enforces per-response token budgets.
 *
 * Responses exceeding the budget are smart-trimmed:
 *   1. If text: truncate with "..." marker, preserving first/last segments
 *   2. Adds _meta["dev.unerr/truncated"] = true
 *   3. Adds _meta["dev.unerr/original_tokens"] with the pre-truncation count
 *
 * Only applies to text-heavy responses. Structured data (JSON objects with
 * entity keys, blast radius) passes through unchanged.
 */

import { estimateTokenCount } from "../intelligence/token-estimator.js";

export interface BudgetEnforcerOptions {
  defaultBudget?: number;
  preserveHeadRatio?: number;
}

export interface EnforcedResult {
  content: string;
  truncated: boolean;
  originalTokens: number;
  deliveredTokens: number;
}

/**
 * Enforce a token budget on text content.
 * Returns the (possibly truncated) content and metadata.
 */
export function enforceBudget(
  content: string,
  budget?: number,
  options: BudgetEnforcerOptions = {}
): EnforcedResult {
  const maxTokens = budget ?? options.defaultBudget ?? 4000;
  const headRatio = options.preserveHeadRatio ?? 0.7;
  const originalTokens = estimateTokenCount(content);

  if (originalTokens <= maxTokens) {
    return {
      content,
      truncated: false,
      originalTokens,
      deliveredTokens: originalTokens,
    };
  }

  const lines = content.split("\n");
  const headLines = Math.floor(lines.length * headRatio);
  const tailLines = Math.max(3, Math.floor(lines.length * 0.1));

  const head = lines.slice(0, headLines);
  const tail = lines.slice(-tailLines);

  let result = head.join("\n");
  let tokens = estimateTokenCount(result);

  while (tokens > maxTokens * headRatio && head.length > 10) {
    head.pop();
    result = head.join("\n");
    tokens = estimateTokenCount(result);
  }

  const omittedCount = lines.length - head.length - tail.length;
  const marker = `\n\n[... ${omittedCount} lines truncated (${originalTokens - tokens} tokens over budget) ...]\n\n`;
  const tailText = tail.join("\n");

  const truncatedContent = result + marker + tailText;
  const deliveredTokens = estimateTokenCount(truncatedContent);

  return {
    content: truncatedContent,
    truncated: true,
    originalTokens,
    deliveredTokens,
  };
}

/**
 * Check if content is structured JSON (skip budget enforcement).
 */
export function isStructuredContent(content: unknown): boolean {
  if (typeof content !== "string") return true;
  const trimmed = content.trim();
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    try {
      JSON.parse(trimmed);
      return true;
    } catch {
      return false;
    }
  }
  return false;
}
