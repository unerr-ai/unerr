/**
 * Context Rot Detector — detects session degradation and injects recovery.
 *
 * U.14: Detects when an ongoing session suffers from context rot:
 *   - Depth threshold: >200K tokens estimated → warning, >300K → critical
 *   - Repeated exploration: agent re-queries delivered entities
 *   - Declining precision: increasing error rate
 *   - Forgotten context: agent requests already-delivered info
 *   - Rule amnesia: convention violated after delivery
 *
 * U.15: Takes corrective action:
 *   - rot 0.4-0.7: inject context refresh
 *   - rot > 0.7: suggest new session
 */

export type ContextRotIndicator =
  | { type: "depth_threshold"; tokens: number; threshold: number }
  | { type: "repeated_exploration"; entity: string; queryCount: number }
  | { type: "declining_precision"; recentErrors: number; window: number }
  | {
      type: "forgotten_context";
      key: string;
      deliveredAt: number;
      requeriedAt: number;
    }
  | {
      type: "rule_amnesia";
      convention: string;
      violatedAfterDelivery: boolean;
    };

export interface ContextRotSignal {
  estimatedDepth: number;
  rotConfidence: number;
  signals: ContextRotIndicator[];
  action: "none" | "inject_refresh" | "suggest_new_session";
}

export interface ContextRotDetector {
  recordToolCallTokens: (tokens: number) => void;
  recordRepeatedQuery: (entityKey: string) => void;
  recordError: () => void;
  recordForgottenContext: (key: string, deliveredAt: number) => void;
  recordConventionViolationAfterDelivery: (convention: string) => void;
  evaluate: () => ContextRotSignal;
  getRefreshContext: () => Record<string, unknown> | null;
  reset: () => void;
}

const DEPTH_WARNING = 200_000;
const DEPTH_CRITICAL = 300_000;
const REPEATED_QUERY_THRESHOLD = 3;
const ERROR_SPIKE_THRESHOLD = 5;

export function createContextRotDetector(): ContextRotDetector {
  let estimatedDepth = 0;
  const queryCountMap = new Map<string, number>();
  let recentErrors = 0;
  const forgottenKeys: Array<{
    key: string;
    deliveredAt: number;
    requeriedAt: number;
  }> = [];
  const amnesiaConventions: string[] = [];
  let lastRefreshContext: Record<string, unknown> | null = null;

  function recordToolCallTokens(tokens: number): void {
    estimatedDepth += tokens;
  }

  function recordRepeatedQuery(entityKey: string): void {
    queryCountMap.set(entityKey, (queryCountMap.get(entityKey) ?? 0) + 1);
  }

  function recordError(): void {
    recentErrors++;
  }

  function recordForgottenContext(key: string, deliveredAt: number): void {
    forgottenKeys.push({ key, deliveredAt, requeriedAt: Date.now() });
  }

  function recordConventionViolationAfterDelivery(convention: string): void {
    amnesiaConventions.push(convention);
  }

  function evaluate(): ContextRotSignal {
    const signals: ContextRotIndicator[] = [];
    let rotScore = 0;

    if (estimatedDepth > DEPTH_CRITICAL) {
      signals.push({
        type: "depth_threshold",
        tokens: estimatedDepth,
        threshold: DEPTH_CRITICAL,
      });
      rotScore += 0.4;
    } else if (estimatedDepth > DEPTH_WARNING) {
      signals.push({
        type: "depth_threshold",
        tokens: estimatedDepth,
        threshold: DEPTH_WARNING,
      });
      rotScore += 0.2;
    }

    for (const [entity, count] of queryCountMap) {
      if (count >= REPEATED_QUERY_THRESHOLD) {
        signals.push({
          type: "repeated_exploration",
          entity,
          queryCount: count,
        });
        rotScore += 0.15;
      }
    }

    if (recentErrors >= ERROR_SPIKE_THRESHOLD) {
      signals.push({ type: "declining_precision", recentErrors, window: 10 });
      rotScore += 0.2;
    }

    for (const forgotten of forgottenKeys.slice(-5)) {
      signals.push({
        type: "forgotten_context",
        key: forgotten.key,
        deliveredAt: forgotten.deliveredAt,
        requeriedAt: forgotten.requeriedAt,
      });
      rotScore += 0.1;
    }

    for (const convention of amnesiaConventions.slice(-3)) {
      signals.push({
        type: "rule_amnesia",
        convention,
        violatedAfterDelivery: true,
      });
      rotScore += 0.15;
    }

    const rotConfidence = Math.min(1.0, rotScore);
    let action: ContextRotSignal["action"] = "none";

    if (rotConfidence > 0.7) {
      action = "suggest_new_session";
    } else if (rotConfidence > 0.4) {
      action = "inject_refresh";
    }

    if (action === "inject_refresh" || action === "suggest_new_session") {
      lastRefreshContext = {
        reason:
          action === "suggest_new_session"
            ? "severe_context_rot"
            : "context_degradation",
        estimated_depth: estimatedDepth,
        rot_confidence: Math.round(rotConfidence * 100) / 100,
        repeated_entities: [...queryCountMap.entries()]
          .filter(([_, c]) => c >= REPEATED_QUERY_THRESHOLD)
          .map(([e]) => e),
        recommendation:
          action === "suggest_new_session"
            ? "Start a new session. Current context is degraded beyond recovery."
            : "Critical context refreshed. Proceed with caution.",
      };
    }

    return { estimatedDepth, rotConfidence, signals, action };
  }

  function getRefreshContext(): Record<string, unknown> | null {
    return lastRefreshContext;
  }

  function reset(): void {
    estimatedDepth = 0;
    queryCountMap.clear();
    recentErrors = 0;
    forgottenKeys.length = 0;
    amnesiaConventions.length = 0;
    lastRefreshContext = null;
  }

  return {
    recordToolCallTokens,
    recordRepeatedQuery,
    recordError,
    recordForgottenContext,
    recordConventionViolationAfterDelivery,
    evaluate,
    getRefreshContext,
    reset,
  };
}
