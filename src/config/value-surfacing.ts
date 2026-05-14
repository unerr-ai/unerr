/**
 * Value Surfacing — guard formatter, scorecard, and counterfactual explanation.
 *
 * S8.1: Guard fires when session dollar savings exceed threshold.
 * S8.3: Session scorecard formats final session metrics.
 * S8.7: Counterfactual explanation: "Without unerr: ~XK tokens -> with unerr: YK tokens"
 */

export interface ValueSurfacingConfig {
  guardThresholdDollars: number;
  weeklyEnabled: boolean;
  scorecardEnabled: boolean;
  counterfactualEnabled: boolean;
  modelId: string;
}

const DEFAULT_CONFIG: ValueSurfacingConfig = {
  guardThresholdDollars: 0.5,
  weeklyEnabled: true,
  scorecardEnabled: true,
  counterfactualEnabled: true,
  modelId: "claude-sonnet-4-20250514",
};

let currentConfig: ValueSurfacingConfig = { ...DEFAULT_CONFIG };

export function getValueSurfacingConfig(): ValueSurfacingConfig {
  return { ...currentConfig };
}

export function setValueSurfacingConfig(
  overrides: Partial<ValueSurfacingConfig>,
): void {
  currentConfig = { ...currentConfig, ...overrides };
}

export function resetValueSurfacingConfig(): void {
  currentConfig = { ...DEFAULT_CONFIG };
}

// ── S8.1: Guard Formatter ───────────────────────────────────────────

export interface GuardState {
  fired: boolean;
  lastFiredAt: number;
}

/**
 * Creates a session-scoped guard that fires once when dollar savings threshold is crossed.
 */
export function createValueGuard(thresholdDollars?: number) {
  const threshold = thresholdDollars ?? currentConfig.guardThresholdDollars;
  const state: GuardState = { fired: false, lastFiredAt: 0 };

  /**
   * Check if the guard should fire. Returns the formatted message or null.
   */
  function check(sessionDollarsSaved: number): string | null {
    if (state.fired) return null;
    if (sessionDollarsSaved < threshold) return null;

    state.fired = true;
    state.lastFiredAt = Date.now();
    return formatGuardMessage(sessionDollarsSaved);
  }

  function hasFired(): boolean {
    return state.fired;
  }

  function reset(): void {
    state.fired = false;
    state.lastFiredAt = 0;
  }

  return { check, hasFired, reset };
}

function formatGuardMessage(dollarsSaved: number): string {
  return `unerr saved $${dollarsSaved.toFixed(2)} this session`;
}

// ── S8.3: Session Scorecard ─────────────────────────────────────────

export interface ScorecardInput {
  toolCalls: number;
  tokensSaved: number;
  dollarsSaved: number;
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
  dollarsSaved: string;
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
      `${input.blastRadiusComputed} blast radius computation${input.blastRadiusComputed !== 1 ? "s" : ""}`,
    );
  }
  if (input.conventionsInjected > 0) {
    intelligence.push(
      `${input.conventionsInjected} convention injection${input.conventionsInjected !== 1 ? "s" : ""}`,
    );
  }
  if (input.outputsCompressed > 0) {
    intelligence.push(
      `${input.outputsCompressed} output${input.outputsCompressed !== 1 ? "s" : ""} compressed`,
    );
  }
  if (input.correctionsApplied > 0) {
    intelligence.push(
      `${input.correctionsApplied} correction${input.correctionsApplied !== 1 ? "s" : ""} applied`,
    );
  }
  if (input.wrongApproachesPrevented > 0) {
    intelligence.push(
      `${input.wrongApproachesPrevented} wrong approach${input.wrongApproachesPrevented !== 1 ? "es" : ""} prevented`,
    );
  }

  const durationMin = Math.round(input.durationMs / 60_000);

  return {
    toolCalls: input.toolCalls,
    tokensSaved: formatTokens(input.tokensSaved),
    dollarsSaved: `$${input.dollarsSaved.toFixed(2)}`,
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
  tokensWith: number,
): string {
  const withoutStr = formatTokens(tokensWithout);
  const withStr = formatTokens(tokensWith);
  const reduction =
    tokensWithout > 0
      ? Math.round(((tokensWithout - tokensWith) / tokensWithout) * 100)
      : 0;
  return `Without unerr: ~${withoutStr} tokens \u2192 with unerr: ${withStr} tokens (${reduction}% reduction)`;
}

// ── S8.2: Per-response _meta fields ─────────────────────────────────

export interface ValueMeta {
  tokens_saved: number;
  dollar_savings: number;
  optimization?: string;
  powered_by: string;
}

/**
 * Assemble value meta fields for a single response.
 */
export function assembleValueMeta(
  tokensSaved: number,
  dollarSavings: number,
  optimizationDescription?: string,
): ValueMeta {
  const meta: ValueMeta = {
    tokens_saved: tokensSaved,
    dollar_savings: Math.round(dollarSavings * 1_000_000) / 1_000_000,
    powered_by: "unerr \u2014 intelligent token optimization",
  };

  if (optimizationDescription) {
    meta.optimization = optimizationDescription;
  }

  return meta;
}

// ── Shared Utilities ────────────────────────────────────────────────

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}
