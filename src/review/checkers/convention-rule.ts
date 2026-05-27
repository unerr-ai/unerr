/**
 * `convention_rule` checker (docs/reviewer-architecture.md §3 Tier 1 #7, §11 P0.4).
 *
 * Wraps `intelligence/rule-evaluator.ts:evaluateRules` (already wired into
 * `check-commit`) — a change that violates a *project rule the team wrote*, not a
 * syntax rule lint already enforces. The narrow `ReviewRules` surface lets
 * production close over the real rule store + `CozoGraphStore` while tests pass a
 * fake. Absent rule store → silent (no rules to check against).
 */

import type { ReviewChecker } from "../checker.js";
import type {
  ReviewContext,
  ReviewFinding,
  ReviewRuleViolation,
  Severity,
} from "../types.js";

/** Map a rule's own severity string onto the review severity scale. */
function mapSeverity(ruleSeverity: string): Severity {
  switch (ruleSeverity.toLowerCase()) {
    case "error":
    case "critical":
      return "high";
    case "warn":
    case "warning":
      return "medium";
    case "info":
    case "hint":
      return "low";
    default:
      return "medium";
  }
}

export class ConventionRuleChecker implements ReviewChecker {
  readonly id = "convention_rule";
  readonly tier = 1 as const;
  readonly defaultSeverity: Severity = "medium";

  async check(ctx: ReviewContext): Promise<ReviewFinding[]> {
    const rules = ctx.rules;
    if (!rules) return []; // no rule store wired for this pass

    const findings: ReviewFinding[] = [];

    for (const file of ctx.changeSet.files) {
      if (file.kind === "deleted" || !file.newContent) continue;

      // First changed entity in this file seeds JIT rule filtering.
      const entityKey = ctx.changeSet.entities.find(
        (e) => e.filePath === file.path
      )?.entityKey;

      const violations: ReviewRuleViolation[] = await rules.violationsForFile(
        file.path,
        file.newContent,
        entityKey
      );

      for (const v of violations) {
        findings.push({
          checkerId: this.id,
          tier: 1,
          severity: mapSeverity(v.severity),
          anchor: { kind: "f", value: v.filePath, line: v.line },
          title: `${v.filePath}${v.line ? `:${v.line}` : ""} violates project rule "${v.ruleName}"`,
          evidence: v.matchedCode ? [v.message, v.matchedCode] : [v.message],
          action: `edit ${v.filePath}${v.line ? `:${v.line}` : ""} to satisfy rule "${v.ruleName}" (${v.ruleKey})`,
          needsModel: false,
        });
      }
    }

    return findings;
  }
}
