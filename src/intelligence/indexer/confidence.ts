/**
 * Confidence Labeling — tracks provenance of extracted entities and edges.
 *
 * Confidence levels:
 *   - "compiler-verified": From SCIP (compiler-resolved, highest accuracy)
 *   - "structural": From tree-sitter AST (syntactic structure, high accuracy)
 *   - "heuristic": From regex fallback or heuristic rules (lower accuracy)
 *
 * Every entity and edge carries a confidence label that downstream
 * consumers can use to weight results.
 */

export type ConfidenceLevel = "compiler-verified" | "structural" | "heuristic";

export interface ConfidenceLabel {
  level: ConfidenceLevel;
  source: string;
}

export function labelFromTier(tier: 1 | 2 | 3): ConfidenceLabel {
  switch (tier) {
    case 1:
      return { level: "structural", source: "tree-sitter-tier1" };
    case 2:
      return { level: "structural", source: "tree-sitter-tier2" };
    case 3:
      return { level: "heuristic", source: "regex-fallback" };
  }
}

export function upgradeToCompilerVerified(
  label: ConfidenceLabel
): ConfidenceLabel {
  return { level: "compiler-verified", source: `scip+${label.source}` };
}

export function confidenceScore(level: ConfidenceLevel): number {
  switch (level) {
    case "compiler-verified":
      return 1.0;
    case "structural":
      return 0.85;
    case "heuristic":
      return 0.5;
  }
}
