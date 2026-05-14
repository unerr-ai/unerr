/**
 * Centrality Computation — fan-in/fan-out counts + hub node detection.
 *
 * Post-processing pass over resolved edges to compute:
 *   - fan_in: how many entities call this entity
 *   - fan_out: how many entities this entity calls
 *   - risk_level: "critical" (50+), "high" (20+), "medium" (10+), "normal"
 *
 * Hub nodes (high fan_in) are the chokepoints of the codebase — changes
 * to them have the widest blast radius.
 */

import type { IndexedEdge, IndexedEntity } from "./plugin-interface.js";

export interface CentralityResult {
  fanIn: Map<string, number>;
  fanOut: Map<string, number>;
  hubNodes: string[];
}

const RISK_THRESHOLDS = {
  critical: 50,
  high: 20,
  medium: 10,
} as const;

/**
 * Compute fan-in and fan-out for all entities from resolved edges.
 */
export function computeCentrality(edges: IndexedEdge[]): CentralityResult {
  const fanIn = new Map<string, number>();
  const fanOut = new Map<string, number>();

  const callEdges = edges.filter((e) => e.type === "calls");

  for (const edge of callEdges) {
    fanOut.set(edge.from_key, (fanOut.get(edge.from_key) ?? 0) + 1);
    fanIn.set(edge.to_key, (fanIn.get(edge.to_key) ?? 0) + 1);
  }

  const hubNodes = [...fanIn.entries()]
    .filter(([_, count]) => count >= RISK_THRESHOLDS.high)
    .sort((a, b) => b[1] - a[1])
    .map(([key]) => key);

  return { fanIn, fanOut, hubNodes };
}

/**
 * Determine risk level from fan_in count.
 */
export function riskLevel(
  fanInCount: number,
): "critical" | "high" | "medium" | "normal" {
  if (fanInCount >= RISK_THRESHOLDS.critical) return "critical";
  if (fanInCount >= RISK_THRESHOLDS.high) return "high";
  if (fanInCount >= RISK_THRESHOLDS.medium) return "medium";
  return "normal";
}

/**
 * Apply centrality metrics to entities.
 * Returns updated entities with fan_in, fan_out, and risk_level set.
 */
export function applyCentrality(
  entities: IndexedEntity[],
  edges: IndexedEdge[],
): IndexedEntity[] {
  const { fanIn, fanOut } = computeCentrality(edges);

  return entities.map((entity) => {
    const fi = fanIn.get(entity.key) ?? 0;
    const fo = fanOut.get(entity.key) ?? 0;
    return {
      ...entity,
      fan_in: fi,
      fan_out: fo,
      risk_level: riskLevel(fi),
    } as IndexedEntity & {
      fan_in: number;
      fan_out: number;
      risk_level: string;
    };
  });
}
