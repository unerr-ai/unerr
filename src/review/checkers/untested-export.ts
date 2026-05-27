/**
 * `untested_export` checker (docs/reviewer-architecture.md §3 Tier 1 #9, §11 P0.4).
 *
 * A changed/added entity that production code depends on (≥1 non-test caller) but
 * no test exercises (0 test-file callers). Stays narrow to keep the false-positive
 * rate near zero (§9): an entity with zero callers is dead-code territory (P0.5),
 * not "untested" — so this fires only on the used-but-uncovered case, where the
 * evidence (the prod callers) is concrete. Uses only `getCallersOf` + the shared
 * test-path classifier; no extra graph surface.
 */

import { isTestFilePath } from "../../intelligence/edit-impact.js";
import type { ReviewChecker } from "../checker.js";
import type { ReviewContext, ReviewFinding, Severity } from "../types.js";
import { callerEvidence, resolveChangedEntity } from "./shared.js";

/** Entity kinds worth covering with a test. Skip variables/types/imports. */
const COVERABLE_KINDS = new Set(["function", "method", "class"]);

export class UntestedExportChecker implements ReviewChecker {
  readonly id = "untested_export";
  readonly tier = 1 as const;
  readonly defaultSeverity: Severity = "medium";

  async check(ctx: ReviewContext): Promise<ReviewFinding[]> {
    const findings: ReviewFinding[] = [];

    for (const change of ctx.changeSet.entities) {
      if (change.kind === "deleted") continue;

      const entity = await resolveChangedEntity(ctx.graph, change);
      if (!entity) continue;
      if (!COVERABLE_KINDS.has(entity.kind)) continue;

      const callers = await ctx.graph.getCallersOf(entity.key);
      const testCallers = callers.filter((c) => isTestFilePath(c.file_path));
      if (testCallers.length > 0) continue; // already covered

      const nonTestCallers = callers.filter(
        (c) => !isTestFilePath(c.file_path)
      );
      if (nonTestCallers.length === 0) continue; // unused → dead-code, not untested

      findings.push({
        checkerId: this.id,
        tier: 1,
        severity: "medium",
        anchor: { kind: "e", value: entity.key, line: entity.start_line },
        title: `${entity.name} has ${nonTestCallers.length} non-test caller(s) and no test coverage`,
        evidence: [
          ...callerEvidence(nonTestCallers, entity.name, 3),
          "0 test-file callers",
        ],
        action: `add a test that calls ${entity.name}; call get_test_coverage({key:'${entity.key}'}) to confirm the new edge is recorded`,
        needsModel: false,
      });
    }

    return findings;
  }
}
