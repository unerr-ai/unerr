/**
 * Value Surfacing — session scorecard and counterfactual explanation.
 *
 * S8.3: Session scorecard formats final session metrics (tokens + turns only).
 * S8.7: Counterfactual explanation: "Without unerr: ~XK tokens -> with unerr: YK tokens"
 *
 * Savings are expressed purely in tokens and tool-calls — no dollar figures.
 */

export interface ValueSurfacingConfig {
  weeklyEnabled: boolean;
  scorecardEnabled: boolean;
  counterfactualEnabled: boolean;
}

const DEFAULT_CONFIG: ValueSurfacingConfig = {
  weeklyEnabled: true,
  scorecardEnabled: true,
  counterfactualEnabled: true,
};

let currentConfig: ValueSurfacingConfig = { ...DEFAULT_CONFIG };

export function getValueSurfacingConfig(): ValueSurfacingConfig {
  return { ...currentConfig };
}

export function setValueSurfacingConfig(
  overrides: Partial<ValueSurfacingConfig>
): void {
  currentConfig = { ...currentConfig, ...overrides };
}

export function resetValueSurfacingConfig(): void {
  currentConfig = { ...DEFAULT_CONFIG };
}

// ── S8.3: Session Scorecard ─────────────────────────────────────────

export interface ScorecardInput {
  toolCalls: number;
  tokensSaved: number;
  efficiency: number;
  durationMs: number;
  blastRadiusComputed: number;
  conventionsInjected: number;
  correctionsApplied: number;
  outputsCompressed: number;
  wrongApproachesPrevented: number;
}

export interface Scorecard {
  toolCalls: number;
  tokensSaved: string;
  efficiency: string;
  duration: string;
  intelligenceApplied: string[];
}

/**
 * Format a session scorecard from raw metrics.
 */
export function formatScorecard(input: ScorecardInput): Scorecard {
  const intelligence: string[] = [];

  if (input.blastRadiusComputed > 0) {
    intelligence.push(
      `${input.blastRadiusComputed} blast radius computation${input.blastRadiusComputed !== 1 ? "s" : ""}`
    );
  }
  if (input.conventionsInjected > 0) {
    intelligence.push(
      `${input.conventionsInjected} convention injection${input.conventionsInjected !== 1 ? "s" : ""}`
    );
  }
  if (input.outputsCompressed > 0) {
    intelligence.push(
      `${input.outputsCompressed} output${input.outputsCompressed !== 1 ? "s" : ""} compressed`
    );
  }
  if (input.correctionsApplied > 0) {
    intelligence.push(
      `${input.correctionsApplied} correction${input.correctionsApplied !== 1 ? "s" : ""} applied`
    );
  }
  if (input.wrongApproachesPrevented > 0) {
    intelligence.push(
      `${input.wrongApproachesPrevented} wrong approach${input.wrongApproachesPrevented !== 1 ? "es" : ""} prevented`
    );
  }

  const durationMin = Math.round(input.durationMs / 60_000);

  return {
    toolCalls: input.toolCalls,
    tokensSaved: formatTokens(input.tokensSaved),
    efficiency: `${Math.round(input.efficiency)}%`,
    duration: durationMin > 0 ? `${durationMin} min` : "<1 min",
    intelligenceApplied: intelligence,
  };
}

// ── S8.7: Counterfactual Explanation ────────────────────────────────

/**
 * Build counterfactual explanation string.
 * "Without unerr: ~XK tokens -> with unerr: YK tokens (Z% reduction)"
 */
export function formatCounterfactual(
  tokensWithout: number,
  tokensWith: number
): string {
  const withoutStr = formatTokens(tokensWithout);
  const withStr = formatTokens(tokensWith);
  const reduction =
    tokensWithout > 0
      ? Math.round(((tokensWithout - tokensWith) / tokensWithout) * 100)
      : 0;
  return `Without unerr: ~${withoutStr} tokens → with unerr: ${withStr} tokens (${reduction}% reduction)`;
}

// ── Shared Utilities ────────────────────────────────────────────────

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}
