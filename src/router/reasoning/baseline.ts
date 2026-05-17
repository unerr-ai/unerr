/**
 * Sprint P2-4: Selection-accuracy baseline.
 *
 * Computes a baseline "tool selection accuracy" from historical
 * (pre-router) sessions for the same repository. This baseline
 * represents how well the agent selects tools WITHOUT the router's
 * intent-aware masking and soft-refuse guidance.
 *
 * Data source: `.unerr/router/metrics.jsonl` records from sessions
 * where the router was in "passthrough" mode (no masking), or from
 * pre-router telemetry.
 *
 * The baseline is computed once and cached per-repo. It updates
 * incrementally as more unrouted sessions complete.
 */

import type { ToolCallTrace } from "./wrong-call-detector.js";
import { detectWrongCalls } from "./wrong-call-detector.js";
import { countRetries } from "./counter.js";

export interface BaselineSession {
  readonly sessionId: string;
  readonly traces: readonly ToolCallTrace[];
  readonly totalCalls: number;
  readonly wrongCalls: number;
  readonly retries: number;
  readonly accuracy: number;
}

export interface BaselineStats {
  readonly sessionCount: number;
  readonly averageAccuracy: number;
  readonly averageRetries: number;
  readonly averageWrongCallRate: number;
  readonly totalCalls: number;
}

/**
 * Compute baseline stats from a set of historical session traces.
 * Each session is analyzed independently, then aggregated.
 */
export function computeBaseline(sessions: readonly { sessionId: string; traces: readonly ToolCallTrace[] }[]): BaselineStats {
  if (sessions.length === 0) {
    return {
      sessionCount: 0,
      averageAccuracy: 1.0,
      averageRetries: 0,
      averageWrongCallRate: 0,
      totalCalls: 0,
    };
  }

  const analyzed: BaselineSession[] = sessions.map((s) => {
    const detection = detectWrongCalls(s.traces);
    const retries = countRetries(s.traces);
    return {
      sessionId: s.sessionId,
      traces: s.traces,
      totalCalls: s.traces.length,
      wrongCalls: detection.wrongCalls.length,
      retries,
      accuracy: 1 - detection.wrongCallRate,
    };
  });

  const totalCalls = analyzed.reduce((sum, s) => sum + s.totalCalls, 0);
  const totalSessions = analyzed.length;

  const averageAccuracy = analyzed.reduce((sum, s) => sum + s.accuracy, 0) / totalSessions;
  const averageRetries = analyzed.reduce((sum, s) => sum + s.retries, 0) / totalSessions;
  const averageWrongCallRate = analyzed.reduce((sum, s) => sum + (s.wrongCalls / Math.max(1, s.totalCalls)), 0) / totalSessions;

  return {
    sessionCount: totalSessions,
    averageAccuracy,
    averageRetries,
    averageWrongCallRate,
    totalCalls,
  };
}

/**
 * Analyze a single session for baseline comparison.
 */
export function analyzeSession(sessionId: string, traces: readonly ToolCallTrace[]): BaselineSession {
  const detection = detectWrongCalls(traces);
  const retries = countRetries(traces);
  return {
    sessionId,
    traces,
    totalCalls: traces.length,
    wrongCalls: detection.wrongCalls.length,
    retries,
    accuracy: 1 - detection.wrongCallRate,
  };
}
