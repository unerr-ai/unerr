/**
 * Sprint P2-5: Outcome-quality scorer.
 *
 * Heuristic that determines how "good" an association's outcome was.
 * High quality means the agent clearly acted on the signal's results
 * (e.g., made an edit referencing fetched data).
 *
 * Scoring criteria:
 *   - high: tool succeeded + agent edited afterward referencing the result
 *   - medium: tool succeeded + meaningful response (>100 tokens)
 *   - low: tool returned empty/error, or trivial response
 *   - unknown: insufficient data to determine
 */

import type { OutcomeQuality, SubsequentCall } from "./types.js";

const MEANINGFUL_TOKEN_THRESHOLD = 100;
const HIGH_TOKEN_THRESHOLD = 300;

/**
 * Score the outcome quality of an associated tool call.
 *
 * @param call - The tool call that followed a signal
 * @param hasSubsequentEdit - Whether the agent made an edit after this call
 *   that appears to reference the call's results
 */
export function scoreOutcomeQuality(
  call: SubsequentCall,
  hasSubsequentEdit: boolean
): OutcomeQuality {
  if (call.outcome === "error") return "low";
  if (call.outcome === "empty") return "low";

  if (call.outcome === "success") {
    if (
      hasSubsequentEdit &&
      call.responseTokens >= MEANINGFUL_TOKEN_THRESHOLD
    ) {
      return "high";
    }
    if (call.responseTokens >= HIGH_TOKEN_THRESHOLD) {
      return "medium";
    }
    if (call.responseTokens >= MEANINGFUL_TOKEN_THRESHOLD) {
      return "medium";
    }
    return "low";
  }

  return "unknown";
}

/**
 * Compute average quality score (numeric) from quality labels.
 * high=1.0, medium=0.66, low=0.33, unknown=0.0
 */
export function qualityToNumeric(quality: OutcomeQuality): number {
  switch (quality) {
    case "high":
      return 1.0;
    case "medium":
      return 0.66;
    case "low":
      return 0.33;
    case "unknown":
      return 0.0;
  }
}

/**
 * Compute average quality from a set of records.
 */
export function averageQuality(qualities: readonly OutcomeQuality[]): number {
  if (qualities.length === 0) return 0;
  const sum = qualities.reduce((acc, q) => acc + qualityToNumeric(q), 0);
  return sum / qualities.length;
}
