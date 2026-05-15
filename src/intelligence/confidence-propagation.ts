/**
 * Confidence Propagation — MIN across traversed edges, edge source counts.
 *
 * When traversing the graph (e.g., blast radius), the confidence of the
 * result is the MINIMUM confidence of any edge in the traversal path.
 * One heuristic edge makes the whole path heuristic.
 */

import type { ConfidenceLevel } from "./indexer/confidence.js";

export interface PropagatedConfidence {
  level: ConfidenceLevel;
  edgeSources: Record<string, number>;
  pathLength: number;
}

const CONFIDENCE_ORDER: Record<ConfidenceLevel, number> = {
  "compiler-verified": 3,
  structural: 2,
  heuristic: 1,
};

/**
 * Propagate confidence across a path of edges.
 * Result confidence = MIN of all edge confidences in the path.
 */
export function propagateConfidence(
  edgeConfidences: ConfidenceLevel[]
): PropagatedConfidence {
  if (edgeConfidences.length === 0) {
    return { level: "structural", edgeSources: {}, pathLength: 0 };
  }

  let minLevel: ConfidenceLevel = "compiler-verified";
  const sources: Record<string, number> = {};

  for (const conf of edgeConfidences) {
    sources[conf] = (sources[conf] ?? 0) + 1;
    if (CONFIDENCE_ORDER[conf] < CONFIDENCE_ORDER[minLevel]) {
      minLevel = conf;
    }
  }

  return {
    level: minLevel,
    edgeSources: sources,
    pathLength: edgeConfidences.length,
  };
}

/**
 * Get the numeric confidence score for a propagated result.
 */
export function confidenceToScore(level: ConfidenceLevel): number {
  switch (level) {
    case "compiler-verified":
      return 1.0;
    case "structural":
      return 0.85;
    case "heuristic":
      return 0.5;
  }
}
