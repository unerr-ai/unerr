/**
 * Auto-Rule Generation — promotes high-confidence corrections into enforced rules.
 *
 * U.6: When a correction has 3+ occurrences and confidence > 0.9,
 * it graduates from "correction" to "rule" — proactively injected
 * to prevent the same mistake in future sessions.
 */

export interface GeneratedRule {
  id: string;
  entityKey: string;
  scope: string;
  severity: "warn" | "error";
  message: string;
  source: "correction-auto";
  confidence: number;
  occurrences: number;
  createdAt: string;
}

export interface CorrectionCandidate {
  entityKey: string;
  pattern: string;
  description: string;
  occurrences: number;
  confidence: number;
}

const PROMOTION_THRESHOLD_CONFIDENCE = 0.9;
const PROMOTION_THRESHOLD_OCCURRENCES = 3;

/**
 * Evaluate corrections for rule promotion.
 * Returns rules that should be auto-generated.
 */
export function evaluateForPromotion(
  corrections: CorrectionCandidate[]
): GeneratedRule[] {
  const rules: GeneratedRule[] = [];

  for (const correction of corrections) {
    if (
      correction.confidence >= PROMOTION_THRESHOLD_CONFIDENCE &&
      correction.occurrences >= PROMOTION_THRESHOLD_OCCURRENCES
    ) {
      rules.push({
        id: `auto-rule:${correction.entityKey}:${correction.pattern}`,
        entityKey: correction.entityKey,
        scope: extractScope(correction.entityKey),
        severity: "warn",
        message: correction.description,
        source: "correction-auto",
        confidence: correction.confidence,
        occurrences: correction.occurrences,
        createdAt: new Date().toISOString(),
      });
    }
  }

  return rules;
}

/**
 * Check if a specific correction should be promoted.
 */
export function shouldPromote(correction: CorrectionCandidate): boolean {
  return (
    correction.confidence >= PROMOTION_THRESHOLD_CONFIDENCE &&
    correction.occurrences >= PROMOTION_THRESHOLD_OCCURRENCES
  );
}

function extractScope(entityKey: string): string {
  if (entityKey.includes("::")) return entityKey.split("::")[0] ?? entityKey;
  if (entityKey.includes("/")) {
    const parts = entityKey.split("/");
    return parts.slice(0, -1).join("/");
  }
  return entityKey;
}
