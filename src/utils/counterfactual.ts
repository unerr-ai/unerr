/**
 * Counterfactual Framing Utility — wraps all savings displays in
 * "without unerr" framing for value perception.
 *
 * VS.8: Every savings display must use counterfactual language:
 *   "Without unerr, ~15K additional tokens would have been consumed"
 *   "Without unerr, the agent would have explored 15 files to find this"
 */

/**
 * Frame a token savings as a counterfactual statement.
 */
export function frameTokenSavings(tokensSaved: number): string {
  if (tokensSaved <= 0) return "";
  const tokensStr =
    tokensSaved >= 1000
      ? `${(tokensSaved / 1000).toFixed(1)}K`
      : String(tokensSaved);
  return `Without unerr, ${tokensStr} additional tokens would have been consumed.`;
}

/**
 * Frame a guard moment (prevented token waste).
 */
export function frameGuardMoment(
  description: string,
  tokensPrevented: number
): string {
  const tokensStr =
    tokensPrevented >= 1000
      ? `${(tokensPrevented / 1000).toFixed(1)}K`
      : String(tokensPrevented);
  return `[unerr] ⚠ Prevented: ${description}. Without unerr, ~${tokensStr} tokens would have been consumed.`;
}

/**
 * Frame exploration savings.
 */
export function frameExplorationSaving(
  queryType: string,
  filesAvoided: number
): string {
  return `Without unerr, the agent would have read ~${filesAvoided} files to get this information.`;
}

/**
 * Frame session summary with counterfactual.
 */
export function frameSessionSummary(
  tokensSaved: number,
  guardsFirered: number
): string {
  const parts: string[] = [];
  if (tokensSaved > 0) {
    const tokensStr =
      tokensSaved >= 1000
        ? `${(tokensSaved / 1000).toFixed(1)}K`
        : String(tokensSaved);
    parts.push(`${tokensStr} tokens saved`);
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
  lastWeekSaved: number
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
  return `This week: ${tokensStr} tokens saved ${trend}`;
}
