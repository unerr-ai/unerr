/**
 * Sprint P2-4: Per-session lift metric.
 *
 * Computes the reasoning improvement ("lift") that the router provides:
 *   lift = accuracyWithRouter - baselineAccuracy
 *
 * A positive lift means the router is helping the agent select tools
 * more accurately. A negative lift (rare) means the router's masking
 * is counterproductive and should be investigated.
 *
 * Additional metrics:
 *   - Retry reduction: baselineRetries - currentRetries
 *   - Prevention rate: preventedWrongCalls / totalSoftRefuses
 *   - Efficiency gain: tokens saved per wrong call prevented
 */

import type { BaselineStats } from "./baseline.js";
import type { CounterSnapshot } from "./counter.js";

export interface LiftMetrics {
  readonly accuracyLift: number;
  readonly retryReduction: number;
  readonly preventionRate: number;
  readonly currentAccuracy: number;
  readonly baselineAccuracy: number;
  readonly isPositive: boolean;
  readonly confidence: "low" | "medium" | "high";
}

export interface LiftInput {
  readonly baseline: BaselineStats;
  readonly currentAccuracy: number;
  readonly counter: CounterSnapshot;
  readonly sessionCalls: number;
}

/**
 * Compute the per-session lift metric.
 *
 * Confidence levels:
 *   - high: ≥30 calls in session AND ≥5 baseline sessions
 *   - medium: ≥15 calls OR ≥3 baseline sessions
 *   - low: fewer calls/sessions
 */
export function computeLift(input: LiftInput): LiftMetrics {
  const { baseline, currentAccuracy, counter, sessionCalls } = input;

  const accuracyLift = currentAccuracy - baseline.averageAccuracy;
  const retryReduction = baseline.averageRetries - counter.totalRetries;
  const preventionRate =
    counter.totalSoftRefuses > 0
      ? counter.preventedWrongCalls / counter.totalSoftRefuses
      : 0;

  let confidence: "low" | "medium" | "high";
  if (sessionCalls >= 30 && baseline.sessionCount >= 5) {
    confidence = "high";
  } else if (sessionCalls >= 15 || baseline.sessionCount >= 3) {
    confidence = "medium";
  } else {
    confidence = "low";
  }

  return {
    accuracyLift,
    retryReduction,
    preventionRate,
    currentAccuracy,
    baselineAccuracy: baseline.averageAccuracy,
    isPositive: accuracyLift > 0,
    confidence,
  };
}

/**
 * Format lift metrics as a human-readable summary string.
 * Used by the CLI `unerr router status` output and dashboard.
 */
export function formatLiftSummary(lift: LiftMetrics): string {
  const sign = lift.accuracyLift >= 0 ? "+" : "";
  const pct = (lift.accuracyLift * 100).toFixed(1);
  const retries =
    lift.retryReduction >= 0
      ? `${lift.retryReduction.toFixed(1)} fewer retries`
      : `${Math.abs(lift.retryReduction).toFixed(1)} more retries`;

  return (
    `Accuracy lift: ${sign}${pct}% ` +
    `(${(lift.currentAccuracy * 100).toFixed(0)}% vs ${(lift.baselineAccuracy * 100).toFixed(0)}% baseline) · ` +
    `${retries} · ` +
    `Prevention rate: ${(lift.preventionRate * 100).toFixed(0)}% · ` +
    `Confidence: ${lift.confidence}`
  );
}
