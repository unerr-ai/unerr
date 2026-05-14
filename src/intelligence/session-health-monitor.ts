/**
 * Session Health Monitor — detects session degradation via 6 signal types.
 *
 * Tracks tool call patterns, entity targeting, convention violations, and
 * context depth to produce a composite health score (0.0–1.0) and actionable
 * recommendations. Designed to detect when an AI agent is struggling and
 * suggest course corrections before the session spirals.
 *
 * Signal types:
 *   1. repeated_query: same entity queried 3+ times (agent is looping)
 *   2. low_durability_targeting: targeting entity with durability < 0.3
 *   3. expanding_blast_radius: blast radius growing across queries
 *   4. convention_violation_spike: 3+ violations within 5 minutes
 *   5. tool_call_acceleration: tool call rate exceeding 10/min
 *   6. context_depth_warning: estimated context tokens exceeding 80K
 *
 * Health score: starts at 1.0 (perfect), each signal reduces it.
 */

import { createModuleLogger } from "../utils/logger.js";

const log = createModuleLogger("session-health");

export type SessionDegradationSignal =
  | { type: "repeated_query"; entity: string; count: number }
  | { type: "low_durability_targeting"; entity: string; durability: number }
  | { type: "expanding_blast_radius"; initial: number; current: number }
  | { type: "convention_violation_spike"; count: number; window_min: number }
  | { type: "tool_call_acceleration"; rate_per_min: number }
  | { type: "context_depth_warning"; estimated_tokens: number };

export interface SessionHealthSignal {
  health: number;
  signals: SessionDegradationSignal[];
  recommendation:
    | "continue"
    | "suggest_pause"
    | "suggest_new_session"
    | "inject_context_refresh";
}

interface ToolCallRecord {
  name: string;
  entityKey?: string;
  timestamp: number;
}

interface BlastRadiusRecord {
  entityKey: string;
  radius: number;
  timestamp: number;
}

const REPEATED_QUERY_THRESHOLD = 3;
const LOW_DURABILITY_THRESHOLD = 0.3;
const VIOLATION_SPIKE_THRESHOLD = 3;
const VIOLATION_WINDOW_MS = 5 * 60 * 1000;
const TOOL_CALL_RATE_THRESHOLD = 10;
const CONTEXT_TOKEN_WARNING = 80_000;
const CONTEXT_TOKEN_CRITICAL = 120_000;

const SIGNAL_WEIGHTS: Record<SessionDegradationSignal["type"], number> = {
  repeated_query: 0.1,
  low_durability_targeting: 0.08,
  expanding_blast_radius: 0.12,
  convention_violation_spike: 0.15,
  tool_call_acceleration: 0.1,
  context_depth_warning: 0.2,
};

const TOKENS_PER_TOOL_CALL = 800;

/**
 * Creates a session health monitor that accumulates signals over time
 * and provides a composite health assessment on demand.
 */
export function createSessionHealthMonitor(): {
  recordToolCall: (name: string, entityKey?: string) => void;
  recordConventionViolation: () => void;
  recordBlastRadius: (entityKey: string, radius: number) => void;
  recordDurability: (entityKey: string, durability: number) => void;
  getHealth: () => SessionHealthSignal;
  reset: () => void;
} {
  let toolCalls: ToolCallRecord[] = [];
  let conventionViolations: number[] = [];
  let blastRadiusHistory: BlastRadiusRecord[] = [];
  const entityDurability = new Map<string, number>();
  const entityQueryCounts = new Map<string, number>();

  function recordToolCall(name: string, entityKey?: string): void {
    const now = Date.now();
    toolCalls.push({ name, entityKey, timestamp: now });

    if (entityKey) {
      const count = entityQueryCounts.get(entityKey) ?? 0;
      entityQueryCounts.set(entityKey, count + 1);
    }

    pruneOldRecords(now);
  }

  function recordConventionViolation(): void {
    conventionViolations.push(Date.now());
  }

  function recordBlastRadius(entityKey: string, radius: number): void {
    blastRadiusHistory.push({
      entityKey,
      radius,
      timestamp: Date.now(),
    });
  }

  function recordDurability(entityKey: string, durability: number): void {
    entityDurability.set(entityKey, durability);
  }

  function getHealth(): SessionHealthSignal {
    const now = Date.now();
    const signals: SessionDegradationSignal[] = [];

    detectRepeatedQueries(signals);
    detectLowDurabilityTargeting(signals);
    detectExpandingBlastRadius(signals);
    detectConventionViolationSpike(signals, now);
    detectToolCallAcceleration(signals, now);
    detectContextDepthWarning(signals);

    const health = computeHealthScore(signals);
    const recommendation = deriveRecommendation(health, signals);

    return { health, signals, recommendation };
  }

  function reset(): void {
    toolCalls = [];
    conventionViolations = [];
    blastRadiusHistory = [];
    entityDurability.clear();
    entityQueryCounts.clear();
  }

  function detectRepeatedQueries(signals: SessionDegradationSignal[]): void {
    for (const [entity, count] of entityQueryCounts) {
      if (count >= REPEATED_QUERY_THRESHOLD) {
        signals.push({ type: "repeated_query", entity, count });
      }
    }
  }

  function detectLowDurabilityTargeting(
    signals: SessionDegradationSignal[],
  ): void {
    const recentEntities = new Set<string>();
    const recentCalls = toolCalls.slice(-20);

    for (const call of recentCalls) {
      if (call.entityKey) recentEntities.add(call.entityKey);
    }

    for (const entity of recentEntities) {
      const durability = entityDurability.get(entity);
      if (durability !== undefined && durability < LOW_DURABILITY_THRESHOLD) {
        signals.push({
          type: "low_durability_targeting",
          entity,
          durability,
        });
      }
    }
  }

  function detectExpandingBlastRadius(
    signals: SessionDegradationSignal[],
  ): void {
    if (blastRadiusHistory.length < 2) return;

    const sorted = [...blastRadiusHistory].sort(
      (a, b) => a.timestamp - b.timestamp,
    );

    const firstThird = sorted.slice(
      0,
      Math.max(1, Math.floor(sorted.length / 3)),
    );
    const lastThird = sorted.slice(
      Math.max(0, sorted.length - Math.floor(sorted.length / 3)),
    );

    const initialAvg =
      firstThird.reduce((sum, r) => sum + r.radius, 0) / firstThird.length;
    const currentAvg =
      lastThird.reduce((sum, r) => sum + r.radius, 0) / lastThird.length;

    if (currentAvg > initialAvg * 1.5 && currentAvg > 5) {
      signals.push({
        type: "expanding_blast_radius",
        initial: Math.round(initialAvg),
        current: Math.round(currentAvg),
      });
    }
  }

  function detectConventionViolationSpike(
    signals: SessionDegradationSignal[],
    now: number,
  ): void {
    const windowStart = now - VIOLATION_WINDOW_MS;
    const recentViolations = conventionViolations.filter(
      (ts) => ts >= windowStart,
    );

    if (recentViolations.length >= VIOLATION_SPIKE_THRESHOLD) {
      signals.push({
        type: "convention_violation_spike",
        count: recentViolations.length,
        window_min: VIOLATION_WINDOW_MS / 60_000,
      });
    }
  }

  function detectToolCallAcceleration(
    signals: SessionDegradationSignal[],
    now: number,
  ): void {
    const oneMinuteAgo = now - 60_000;
    const recentCalls = toolCalls.filter((tc) => tc.timestamp >= oneMinuteAgo);

    if (recentCalls.length >= TOOL_CALL_RATE_THRESHOLD) {
      signals.push({
        type: "tool_call_acceleration",
        rate_per_min: recentCalls.length,
      });
    }
  }

  function detectContextDepthWarning(
    signals: SessionDegradationSignal[],
  ): void {
    const estimatedTokens = toolCalls.length * TOKENS_PER_TOOL_CALL;

    if (estimatedTokens >= CONTEXT_TOKEN_WARNING) {
      signals.push({
        type: "context_depth_warning",
        estimated_tokens: estimatedTokens,
      });
    }
  }

  function pruneOldRecords(now: number): void {
    const sessionWindow = 60 * 60 * 1000;
    const cutoff = now - sessionWindow;

    toolCalls = toolCalls.filter((tc) => tc.timestamp >= cutoff);
    conventionViolations = conventionViolations.filter((ts) => ts >= cutoff);
    blastRadiusHistory = blastRadiusHistory.filter(
      (br) => br.timestamp >= cutoff,
    );
  }

  return {
    recordToolCall,
    recordConventionViolation,
    recordBlastRadius,
    recordDurability,
    getHealth,
    reset,
  };
}

function computeHealthScore(signals: SessionDegradationSignal[]): number {
  let health = 1.0;

  const signalsByType = new Map<SessionDegradationSignal["type"], number>();
  for (const signal of signals) {
    const count = signalsByType.get(signal.type) ?? 0;
    signalsByType.set(signal.type, count + 1);
  }

  for (const [type, count] of signalsByType) {
    const weight = SIGNAL_WEIGHTS[type];
    const scaledPenalty = weight * Math.min(count, 3);
    health -= scaledPenalty;

    if (type === "context_depth_warning") {
      const contextSignal = signals.find(
        (s) => s.type === "context_depth_warning",
      ) as
        | { type: "context_depth_warning"; estimated_tokens: number }
        | undefined;
      if (
        contextSignal &&
        contextSignal.estimated_tokens >= CONTEXT_TOKEN_CRITICAL
      ) {
        health -= 0.15;
      }
    }
  }

  return Math.round(Math.max(0, Math.min(1, health)) * 100) / 100;
}

function deriveRecommendation(
  health: number,
  signals: SessionDegradationSignal[],
): SessionHealthSignal["recommendation"] {
  if (health >= 0.8) return "continue";

  const hasContextWarning = signals.some(
    (s) => s.type === "context_depth_warning",
  );
  const hasRepeatedQueries = signals.some((s) => s.type === "repeated_query");

  if (health < 0.3) return "suggest_new_session";

  if (hasContextWarning && health < 0.6) return "inject_context_refresh";

  if (hasRepeatedQueries && health < 0.6) return "suggest_pause";

  if (health < 0.5) return "suggest_pause";

  return "inject_context_refresh";
}
