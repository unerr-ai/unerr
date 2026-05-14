/**
 * Efficiency Metric Tracker — session-scoped token efficiency accumulator.
 *
 * Layer 10 supersession: When a TokenFlowWriter is provided, the tracker
 * derives all metrics from the unified token flow event stream instead of
 * maintaining separate counters. This eliminates dual-counting between
 * EfficiencyTracker and ExplorationCost.
 *
 * When no TokenFlowWriter is available (e.g. degraded mode), falls back
 * to the original in-memory counter implementation.
 */

import type { TokenFlowWriter } from "../tracking/token-flow.js";
import { aggregateSession } from "../tracking/token-flow.js";

export interface EfficiencySnapshot {
  totalCalls: number;
  originalTokens: number;
  deliveredTokens: number;
  savedTokens: number;
  efficiency: number;
  avgSavingsPerCall: number;
}

export interface EfficiencyTracker {
  record: (originalTokens: number, deliveredTokens: number) => void;
  getSnapshot: () => EfficiencySnapshot;
  getEfficiency: () => number;
  getSavedTokens: () => number;
  reset: () => void;
}

/**
 * Create an efficiency tracker backed by TokenFlowWriter.
 * The `record()` method is a no-op — all tracking is done by the token flow
 * instrumentation points (graph_query, format_encoding, etc.).
 * `getSnapshot()` reads from the token flow event stream.
 */
export function createEfficiencyTracker(
  tokenFlow?: TokenFlowWriter,
): EfficiencyTracker {
  if (tokenFlow) {
    return {
      record: () => {},
      getSnapshot: () => {
        const events = tokenFlow.getSessionEvents();
        const summary = aggregateSession(events, tokenFlow.sessionId);
        return {
          totalCalls: summary.total_turns,
          originalTokens: summary.total_tokens_without,
          deliveredTokens: summary.total_tokens_with,
          savedTokens: summary.total_tokens_saved,
          efficiency: summary.efficiency_pct,
          avgSavingsPerCall:
            summary.total_turns > 0
              ? Math.round(summary.total_tokens_saved / summary.total_turns)
              : 0,
        };
      },
      getEfficiency: () => tokenFlow.getSessionEfficiency(),
      getSavedTokens: () => tokenFlow.getSessionTokensSaved(),
      reset: () => {},
    };
  }

  // Fallback: standalone in-memory tracker (no TokenFlow available)
  let totalCalls = 0;
  let originalTokens = 0;
  let deliveredTokens = 0;

  return {
    record(original: number, delivered: number): void {
      totalCalls++;
      originalTokens += original;
      deliveredTokens += delivered;
    },
    getSnapshot(): EfficiencySnapshot {
      const saved = Math.max(0, originalTokens - deliveredTokens);
      return {
        totalCalls,
        originalTokens,
        deliveredTokens,
        savedTokens: saved,
        efficiency:
          originalTokens === 0
            ? 0
            : Math.round(
                ((originalTokens - deliveredTokens) / originalTokens) * 100,
              ),
        avgSavingsPerCall: totalCalls > 0 ? Math.round(saved / totalCalls) : 0,
      };
    },
    getEfficiency(): number {
      if (originalTokens === 0) return 0;
      return Math.round(
        ((originalTokens - deliveredTokens) / originalTokens) * 100,
      );
    },
    getSavedTokens(): number {
      return Math.max(0, originalTokens - deliveredTokens);
    },
    reset(): void {
      totalCalls = 0;
      originalTokens = 0;
      deliveredTokens = 0;
    },
  };
}
