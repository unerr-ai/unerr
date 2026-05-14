/**
 * Multi-Factor Risk Classifier — computes entity risk from 4 factors:
 *   1. Fan-in (centrality): how many callers depend on this entity
 *   2. Bridge score: does this entity connect two communities?
 *   3. Mutation score: does it write to shared state?
 *   4. Guard score: is it protected by try/catch or similar?
 *
 * Output: "critical" | "high" | "medium" | "low" with numeric score (0-100).
 *
 * Note (Issue #5): The legacy enum used "normal" for the bottom rung; the
 * health-map and other consumers use "low". We canonicalize on "low" here
 * and provide `normalizeRiskLevel()` to translate stale "normal" values from
 * existing graph data. Both names are accepted in `isRiskLevel()` to keep
 * older snapshots working until they're re-indexed.
 */

import type { IndexedEdge } from "./indexer/plugin-interface.js";

export type RiskLevel = "critical" | "high" | "medium" | "low";

/** Translate a possibly-stale risk_level string to the canonical enum.
 * Old snapshots used "normal" for the bottom rung; map it to "low". */
export function normalizeRiskLevel(
  value: string | null | undefined,
): RiskLevel {
  if (value === "critical" || value === "high" || value === "medium") {
    return value;
  }
  // "normal" (legacy) and any unknown / null fall through to "low".
  return "low";
}

export interface RiskAssessment {
  entityKey: string;
  level: RiskLevel;
  score: number;
  factors: {
    fanIn: number;
    bridgeScore: number;
    mutationScore: number;
    guardScore: number;
  };
  reasoning: string;
}

const WEIGHTS = {
  fanIn: 0.4,
  bridge: 0.25,
  mutation: 0.2,
  guard: 0.15,
} as const;

const THRESHOLDS = {
  critical: 35,
  high: 22,
  medium: 10,
} as const;

/**
 * Classify risk for a single entity.
 */
export function classifyRisk(
  entityKey: string,
  fanIn: number,
  isBridge: boolean,
  hasMutations: boolean,
  isGuarded: boolean,
): RiskAssessment {
  const fanInScore = Math.min(100, fanIn * 2);
  const bridgeScore = isBridge ? 80 : 0;
  const mutationScore = hasMutations ? 60 : 0;
  const guardScore = isGuarded ? -20 : 0;

  const rawScore =
    WEIGHTS.fanIn * fanInScore +
    WEIGHTS.bridge * bridgeScore +
    WEIGHTS.mutation * mutationScore +
    WEIGHTS.guard * Math.abs(guardScore);

  const score = Math.max(
    0,
    Math.min(100, Math.round(rawScore + guardScore * WEIGHTS.guard)),
  );

  const level: RiskLevel =
    score >= THRESHOLDS.critical
      ? "critical"
      : score >= THRESHOLDS.high
        ? "high"
        : score >= THRESHOLDS.medium
          ? "medium"
          : "low";

  const reasons: string[] = [];
  if (fanIn >= 50) reasons.push(`${fanIn} callers (chokepoint)`);
  else if (fanIn >= 20) reasons.push(`${fanIn} callers (high traffic)`);
  if (isBridge) reasons.push("bridges 2+ communities");
  if (hasMutations) reasons.push("mutates shared state");
  if (isGuarded) reasons.push("protected by error handling");

  return {
    entityKey,
    level,
    score,
    factors: {
      fanIn: fanInScore,
      bridgeScore,
      mutationScore,
      guardScore,
    },
    reasoning:
      reasons.length > 0
        ? reasons.join("; ")
        : "low risk (no significant factors)",
  };
}

/**
 * Detect bridge entities (entities that connect two communities).
 */
export function detectBridges(
  entityKey: string,
  edges: IndexedEdge[],
  communityAssignments: Map<string, number>,
): boolean {
  const myCommunity = communityAssignments.get(entityKey);
  if (myCommunity === undefined) return false;

  const connectedCommunities = new Set<number>();
  for (const edge of edges) {
    if (edge.from_key === entityKey) {
      const targetCommunity = communityAssignments.get(edge.to_key);
      if (targetCommunity !== undefined)
        connectedCommunities.add(targetCommunity);
    }
    if (edge.to_key === entityKey) {
      const sourceCommunity = communityAssignments.get(edge.from_key);
      if (sourceCommunity !== undefined)
        connectedCommunities.add(sourceCommunity);
    }
  }

  connectedCommunities.delete(myCommunity);
  return connectedCommunities.size >= 1;
}

/**
 * Batch classify risk for all entities.
 */
export function classifyAllRisks(
  entities: Array<{ key: string }>,
  fanInMap: Map<string, number>,
  edges: IndexedEdge[],
  communityAssignments: Map<string, number>,
  mutationEntities: Set<string>,
  guardedEntities: Set<string>,
): RiskAssessment[] {
  return entities.map((entity) => {
    const fanIn = fanInMap.get(entity.key) ?? 0;
    const isBridge = detectBridges(entity.key, edges, communityAssignments);
    const hasMutations = mutationEntities.has(entity.key);
    const isGuarded = guardedEntities.has(entity.key);
    return classifyRisk(entity.key, fanIn, isBridge, hasMutations, isGuarded);
  });
}
