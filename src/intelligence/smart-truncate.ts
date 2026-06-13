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
  /**
   * §4 reversible-compression: content hash of the cached full original when a
   * `cacheOriginal` callback was supplied AND truncation dropped content (T1.4).
   * Undefined when nothing was dropped or no cache was wired. The caller records
   * it on the compression_events row and the retrieve side resolves a slice
   * against it instead of re-requesting the whole entity at a larger budget.
   */
  cache_ref?: string;
}

export interface TruncationInput {
  metadata: string;
  imports: string;
  signatures: string;
  bodies: string;
  budget: number;
  /**
   * Optional reversible-cache hook (T1.4). When supplied AND the entity is
   * truncated, `smartTruncate` calls it with the FULL pre-truncation content
   * and folds the returned hash into the marker + `cache_ref`, so a follow-up
   * read pulls back only the withheld window. Kept as a callback (not a direct
   * `getSharedReversibleCache` import) so the function stays pure and the cache
   * lifecycle is owned by the caller — also keeps unit tests cache-free.
   */
  cacheOriginal?: (fullContent: string) => string;
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

  let cacheRef: string | undefined;
  if (level !== "full") {
    // T1.4: cache the FULL original so the agent can pull back only the
    // withheld window via a cache_ref read, instead of re-requesting the whole
    // entity at a larger token_budget. Best-effort — a cache failure or absent
    // callback just leaves the existing token_budget marker unchanged.
    if (input.cacheOriginal) {
      try {
        const ref = input.cacheOriginal(fullContent);
        if (ref) cacheRef = ref;
      } catch {
        /* best effort — never block truncation on a cache failure */
      }
    }

    const totalBodyLines = input.bodies ? input.bodies.split("\n").length : 0;
    const includedBodyLines =
      level === "signatures_and_bodies" || level === "signatures_only"
        ? countIncludedBodyLines(result, input.bodies)
        : 0;
    const omittedLines = totalBodyLines - includedBodyLines;

    // Cache-ref retrieval is the cheaper next-action than a full re-request, so
    // surface it alongside the existing token_budget marker (kept for the cache
    // -miss fallback path). Concrete numbers, named tool — nudge-rule-compliant.
    const cacheTail = cacheRef
      ? ` Or retrieve the withheld slice via file_read({cache_ref:'${cacheRef}', offset:0, limit:2000}).`
      : "";
    if (omittedLines > 0) {
      result += `\n\n// ... ${omittedLines} lines omitted. Request with token_budget: ${fullTokens} for full content.${cacheTail}`;
    } else {
      result += `\n\n// ... truncated. Request with token_budget: ${fullTokens} for full content.${cacheTail}`;
    }
  }

  return {
    content: result,
    tokens_used: estimateTokens(result),
    tokens_budget: budget,
    truncated: level !== "full",
    truncation_level: level,
    full_tokens_estimate: fullTokens,
    ...(cacheRef ? { cache_ref: cacheRef } : {}),
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
