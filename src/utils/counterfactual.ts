/**
 * Counterfactual Framing Utility — wraps all savings displays in
 * "without unerr" framing for value perception.
 *
 * VS.8: Every savings display must use counterfactual language:
 *   "Without unerr, this session would have cost $X.XX more"
 *   "Without unerr, the agent would have explored 15 files to find this"
 */

import { formatDollars } from "../proxy/model-pricing.js";

/**
 * Frame a token savings as a counterfactual statement.
 */
export function frameTokenSavings(
  tokensSaved: number,
  dollarsSaved: number,
): string {
  if (tokensSaved <= 0) return "";
  const tokensStr =
    tokensSaved >= 1000
      ? `${(tokensSaved / 1000).toFixed(1)}K`
      : String(tokensSaved);
  return `Without unerr, ${tokensStr} additional tokens (${formatDollars(dollarsSaved)}) would have been consumed.`;
}

/**
 * Frame a guard moment (prevented cost).
 */
export function frameGuardMoment(
  description: string,
  dollarsPrevented: number,
): string {
  return `[unerr] ⚠ Prevented: ${description}. Without unerr, est. cost: ${formatDollars(dollarsPrevented)}`;
}

/**
 * Frame exploration savings.
 */
export function frameExplorationSaving(
  queryType: string,
  filesAvoided: number,
): string {
  return `Without unerr, the agent would have read ~${filesAvoided} files to get this information.`;
}

/**
 * Frame session summary with counterfactual.
 */
export function frameSessionSummary(
  tokensSaved: number,
  dollarsSaved: number,
  guardsFirered: number,
): string {
  const parts: string[] = [];
  if (tokensSaved > 0) {
    const tokensStr =
      tokensSaved >= 1000
        ? `${(tokensSaved / 1000).toFixed(1)}K`
        : String(tokensSaved);
    parts.push(`${tokensStr} tokens saved (${formatDollars(dollarsSaved)})`);
  }
  if (guardsFirered > 0) {
    parts.push(`${guardsFirered} issue(s) prevented`);
  }
  if (parts.length === 0) {
    return "Graph intelligence active — monitoring for savings opportunities.";
  }
  return `Without unerr: ${parts.join(", ")} would have been wasted.`;
}

/**
 * Frame a weekly trend delta.
 */
export function frameWeeklyTrend(
  thisWeekSaved: number,
  lastWeekSaved: number,
  dollarsSaved: number,
): string {
  const trend =
    thisWeekSaved > lastWeekSaved
      ? "↑"
      : thisWeekSaved < lastWeekSaved
        ? "↓"
        : "→";
  const tokensStr =
    thisWeekSaved >= 1000
      ? `${(thisWeekSaved / 1000).toFixed(1)}K`
      : String(thisWeekSaved);
  return `This week: ${tokensStr} tokens saved (${formatDollars(dollarsSaved)}) ${trend}`;
}
