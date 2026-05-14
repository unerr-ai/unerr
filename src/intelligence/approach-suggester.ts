/**
 * Approach Suggestion Engine — suggests safer modification patterns for high-risk entities.
 *
 * S.4: When entity risk exceeds threshold, proactively suggests alternative approaches
 * that are less likely to break downstream callers.
 */

export interface ApproachSuggestion {
  entityKey: string;
  entityName: string;
  riskLevel: string;
  fanIn: number;
  suggestion: string;
  pattern: string;
  rationale: string;
}

const FAN_IN_HIGH = 30;
const FAN_IN_CRITICAL = 50;

/**
 * Generate approach suggestions for an entity based on its risk profile.
 */
export function suggestApproach(
  entityKey: string,
  entityName: string,
  riskLevel: string,
  fanIn: number,
  kind: string,
): ApproachSuggestion | null {
  if (fanIn < FAN_IN_HIGH && riskLevel === "normal") return null;

  if (fanIn >= FAN_IN_CRITICAL) {
    return {
      entityKey,
      entityName,
      riskLevel,
      fanIn,
      suggestion: `${fanIn} callers depend on ${entityName}. Prefer overload/adapter pattern over signature change.`,
      pattern: "overload-adapter",
      rationale: `Modifying this entity directly affects ${fanIn} callers. Adding an overload preserves backward compatibility while extending functionality.`,
    };
  }

  if (fanIn >= FAN_IN_HIGH) {
    return {
      entityKey,
      entityName,
      riskLevel,
      fanIn,
      suggestion: `${entityName} has ${fanIn} callers. Consider feature flag or interface extraction.`,
      pattern: "feature-flag",
      rationale:
        "High fan-in means changes have wide blast radius. Feature flags allow gradual rollout.",
    };
  }

  if (riskLevel === "critical" || riskLevel === "high") {
    return {
      entityKey,
      entityName,
      riskLevel,
      fanIn,
      suggestion: `${entityName} is ${riskLevel}-risk. Add tests before modifying.`,
      pattern: "test-first",
      rationale:
        "Entities with elevated risk should have comprehensive test coverage before modification.",
    };
  }

  return null;
}

/**
 * Generate suggestions for all high-risk entities in a file.
 */
export function suggestApproachesForFile(
  entities: Array<{
    key: string;
    name: string;
    risk_level?: string;
    fan_in?: number;
    kind: string;
  }>,
): ApproachSuggestion[] {
  const suggestions: ApproachSuggestion[] = [];
  for (const entity of entities) {
    const suggestion = suggestApproach(
      entity.key,
      entity.name,
      entity.risk_level ?? "normal",
      entity.fan_in ?? 0,
      entity.kind,
    );
    if (suggestion) suggestions.push(suggestion);
  }
  return suggestions;
}
