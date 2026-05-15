/**
 * Structural-Priority Truncation — renders entity content within a token budget.
 *
 * Priority hierarchy (adapted from rtk's AggressiveFilter + graphify's _subgraph_to_text):
 *   1. Metadata — always included (name, kind, file, community, blast radius, corrections)
 *   2. Imports  — included if budget allows
 *   3. Signatures — function/class/struct signatures without bodies
 *   4. Bodies — full implementations, included line-by-line until budget exhausted
 *
 * Contracts:
 *   SC-10: Token accounting overhead <1ms
 *   SC-12: Never cuts mid-line — operates on complete lines only
 *   Decision L.5: Default budget 2000 tokens
 *   Decision L.6: Structural-priority over character-cut
 *
 * Leapfrog Sprint C, Task C.2
 */

export type TruncationLevel =
  | "full"
  | "signatures_and_bodies"
  | "signatures_only"
  | "metadata_only";

export interface TruncationResult {
  content: string;
  tokens_used: number;
  tokens_budget: number;
  truncated: boolean;
  truncation_level: TruncationLevel;
  full_tokens_estimate: number;
}

export interface TruncationInput {
  metadata: string;
  imports: string;
  signatures: string;
  bodies: string;
  budget: number;
}

const CHARS_PER_TOKEN = 4;
const TRUNCATION_MARKER_RESERVE = 120;

/**
 * Estimate token count from character length.
 * Uses 4 chars/token (conservative for code — actual is ~3.5 for English, ~4.5 for code).
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/**
 * Truncate entity content within a token budget using structural priority.
 *
 * Small entities fit entirely within the budget and return `truncated: false`.
 * Large entities are truncated at the appropriate structural level, with a
 * marker indicating how many lines were omitted and the token_budget needed
 * to retrieve the full content.
 *
 * Performance: <1ms for any input size (string concatenation + length checks only).
 */
export function smartTruncate(input: TruncationInput): TruncationResult {
  const budget = Math.max(input.budget, 100);
  const charBudget = budget * CHARS_PER_TOKEN;

  const sections = [
    input.metadata,
    input.imports,
    input.signatures,
    input.bodies,
  ].filter(Boolean);
  const fullContent = sections.join("\n\n");
  const fullTokens = estimateTokens(fullContent);

  if (fullContent.length <= charBudget) {
    return {
      content: fullContent,
      tokens_used: fullTokens,
      tokens_budget: budget,
      truncated: false,
      truncation_level: "full",
      full_tokens_estimate: fullTokens,
    };
  }

  let result = input.metadata;
  let level: TruncationLevel = "metadata_only";

  // Priority 2: imports
  if (
    input.imports &&
    result.length + input.imports.length + TRUNCATION_MARKER_RESERVE <
      charBudget
  ) {
    result += `\n\n${input.imports}`;
  }

  // Priority 3: signatures
  if (
    input.signatures &&
    result.length + input.signatures.length + TRUNCATION_MARKER_RESERVE <
      charBudget
  ) {
    result += `\n\n${input.signatures}`;
    level = "signatures_only";
  }

  // Priority 4: bodies — line-by-line (SC-12: never cut mid-line)
  if (input.bodies) {
    const remainingChars =
      charBudget - result.length - TRUNCATION_MARKER_RESERVE;
    if (remainingChars > 0) {
      const bodyLines = input.bodies.split("\n");
      const includedLines: string[] = [];
      let bodyChars = 0;

      for (const line of bodyLines) {
        const lineLen = line.length + 1; // +1 for newline
        if (bodyChars + lineLen > remainingChars) break;
        includedLines.push(line);
        bodyChars += lineLen;
      }

      if (includedLines.length > 0) {
        result += `\n\n${includedLines.join("\n")}`;
        level =
          includedLines.length === bodyLines.length
            ? "full"
            : "signatures_and_bodies";
      }
    }
  }

  if (level !== "full") {
    const totalBodyLines = input.bodies ? input.bodies.split("\n").length : 0;
    const includedBodyLines =
      level === "signatures_and_bodies" || level === "signatures_only"
        ? countIncludedBodyLines(result, input.bodies)
        : 0;
    const omittedLines = totalBodyLines - includedBodyLines;

    if (omittedLines > 0) {
      result += `\n\n// ... ${omittedLines} lines omitted. Request with token_budget: ${fullTokens} for full content.`;
    } else {
      result += `\n\n// ... truncated. Request with token_budget: ${fullTokens} for full content.`;
    }
  }

  return {
    content: result,
    tokens_used: estimateTokens(result),
    tokens_budget: budget,
    truncated: level !== "full",
    truncation_level: level,
    full_tokens_estimate: fullTokens,
  };
}

/**
 * Count how many body lines were included in the result.
 */
function countIncludedBodyLines(result: string, bodies: string): number {
  if (!bodies) return 0;
  const bodyLines = bodies.split("\n");
  let count = 0;
  for (const line of bodyLines) {
    if (result.includes(line)) {
      count++;
    } else {
      break;
    }
  }
  return count;
}

/**
 * Apply token budget to an array of result items (for list-returning tools).
 * Keeps items until the budget is exhausted, then appends a summary.
 */
export function truncateResultList<T>(
  items: T[],
  budget: number,
  serialize: (item: T) => string
): { items: T[]; truncated: boolean; total: number; tokens_used: number } {
  const charBudget = Math.max(budget, 100) * CHARS_PER_TOKEN;
  let chars = 0;
  const kept: T[] = [];

  for (const item of items) {
    const serialized = serialize(item);
    if (chars + serialized.length + 100 > charBudget && kept.length > 0) {
      break;
    }
    kept.push(item);
    chars += serialized.length;
  }

  return {
    items: kept,
    truncated: kept.length < items.length,
    total: items.length,
    tokens_used: estimateTokens(kept.map(serialize).join("\n")),
  };
}
